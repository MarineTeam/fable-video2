import crypto from 'crypto';
import { redis, k } from './redis';
import { getVideo } from './bunny';
import { mailEnabled, sendShareEmail } from './mail';
import { clampWatermarkMode } from './watermark';

export const DEFAULT_HOURS = 72;
export const MAX_HOURS = 720; // 30 days

// How much longer a share record survives in Redis *past* its logical
// expiresAt before it is really gone. Expiry access-control is decided by
// comparing `expiresAt` to now (see isShareActive) — Redis's own TTL is just
// a cleanup horizon, generous enough that an admin can still "Extend" a
// lapsed-but-not-revoked link days or weeks later (the realistic use case).
// Without this grace window, Redis would hard-delete the record the moment
// it expires and there would be nothing left to extend.
export const GRACE_SECONDS = 60 * 24 * 3600; // 60 days

export function clampHours(hours) {
  return Math.min(Math.max(parseInt(hours, 10) || DEFAULT_HOURS, 1), MAX_HOURS);
}

export function baseUrl(req) {
  const fromEnv = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  if (fromEnv) return fromEnv;
  return `https://${req.headers.host}`;
}

// Seconds a Redis key holding `expiresAt` should live: time remaining until
// that logical expiry, plus the grace window. Never less than 1s.
export function ttlSecondsFor(expiresAt, now = Date.now()) {
  const remainingMs = Date.parse(expiresAt) - now;
  return Math.max(1, Math.ceil(remainingMs / 1000)) + GRACE_SECONDS;
}

// A share is usable only while neither revoked nor past its logical expiry.
// A record can be non-null yet unusable during its post-expiry grace window
// (see GRACE_SECONDS) — callers that gate recipient access must use this,
// not "does the record exist".
export function isShareActive(share, now = Date.now()) {
  if (!share) return false;
  if (share.revokedAt) return false;
  return Date.parse(share.expiresAt) > now;
}

export function shareStatus(share, now = Date.now()) {
  if (!share) return 'gone';
  if (share.revokedAt) return 'revoked';
  return Date.parse(share.expiresAt) > now ? 'active' : 'expired';
}

// One private, independently-revocable link per (videoId, email) pair.
// `watermark` ('always'/'never') is stored only when explicitly chosen — a
// share left at 'default' has no watermark field at all, so it falls
// through to the video's own setting and then the global default (see
// lib/watermark.js resolveWatermark).
export async function createShare({ videoId, email, hours, watermark }) {
  const id = crypto.randomBytes(18).toString('base64url');
  const now = new Date();
  const ttlHours = clampHours(hours);
  const expiresAt = new Date(now.getTime() + ttlHours * 3600 * 1000).toISOString();
  const mode = clampWatermarkMode(watermark);
  const share = {
    videoId,
    email,
    createdAt: now.toISOString(),
    expiresAt,
    ...(mode !== 'default' ? { watermark: mode } : {}),
  };
  const r = redis();
  await r.set(shareKey(id), share, { ex: ttlSecondsFor(expiresAt) });
  await r.sadd(k('shares'), id);
  return { id, share };
}

export function shareKey(id) {
  return k(`share:${id}`);
}

export async function loadShare(id) {
  const share = await redis().get(shareKey(id)).catch(() => null);
  return share ? { id, ...share } : null;
}

// Batch load: a single MGET instead of one GET per id. This is the whole
// difference between an admin Shares list (or a share-creation dedup scan)
// costing O(1) Redis commands versus O(share count) — at 1,000 shares that's
// 1 command instead of 1,000. Order-preserving; a missing/expired-past-grace
// key comes back null in its slot so callers can still tell which id was gone.
export async function loadShares(ids) {
  if (!ids || ids.length === 0) return [];
  let values;
  try {
    values = await redis().mget(...ids.map(shareKey));
  } catch {
    return ids.map(() => null);
  }
  return ids.map((id, i) => (values[i] ? { id, ...values[i] } : null));
}

