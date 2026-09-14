import { isWithinWindow } from './schedule';

// Public (unlisted) videos: one talk reachable without an account, for
// "watch this, then come along on Sunday".
//
// This inverts the portal's founding assumption, so the rules are stated here
// rather than spread across a page:
//
//   * DEFAULT DENY, explicitly. A video is public only when its guid is in the
//     stored set. Absence is never read as permission, and there is no
//     "unset means public" path anywhere.
//   * Public is ADDITIVE. Marking a video public opens one extra door; it does
//     not remove the video from the invite-only library, and it does not touch
//     groups, which narrow *viewer* access and are meaningless to a visitor
//     who is not a viewer.
//   * The publish window STILL APPLIES. A video scheduled for next Sunday is
//     not public early just because someone ticked the box, and an expired one
//     closes on schedule.
//
// PURE — imports only lib/schedule.js, which is itself pure. Redis lives in
// lib/publicVideosStore.js.

export const VIDEO_GUID = /^[0-9a-f-]{10,64}$/i;

export function isValidVideoGuid(guid) {
  return typeof guid === 'string' && VIDEO_GUID.test(guid);
}

// The single decision the public route makes. Returns a reason for the caller
// to log, never to render: every denial must look identical from outside so
// the route cannot be used to probe which guids exist or why one is refused.
export function resolvePublicAccess({ isPublic, window, now = Date.now() } = {}) {
  if (!isPublic) return { allowed: false, reason: 'not-public' };
  if (!isWithinWindow(window, now)) return { allowed: false, reason: 'outside-window' };
  return { allowed: true, reason: 'ok' };
}

// Normalises whatever the SET read returns into a guid set. Defensive for the
// same reason as every other store reader here: a value written by another
// tool must not become an access decision.
export function toPublicGuidSet(values) {
  const out = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    if (isValidVideoGuid(value)) out.add(value);
  }
  return out;
}
