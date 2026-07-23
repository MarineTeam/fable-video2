import crypto from 'crypto';
import { redis, k } from './redis';
import { normalizeEmail } from './auth';
import { getVideo } from './bunny';
import { mailEnabled, sendShareEmail, sendBundleShareEmail } from './mail';
import { extendShare, isShareActive, ttlSecondsFor, shareKey, loadShares, clampHours } from './share';

// A "bundle" is a pure grouping list — ids + email + expiry — never a second
// source of truth for any item's title/status. Every read (the bundle page,
// the notification email) re-fetches each item's own share:<id> record live,
// so revoking or expiring one item is reflected instantly without touching
// the bundle record itself. See liveBundleItems.

export async function loadBundle(id) {
  const bundle = await redis().get(k(`bundle:${id}`)).catch(() => null);
  return bundle ? { id, ...bundle } : null;
}

// "If it's the same email, it should be in the same place" — the one active
// bundle for a recipient, looked up by email rather than by action.
export async function findActiveBundle(email) {
  const norm = normalizeEmail(email);
  const id = await redis().get(k(`bundle-by-email:${norm}`)).catch(() => null);
  if (!id) return null;
  const bundle = await loadBundle(id);
  if (!bundle || Date.parse(bundle.expiresAt) <= Date.now()) return null;
  return bundle;
}

// Every currently-active (not revoked, not expired) share addressed to this
// email. Used both to decide whether a bundle should exist and to sweep in
// pre-existing, not-yet-bundled shares the first time one is created. This
// runs on every single share creation, so it has to stay cheap even with
// thousands of shares in play: one SMEMBERS plus one MGET, never one GET per
// share in the whole index.
export async function activeSharesForEmail(email, excludeIds = []) {
  const norm = normalizeEmail(email);
  const exclude = new Set(excludeIds);
  const ids = ((await redis().smembers(k('shares'))) || []).filter((id) => !exclude.has(id));
  const shares = await loadShares(ids);
  return shares.filter((share) => share && normalizeEmail(share.email) === norm && isShareActive(share));
}

// Tag many shares with the same bundleId in one MGET + N SETs (one SET per
// id is unavoidable — each share's patched JSON differs by its own other
// fields — but the fetch side collapses from N GETs to 1, and the TTL is
// re-derived via ttlSecondsFor instead of an extra Redis TTL read per id).
async function tagSharesBundle(ids, bundleId) {
  if (ids.length === 0) return;
  const shares = await loadShares(ids);
  const r = redis();
  await Promise.all(
    shares.map((share, i) => {
      if (!share) return null;
      return r.set(shareKey(ids[i]), { ...share, bundleId }, { ex: ttlSecondsFor(share.expiresAt) });
    })
  );
}

// Pure decision, kept separate from Redis so it's unit-testable: given how
// many active shares a recipient already had and how many just landed, what
// happens to their bundle?
export function decideBundleAction({ alreadyBundled, existingActiveCount, newCount }) {
  if (alreadyBundled) return 'extend';
  if (existingActiveCount + newCount >= 2) return 'create';
  return 'none';
}

// Create-or-extend the one bundle for `email`. On first-ever creation this
// sweeps in `sweepItemIds` (already-active, not-yet-bundled shares predating
// this feature) alongside the caller's `newItemIds`. Extending never shrinks
// the bundle's expiry.
export async function createOrExtendBundle({ email, newItemIds, sweepItemIds = [], expiresAt }) {
  const norm = normalizeEmail(email);
  const r = redis();
  let bundle = await findActiveBundle(norm);
  if (!bundle) {
    const id = crypto.randomBytes(18).toString('base64url');
    const itemIds = [...new Set([...sweepItemIds, ...newItemIds])];
    bundle = { id, email: norm, createdAt: new Date().toISOString(), expiresAt, itemIds };
  } else {
    const itemIds = [...new Set([...bundle.itemIds, ...newItemIds])];
    const laterExpiry = Date.parse(expiresAt) > Date.parse(bundle.expiresAt) ? expiresAt : bundle.expiresAt;
    bundle = { ...bundle, itemIds, expiresAt: laterExpiry };
  }
  const ttl = ttlSecondsFor(bundle.expiresAt);
  await r.set(k(`bundle:${bundle.id}`), bundle, { ex: ttl });
  await r.set(k(`bundle-by-email:${norm}`), bundle.id, { ex: ttl });
  await tagSharesBundle([...new Set([...newItemIds, ...sweepItemIds])], bundle.id);
  return bundle;
}

// Push a bundle's expiry forward (never back) so it never lapses before a
// member it still owns.
async function extendBundleExpiry(bundleId, candidateExpiresAt) {
  const bundle = await loadBundle(bundleId);
  if (!bundle) return;
  if (Date.parse(candidateExpiresAt) <= Date.parse(bundle.expiresAt)) return; // already covers it
  const r = redis();
  const ttl = ttlSecondsFor(candidateExpiresAt);
  await r.set(k(`bundle:${bundleId}`), { ...bundle, expiresAt: candidateExpiresAt }, { ex: ttl });
  await r.set(k(`bundle-by-email:${bundle.email}`), bundleId, { ex: ttl });
}

