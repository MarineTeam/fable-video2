import crypto from 'node:crypto';
import { redis, k } from './redis';
import { normalizeEmail } from './auth';
import { isValidFeedToken } from './podcast';

// Per-subscriber feed tokens.
//
//   k('feed-token:<token>')        -> normalized email
//   k('feed-token-by-email:<...>') -> that viewer's current token
//
// Two keys because both directions are needed and each is a single round
// trip: the feed route resolves token -> email on every fetch, and the viewer
// UI shows someone their own URL.
//
// A token is a BEARER CREDENTIAL. Podcast apps cannot log in, so the URL is
// the whole authentication — anyone it is forwarded to can fetch that feed
// until it is revoked. That is why issuing is one-per-viewer and regenerating
// deletes the old token immediately: "regenerate" is the revoke button.
//
// Reads FAIL CLOSED. This resolves identity for an unauthenticated request, so
// an unreadable answer is "no such token", never a guess.

// Inert until configured, like push and mail: without a CDN hostname there is
// no enclosure URL to publish, so the whole feature stays hidden rather than
// serving a feed of broken links.
export function podcastEnabled() {
  return Boolean(process.env.BUNNY_CDN_HOSTNAME);
}

function newToken() {
  // 32 bytes ~ 256 bits, base64url — the same unguessability standard as a
  // share id, which is also a bearer credential.
  return crypto.randomBytes(32).toString('base64url');
}

export async function getFeedToken(email) {
  const norm = normalizeEmail(email);
  if (!norm) return null;
  try {
    const token = await redis().get(k(`feed-token-by-email:${norm}`));
    return isValidFeedToken(token) ? token : null;
  } catch {
    return null;
  }
}

// Issues a fresh token, revoking any previous one in the same call so a
// regenerate cannot leave two live URLs pointing at one person.
export async function issueFeedToken(email) {
  const norm = normalizeEmail(email);
  if (!norm) return { ok: false, error: 'Bad email' };
  const r = redis();
  const previous = await getFeedToken(norm);
  const token = newToken();
  await r.set(k(`feed-token:${token}`), norm);
  await r.set(k(`feed-token-by-email:${norm}`), token);
  if (previous && previous !== token) {
    await r.del(k(`feed-token:${previous}`)).catch(() => {});
  }
  return { ok: true, token, replaced: Boolean(previous) };
}

// The viewer's existing token, or a newly issued one. Used by the viewer UI so
// opening the page does not mint a second credential on every visit.
export async function getOrIssueFeedToken(email) {
  const existing = await getFeedToken(email);
  if (existing) return { ok: true, token: existing, replaced: false };
  return issueFeedToken(email);
}

export async function emailForFeedToken(token) {
  if (!isValidFeedToken(token)) return null;
  try {
    const email = await redis().get(k(`feed-token:${token}`));
    return normalizeEmail(email) || null;
  } catch {
    return null;
  }
}

// Called when a viewer is removed outright, so their feed URL dies with the
// account rather than outliving it — the same no-orphans contract as their
// roles, groups and tags.
export async function revokeFeedToken(email) {
  const norm = normalizeEmail(email);
  if (!norm) return;
  try {
    const r = redis();
    const token = await getFeedToken(norm);
    if (token) await r.del(k(`feed-token:${token}`));
    await r.del(k(`feed-token-by-email:${norm}`));
  } catch {
    // best-effort; the feed route re-checks approval on every fetch anyway,
    // so a lingering token still stops working the moment the viewer is gone
  }
}
