import { requireAdmin } from '../../../lib/guard';
import { allowRequest } from '../../../lib/ratelimit';
import { normalizeEmail, isValidEmail } from '../../../lib/auth';
import { getVideo } from '../../../lib/bunny';
import { logAction } from '../../../lib/audit';
import { createShare, clampHours, baseUrl, resendShareEmail } from '../../../lib/share';
import { extendShareAndBundle, afterShareCreated } from '../../../lib/bundle';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  if (!(await allowRequest('share', admin, 10, 60))) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  // Re-deliver an existing link's own email to its original recipient.
  if (req.body?.resend) {
    const id = String(req.body.resend);
    const result = await resendShareEmail(id, baseUrl(req));
    if (result.error) return res.status(404).json({ error: result.error });
    await logAction(admin, 'share.resend', id.slice(0, 8) + '…');
    return res.json({ emailed: Boolean(result.ok) });
  }

  // Extend expiry in place — same token/URL, no new link. From now, not from
  // the stale old expiry; refused outright on a revoked item.
  if (req.body?.extend) {
    const id = String(req.body.extend);
    const result = await extendShareAndBundle(id, req.body.hours);
    if (!result.ok) return res.status(409).json({ error: result.error });
    await logAction(admin, 'share.extend', id.slice(0, 8) + '…');
    return res.json({ ok: true, expiresAt: result.expiresAt });
  }

  // Create a new link.
  const { videoId, email, hours, sendEmail } = req.body || {};
  if (typeof videoId !== 'string' || !videoId || videoId.length > 64) {
    return res.status(400).json({ error: 'Bad videoId' });
  }
  const recipient = normalizeEmail(email);
  if (!isValidEmail(recipient)) return res.status(400).json({ error: 'Bad recipient email' });
  const ttlHours = clampHours(hours);

  let id, share;
  try {
    ({ id, share } = await createShare({ videoId, email: recipient, hours: ttlHours }));
  } catch {
    return res.status(500).json({ error: 'Could not create link' });
  }
  await logAction(admin, 'share.create', `${recipient} · video ${videoId} · ${ttlHours}h`);

  const origin = baseUrl(req);
  const url = `${origin}/s/${id}`;
  let videoTitle = '';
  try {
    videoTitle = (await getVideo(videoId))?.title || '';
  } catch {}

  // Best-effort: a mail failure never blocks link creation.
  const { emailed, bundleId } = await afterShareCreated({
    email: recipient,
    newItems: [{ id, url, videoTitle, expiresAt: share.expiresAt }],
    sendEmail: Boolean(sendEmail),
    origin,
  });

  res.json({ id, url, expiresAt: share.expiresAt, emailed, bundleId });
}