// Soft-delete: mark revoked rather than DEL, so a revoked link stays visible
// (and distinguishable from a merely-expired one) in the admin list, and so
// "extend" has a definite state to refuse. Never removed from the `shares`
// index here — that index is pruned only once the Redis record itself is
// finally gone (see pages/api/admin/shares.js). The TTL is recomputed via
// ttlSecondsFor rather than read back from Redis with a TTL command —
// ttlSecondsFor(share.expiresAt) is exactly what that read would return
// (both are the same deterministic function of expiresAt + GRACE_SECONDS),
// so re-deriving it saves a whole Redis round-trip for free.
export async function revokeShare(id) {
  const key = shareKey(id);
  const r = redis();
  const share = await r.get(key).catch(() => null);
  if (!share) return { ok: false, error: 'Link does not exist' };
  if (share.revokedAt) return { ok: true, alreadyRevoked: true };
  const patch = { ...share, revokedAt: new Date().toISOString() };
  await r.set(key, patch, { ex: ttlSecondsFor(share.expiresAt) });
  return { ok: true };
}

// Reverse a revoke: clears revokedAt and restores exactly the expiresAt the
// link had before it was revoked (revoking never touched expiresAt). Refuses
// if the link was never revoked (nothing to undo) or is gone. Kept as a
// distinct, deliberate action from both Extend and Bulk Revoke — undoing an
// accidental revoke should never be a side effect of another action.
export async function unrevokeShare(id) {
  const key = shareKey(id);
  const r = redis();
  const share = await r.get(key).catch(() => null);
  if (!share) return { ok: false, error: 'Link does not exist' };
  if (!share.revokedAt) return { ok: false, error: 'Link was not revoked' };
  const { revokedAt, ...restored } = share;
  await r.set(key, restored, { ex: ttlSecondsFor(restored.expiresAt) });
  return { ok: true, share: restored };
}

// Hard delete: only ever permitted once a link has already been soft-revoked
// (revokeShare), so the irreversible step is always a deliberate second act
// on top of the reversible one, never a shortcut around it.
export async function purgeShare(id) {
  const key = shareKey(id);
  const r = redis();
  const share = await r.get(key).catch(() => null);
  if (!share) return { ok: false, error: 'Link does not exist' };
  if (!share.revokedAt) return { ok: false, error: 'Only a revoked link can be permanently deleted' };
  await r.del(key);
  await r.srem(k('shares'), id);
  return { ok: true };
}

// Extend from now (not from the stale old expiry) — "it lapsed, give me a
// few more days" is the realistic use case. Refuses outright on a revoked
// item: extend must never double as a silent un-revoke. Works whether the
// item is still active or already past its logical expiry, as long as its
// record still exists (i.e. within the grace window).
export async function extendShare(id, hours) {
  const key = shareKey(id);
  const r = redis();
  const share = await r.get(key).catch(() => null);
  if (!share) return { ok: false, error: 'Link does not exist' };
  if (share.revokedAt) return { ok: false, error: 'Link was revoked' };
  const ttlHours = clampHours(hours);
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
  const patch = { ...share, expiresAt };
  await r.set(key, patch, { ex: ttlSecondsFor(expiresAt) });
  return { ok: true, expiresAt, share: patch };
}

// Re-deliver an existing link's own email to its original recipient.
// Refuses on a revoked or expired link — nothing to resend.
export async function resendShareEmail(id, url) {
  const share = await loadShare(id);
  if (!share) return { ok: false, error: 'Link does not exist' };
  if (!isShareActive(share)) return { ok: false, error: 'Link is revoked or expired' };
  if (!mailEnabled()) return { ok: false, error: 'Email is not configured' };
  let videoTitle = '';
  try {
    videoTitle = (await getVideo(share.videoId))?.title || '';
  } catch {}
  const result = await sendShareEmail({
    to: share.email,
    url: `${url}/s/${id}`,
    videoTitle,
    expiresAt: share.expiresAt,
  });
  return { ok: Boolean(result.ok) };
}

// ---------------------------------------------------------------------------
// Bulk variants. Each starts with one loadShares() MGET instead of one GET
// per id — the fetch/validate side is always O(1) Redis commands regardless
// of how many ids were selected. The write side stays O(K) SETs for
// revoke/unrevoke/extend because every affected share gets a distinct patch
// (its own revokedAt, or its own new expiresAt) and Redis has no multi-key
// SET-with-per-key-TTL primitive — that's a hard floor, not something left
// on the table. Purge is the one action where every write is IDENTICAL
// (delete the key, drop it from the index), so it collapses all the way to
// one multi-key DEL plus one multi-member SREM, however many ids are purged.
// ---------------------------------------------------------------------------