// Wraps lib/share.js's extendShare so extending a bundled item also extends
// its bundle — the missing symmetric counterpart to "revoke", bundle-aware.
export async function extendShareAndBundle(id, hours) {
  const result = await extendShare(id, hours);
  if (result.ok && result.share?.bundleId) {
    await extendBundleExpiry(result.share.bundleId, result.expiresAt);
  }
  return result;
}

// Bulk, bundle-aware extend: one MGET to fetch every target share, one SET
// per share that's actually extended (each gets its own new expiresAt, so
// that side can't collapse further), and — the real saving when a bulk
// selection covers many items from the same recipient's bundle — each
// distinct bundle is extended once, not once per member item.
export async function extendSharesAndBundle(ids, hours) {
  const shares = await loadShares(ids);
  const ttlHours = clampHours(hours);
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
  const r = redis();
  const results = new Array(ids.length);
  const bundleIds = new Set();
  await Promise.all(
    shares.map(async (share, i) => {
      const id = ids[i];
      try {
        if (!share) {
          results[i] = { id, ok: false, error: 'Link does not exist' };
          return;
        }
        if (share.revokedAt) {
          results[i] = { id, ok: false, error: 'Link was revoked' };
          return;
        }
        await r.set(shareKey(id), { ...share, expiresAt }, { ex: ttlSecondsFor(expiresAt) });
        results[i] = { id, ok: true, expiresAt };
        if (share.bundleId) bundleIds.add(share.bundleId);
      } catch (err) {
        results[i] = { id, ok: false, error: err?.message || 'Failed' };
      }
    })
  );
  // Best-effort: a bundle's own expiry is a convenience field (liveBundleItems
  // always re-derives status from each member share, never from the bundle
  // record) — a failure extending it must never turn an already-succeeded
  // share extension back into an error for the caller.
  await Promise.all(
    [...bundleIds].map((bundleId) => extendBundleExpiry(bundleId, expiresAt).catch(() => {}))
  );
  return results;
}

// Read every item's title/expiry live from its own share record. Filters out
// anything since revoked, expired, or deleted — the bundle's stored itemIds
// list is not pruned here; a member simply stops appearing once inactive.
// One MGET for the whole bundle instead of one GET per member, and each
// video's title is looked up once per unique videoId instead of once per item.
export async function liveBundleItems(bundle, origin) {
  const shares = await loadShares(bundle.itemIds);
  const active = shares.filter((share) => isShareActive(share));
  const uniqueVideoIds = [...new Set(active.map((share) => share.videoId))];
  const titles = {};
  await Promise.all(
    uniqueVideoIds.map(async (videoId) => {
      try {
        titles[videoId] = (await getVideo(videoId))?.title || videoId;
      } catch {
        titles[videoId] = videoId;
      }
    })
  );
  const items = active.map((share) => ({
    id: share.id,
    url: `${origin}/s/${share.id}`,
    videoTitle: titles[share.videoId],
    expiresAt: share.expiresAt,
  }));
  items.sort((a, b) => a.videoTitle.localeCompare(b.videoTitle));
  return items;
}

function latestExpiry(list) {
  return list.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

// Call once per recipient right after creating `newItems` (the shares just
// made for them in this action). Updates the bundle grouping unconditionally
// (it's a data fact, independent of whether a notification is sent), then —
// if requested — sends whichever notification is appropriate: a plain
// single-link email for a genuine first share, or one consolidated email
// listing everything currently active for them once they have a bundle.
export async function afterShareCreated({ email, newItems, sendEmail, origin }) {
  const norm = normalizeEmail(email);
  const newIds = newItems.map((i) => i.id);
  const existing = await activeSharesForEmail(norm, newIds);
  const already = await findActiveBundle(norm);
  const action = decideBundleAction({
    alreadyBundled: Boolean(already),
    existingActiveCount: existing.length,
    newCount: newItems.length,
  });

  let bundle = null;
  if (action === 'extend') {
    const expiresAt = latestExpiry([...newItems.map((i) => i.expiresAt), already.expiresAt]);
    bundle = await createOrExtendBundle({ email: norm, newItemIds: newIds, expiresAt });
  } else if (action === 'create') {
    const sweepItemIds = existing.filter((s) => !s.bundleId).map((s) => s.id);
    const expiresAt = latestExpiry([
      ...newItems.map((i) => i.expiresAt),
      ...existing.map((s) => s.expiresAt),
    ]);
    bundle = await createOrExtendBundle({ email: norm, newItemIds: newIds, sweepItemIds, expiresAt });
  }

  let emailed = false;
  if (sendEmail && mailEnabled()) {
    if (bundle) {
      const items = await liveBundleItems(bundle, origin);
      const result = await sendBundleShareEmail({ to: norm, bundleUrl: `${origin}/b/${bundle.id}`, items });
      emailed = Boolean(result.ok);
    } else {
      const only = newItems[0];
      const result = await sendShareEmail({
        to: norm,
        url: only.url,
        videoTitle: only.videoTitle,
        expiresAt: only.expiresAt,
      });
      emailed = Boolean(result.ok);
    }
  }
  return { emailed, bundleId: bundle?.id || null };
}
