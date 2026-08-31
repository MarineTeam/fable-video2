import { withMonitorApi } from '../../lib/monitor';
import { auth0 } from '../../lib/auth0';
import { trustedEmail, adminEmails } from '../../lib/auth';
import { viewerAccessFor } from '../../lib/guard';
import { allowRequest } from '../../lib/ratelimit';
import { logAction } from '../../lib/audit';
import { recordAccessRequest, normalizeNote } from '../../lib/accessRequests';
import { sendAccessRequestEmail } from '../../lib/mail';

// The one route in the app deliberately reachable by a signed-in user who is
// NOT an approved viewer — that is the entire feature. It is therefore guarded
// by session-only (plus the verified-email check every other surface gets),
// never by requireViewer, and it grants nothing: the most it can do is put the
// caller's own address into a queue an admin still has to act on.
//
// Rate limited per email, and the queue itself is capped in lib/accessRequests
// so a pool of accounts cannot flood it either.
async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const session = await auth0.getSession(req, res);
  if (!session) return res.status(401).json({ error: 'Not signed in' });
  const email = trustedEmail(session.user);
  if (!email) return res.status(401).json({ error: 'Not signed in' });

  if (!(await allowRequest('request-access', email, 3, 3600))) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  // Already approved (or staff) — nothing to request. Reported plainly: the
  // caller is asking about their own access, so this leaks nothing.
  const { approved } = await viewerAccessFor(email);
  if (approved) return res.status(400).json({ error: 'You already have access' });

  const note = normalizeNote(req.body?.note);
  let result;
  try {
    result = await recordAccessRequest(email, note);
  } catch {
    return res.status(500).json({ error: 'Could not file the request' });
  }
  if (!result.ok) return res.status(429).json({ error: result.error });

  if (!result.duplicate) {
    await logAction(email, 'access.request', note ? `"${note}"` : '(no note)');
    // Best-effort, inert without RESEND_API_KEY — house idiom.
    sendAccessRequestEmail({ to: adminEmails(), requester: email, note }).catch(() => {});
  }

  res.json({ ok: true, duplicate: result.duplicate });
}

export default withMonitorApi(handler);
