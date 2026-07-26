import { requireAdmin } from '../../../lib/guard';
import { allowRequest } from '../../../lib/ratelimit';
import { normalizeEmail, isValidEmail } from '../../../lib/auth';
import { getVideo } from '../../../lib/bunny';
import { logAction } from '../../../lib/audit';
import { createShare, clampHours, baseUrl, resendShareEmail } from '../../../lib/share';
import { extendShareAndBundle, afterShareCreated } from '../../../lib/bundle';

const MAX_EMAILS = 50;

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

  // Create a new link — one video, one or more recipients in a single
  // request (each still gets their own independently-revocable share).
  const { videoId, emails, hours, sendEmail, watermark } = req.body || {};
  if (typeof videoId !== 'string' || !videoId || videoId.length > 64) {
    return res.status(400).json({ error: 'Bad videoId' });
  }
  if (!Array.isArray(emails) || emails.length === 0 || emails.length > MAX_EMAILS) {
    return res.status(400).json({ error: `Provide 1-${MAX_EMAILS} recipient emails` });
  }
  const recipients = [...new Set(emails.map(normalizeEmail))].filter(Boolean);
  if (recipients.length === 0 || recipients.some((e) => !isValidEmail(e))) {
    return res.status(400).json({ error: 'Bad recipient email in list' });
  }
  const ttlHours = clampHours(hours);

  const origin = baseUrl(req);
  let videoTitle = '';
  try {
    videoTitle = (await getVideo(videoId))?.title || '';
  } catch {}

  let created;
  try {
    created = await Promise.all(
      recipients.map(async (recipient) => {
        const { id, share } = await createShare({ videoId, email: recipient, hours: ttlHours, watermark });
        return { id, email: recipient, url: `${origin}/s/${id}`, videoTitle, expiresAt: share.expiresAt };
      })
    );
  } catch {
    return res.status(500).json({ error: 'Could not create link(s)' });
  }
  await logAction(admin, 'share.create', `${recipients.join(', ')} · video ${videoId} · ${ttlHours}h`);

  // Best-effort per recipient: a mail failure never blocks link creation.
  const outcomes = {};
  await Promise.all(
    created.map(async (item) => {
      outcomes[item.email] = await afterShareCreated({
        email: item.email,
        newItems: [item],
        sendEmail: Boolean(sendEmail),
        origin,
      });
    })
  );

  res.json({
    created: created.map((c) => ({
      id: c.id,
      email: c.email,
      url: c.url,
      expiresAt: c.expiresAt,
      emailed: outcomes[c.email]?.emailed || false,
      bundleId: outcomes[c.email]?.bundleId || null,
    })),
  });
}
