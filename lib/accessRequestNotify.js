import { CAP } from './capabilities';
import { emailsHoldingCapability } from './roles';
import { sendAccessRequestEmail } from './mail';
import { sendToAll } from './push';

// Tells the people who can actually action a pending request that one arrived.
// Addressed by capability, not by a hardcoded list: whoever holds
// VIEWERS_MANAGE can approve, so whoever holds it is who gets told — delegate
// viewer management to someone new and they start being notified without any
// code change.
//
// Wholly best-effort. Both channels are already inert without their keys
// (RESEND_API_KEY, the VAPID pair), and every failure is swallowed here so it
// can never reach the submission it describes: the requester's ask is the
// product, this is a convenience.
export async function notifyNewAccessRequest({ email, note }) {
  let recipients = [];
  try {
    recipients = await emailsHoldingCapability(CAP.VIEWERS_MANAGE);
  } catch {
    return { notified: 0 };
  }
  if (!recipients.length) return { notified: 0 };

  // The note is escaped for HTML inside sendAccessRequestEmail and is already
  // clamped and control-stripped at the point of entry (lib/accessRequests.js).
  await Promise.allSettled([
    sendAccessRequestEmail({ to: recipients, requester: email, note }),
    sendToAll(
      {
        title: 'Access requested',
        body: note ? `${email}: ${note}` : email,
        url: '/admin',
      },
      { toEmails: recipients }
    ),
  ]);
  return { notified: recipients.length };
}
