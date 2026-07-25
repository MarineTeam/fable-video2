import { redis, k } from './redis';
import { normalizeEmail } from './auth';
import { isShareActive, revokeShare, loadShares } from './share';

// A video's "private list" is not a new stored entity — it's just the set of
// currently-active (not revoked, not expired) shares for that videoId, one
// row per recipient. Reusing lib/share.js's own `shares` index keeps this
// feature purely a view/policy layer on top of the existing share primitive,
// per the same idiom as lib/bundle.js.
export async function activeSharesForVideo(videoId) {
  const ids = (await redis().smembers(k('shares'))) || [];
  const shares = await loadShares(ids);
  return shares.filter((s) => s && s.videoId === videoId && isShareActive(s));
}

// Pure split, kept separate from Redis so it's unit-testable: which of the
// requested emails are genuinely new to this video's list (deduped against
// each other and against whoever already has active access) versus already
// on it. Emails already on the list must come back untouched by the caller —
// no duplicate share, no re-sent notification.
export function splitPrivateListEmails(requestedEmails, activeShares) {
  const already = new Set(activeShares.map((s) => normalizeEmail(s.email)));
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

// Remove an email from a video's private list by revoking its underlying
// share(s) immediately. Normally there's exactly one active share for a
// given (videoId, email) pair, but nothing stops a direct Share action
// (outside the private-list UI) from having created a second one, so every
// currently-active match is revoked, not just the first.
export async function revokePrivateListEntry(videoId, email) {
  const norm = normalizeEmail(email);
  const active = (await activeSharesForVideo(videoId)).filter(
    (s) => normalizeEmail(s.email) === norm
  );
  const results = await Promise.all(active.map((s) => revokeShare(s.id)));
  return { ok: true, revoked: results.filter((r) => r.ok).length };
}
