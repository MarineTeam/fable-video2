import { redis, k } from './redis';
import { normalizeEmail } from './auth';
import { isShareActive, revokeShare, loadShares, ttlSecondsFor, shareKey } from './share';

// A video's "private list" is a first-class, feature-owned index — a HASH
// mapping normalized email -> the shareId THIS feature created for them, kept
// per video. Deliberately not "every active share for this video": a share
// created through the regular Share/Bulk Share button for the same
// (videoId, email) pair is invisible to the list and untouched by it. The
// list only ever tracks, and only ever revokes, the tokens it created itself
// — so removing someone here can never reach out and kill a link granted
// through a different flow, and a different video's list is a different key
// entirely.
function privateListKey(videoId) {
  return k(`private-list:${videoId}`);
}

// Live view: resolve the tracked email->shareId map against each share's
// current record, and keep only entries whose share is still active. A
// tracked id whose share has since been revoked/expired/purged — whether via
// this feature's own Remove or directly from the Shares tab — is dropped
// from the view and swept from the hash, self-healing the same way the
// `shares` index prunes truly-gone ids on read (see pages/api/admin/shares.js).
export async function loadPrivateList(videoId) {
  const r = redis();
  const map = (await r.hgetall(privateListKey(videoId))) || {};
  const emails = Object.keys(map);
  if (emails.length === 0) return [];
  const shares = await loadShares(emails.map((email) => map[email]));
  const stale = [];
  const entries = [];
  emails.forEach((email, i) => {
    const share = shares[i];
    if (share && isShareActive(share)) {
      entries.push({ email, id: share.id, createdAt: share.createdAt, expiresAt: share.expiresAt });
    } else {
      stale.push(email);
    }
  });
  if (stale.length > 0) {
    await r.hdel(privateListKey(videoId), ...stale).catch(() => {});
  }
  entries.sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0));
  return entries;
}

// Pure split, kept separate from Redis so it's unit-testable: which of the
// requested emails are genuinely new to this video's *tracked* list (deduped
// against each other and against anyone the list already has a live invite
// for) versus already on it — left untouched, no duplicate share, no
// re-sent notification.
export function splitPrivateListEmails(requestedEmails, currentEntries) {
  const already = new Set(currentEntries.map((e) => normalizeEmail(e.email)));
  const seen = new Set();
  const fresh = [];
  for (const raw of requestedEmails) {
    const email = normalizeEmail(raw);
    if (!email || seen.has(email) || already.has(email)) continue;
    seen.add(email);
    fresh.push(email);
  }
  return fresh;
}

// Track a newly created share as this video's invite for `email`. Also tags
// the share record itself with `viaPrivateList: true` so the Shares tab can
// visibly mark it — otherwise a share made through the regular Share button
// and one made through the Private list for the same (videoId, email) are
// indistinguishable there, and revoking "the regular one" is unverifiable:
// pick the wrong row and the Private list entry disappears too (correctly —
// it's the same token — but with no way to tell that's what happened).
// The hash's own TTL only needs to cover its longest-lived tracked entry, so
// it's re-derived and extended forward (never shrunk) on every write — same
// idiom as lib/bundle.js's extendBundleExpiry, just against a TTL read
// instead of a stored expiresAt field (a HASH has one TTL for the whole key,
// not one per field).
export async function recordPrivateListShare(videoId, email, share) {
  const r = redis();
  const key = privateListKey(videoId);
  await r.hset(key, { [normalizeEmail(email)]: share.id });
  await r.set(shareKey(share.id), { ...share, viaPrivateList: true }, { ex: ttlSecondsFor(share.expiresAt) });
  const ttl = ttlSecondsFor(share.expiresAt);
  const currentTtl = await r.ttl(key).catch(() => -1);
  if (currentTtl < ttl) await r.expire(key, ttl).catch(() => {});
}

// Remove an email from a video's list: revoke exactly the one share this
// feature tracked for them — never "every active share for this video and
// email," which could reach into a separately-created regular Share for the
// same pair — then drop the tracked mapping. A no-op (not an error) if the
// list has nothing on file for that email.
export async function revokePrivateListEntry(videoId, email) {
  const r = redis();
  const key = privateListKey(videoId);
  const norm = normalizeEmail(email);
  const shareId = await r.hget(key, norm);
  if (!shareId) return { ok: true, revoked: 0 };
  const result = await revokeShare(shareId);
  await r.hdel(key, norm).catch(() => {});
  return { ok: true, revoked: result.ok ? 1 : 0 };
}
