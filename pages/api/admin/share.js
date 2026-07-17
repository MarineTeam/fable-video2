import crypto from 'crypto';
import { requireAdmin } from '../../../lib/guard';
import { allowRequest } from '../../../lib/ratelimit';
import { redis, k } from '../../../lib/redis';
import { normalizeEmail, isValidEmail } from '../../../lib/auth';
import { getVideo } from '../../../lib/bunny';
import { mailEnabled, sendShareEmail } from '../../../lib/mail';
import { logAction } from '../../../lib/audit';

const DEFAULT_HOURS = 72;
const MAX_HOURS = 720; // 30 days

function baseUrl(req) {
  const fromEnv = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  if (fromEnv) return fromEnv;
  return `https://${req.headers.host}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  if (!(await allowRequest('share', admin, 10, 60))) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  const r = redis();

  // Re-deliver an existing link to its original recipient.
  if (req.body?.resend) {
    const id = String(req.body.resend);
    const share = await r.get(k(`share:${id}`)).catch(() => null);
    if (!share) return res.status(404).json({ error: 'Link expired or does not exist' });
    let videoTitle = '';
    try {
      videoTitle = (await getVideo(share.videoId))?.title || '';
    } catch {}
    const result = await sendShareEmail({
      to: share.email,
      url: `${baseUrl(req)}/s/${id}`,
      videoTitle,
      expiresAt: share.expiresAt,
    });
    await logAction(admin, 'share.resend', `${share.email} (${id.slice(0, 8)}…)`);
    return res.json({ emailed: Boolean(result.ok) });
  }

  // Create a new link.
  const { videoId, email, hours, sendEmail } = req.body || {};
  if (typeof videoId !== 'string' || !videoId || videoId.length > 64) {
    return res.status(400).json({ error: 'Bad videoId' });
  }
  const recipient = normalizeEmail(email);
  if (!isValidEmail(recipient)) return res.status(400).json({ error: 'Bad recipient email' });
  const ttlHours = Math.min(Math.max(parseInt(hours, 10) || DEFAULT_HOURS, 1), MAX_HOURS);

  const id = crypto.randomBytes(18).toString('base64url');
  const now = new Date();
  const share = {
    videoId,
    email: recipient,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlHours * 3600 * 1000).toISOString(),
  };
  try {
    await r.set(k(`share:${id}`), share, { ex: ttlHours * 3600 });
    await r.sadd(k('shares'), id);
  } catch {
    return res.status(500).json({ error: 'Could not create link' });
  }
  await logAction(admin, 'share.create', `${recipient} · video ${videoId} · ${ttlHours}h`);

  const url = `${baseUrl(req)}/s/${id}`;
  let emailed = false;
  if (sendEmail && mailEnabled()) {
    let videoTitle = '';
    try {
      videoTitle = (await getVideo(videoId))?.title || '';
    } catch {}
    // Best-effort: a mail failure never blocks link creation.
    const result = await sendShareEmail({
      to: recipient,
      url,
      videoTitle,
      expiresAt: share.expiresAt,
    });
    emailed = Boolean(result.ok);
  }
  res.json({ id, url, expiresAt: share.expiresAt, emailed });
}