// Every id is processed independently — a Redis error on one id's write
// (the one part that can't be batched away, see note above) is caught
// per-id so it never aborts the rest of the selection, matching the
// single-item actions' own resilience.
export async function revokeShares(ids) {
  const shares = await loadShares(ids);
  const r = redis();
  return Promise.all(
    shares.map(async (share, i) => {
      const id = ids[i];
      try {
        if (!share) return { id, ok: false, error: 'Link does not exist' };
        if (share.revokedAt) return { id, ok: true, alreadyRevoked: true };
        const patch = { ...share, revokedAt: new Date().toISOString() };
        await r.set(shareKey(id), patch, { ex: ttlSecondsFor(share.expiresAt) });
        return { id, ok: true };
      } catch (err) {
        return { id, ok: false, error: err?.message || 'Failed' };
      }
    })
  );
}

export async function unrevokeShares(ids) {
  const shares = await loadShares(ids);
  const r = redis();
  return Promise.all(
    shares.map(async (share, i) => {
      const id = ids[i];
      try {
        if (!share) return { id, ok: false, error: 'Link does not exist' };
        if (!share.revokedAt) return { id, ok: false, error: 'Link was not revoked' };
        const { revokedAt, ...restored } = share;
        await r.set(shareKey(id), restored, { ex: ttlSecondsFor(restored.expiresAt) });
        return { id, ok: true, expiresAt: restored.expiresAt };
      } catch (err) {
        return { id, ok: false, error: err?.message || 'Failed' };
      }
    })
  );
}

// Pure eligibility rule, kept separate from Redis so it's unit-testable on
// its own: only a share that exists AND is already revoked may be purged.
// Returns a per-id result list (in input order) plus the subset of ids that
// actually qualify for the real DEL/SREM.
export function planPurge(ids, shares) {
  const results = [];
  const eligibleIds = [];
  ids.forEach((id, i) => {
    const share = shares[i];
    if (!share) {
      results.push({ id, ok: false, error: 'Link does not exist' });
    } else if (!share.revokedAt) {
      results.push({ id, ok: false, error: 'Only a revoked link can be permanently deleted' });
    } else {
      eligibleIds.push(id);
      results.push({ id, ok: true });
    }
  });
  return { results, eligibleIds };
}

export async function purgeShares(ids) {
  const shares = await loadShares(ids);
  const { results, eligibleIds } = planPurge(ids, shares);
  if (eligibleIds.length > 0) {
    try {
      const r = redis();
      await r.del(...eligibleIds.map(shareKey));
      await r.srem(k('shares'), ...eligibleIds);
    } catch (err) {
      // The batched DEL/SREM covers every eligible id atomically — if it
      // fails, it fails for all of them together, so report each as failed
      // individually rather than throwing away the whole result list (the
      // per-id ineligibility results computed above are still valid).
      const failed = new Set(eligibleIds);
      const message = err?.message || 'Failed';
      return results.map((res) => (failed.has(res.id) ? { id: res.id, ok: false, error: message } : res));
    }
  }
  return results;
}

// Bulk resend: one MGET instead of one GET per id, and each video's title is
// looked up once per unique videoId (Bunny API, not Redis) instead of once
// per share — the same de-dup idiom already used for the Shares list.
export async function resendShareEmails(ids, url) {
  const shares = await loadShares(ids);
  const uniqueVideoIds = [...new Set(shares.filter(Boolean).map((s) => s.videoId))];
  const titles = {};
  await Promise.all(
    uniqueVideoIds.map(async (videoId) => {
      try {
        titles[videoId] = (await getVideo(videoId))?.title || '';
      } catch {
        titles[videoId] = '';
      }
    })
  );
  return Promise.all(
    shares.map(async (share, i) => {
      const id = ids[i];
      try {
        if (!share) return { id, ok: false, error: 'Link does not exist' };
        if (!isShareActive(share)) return { id, ok: false, error: 'Link is revoked or expired' };
        if (!mailEnabled()) return { id, ok: false, error: 'Email is not configured' };
        const result = await sendShareEmail({
          to: share.email,
          url: `${url}/s/${id}`,
          videoTitle: titles[share.videoId],
          expiresAt: share.expiresAt,
        });
        return { id, ok: Boolean(result.ok) };
      } catch (err) {
        return { id, ok: false, error: err?.message || 'Failed' };
      }
    })
  );
}
