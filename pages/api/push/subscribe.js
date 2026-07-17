import { requireViewer } from '../../../lib/guard';
import { redis, k } from '../../../lib/redis';
import { pushEnabled } from '../../../lib/push';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!pushEnabled()) return res.status(400).json({ error: 'Push not configured' });
  const viewer = await requireViewer(req, res);
  if (!viewer) return;

  const sub = req.body?.subscription;
  if (
    !sub ||
    typeof sub.endpoint !== 'string' ||
    !sub.endpoint.startsWith('https://') ||
    sub.endpoint.length > 1000
  ) {
    return res.status(400).json({ error: 'Bad subscription' });
  }
  try {
    await redis().hset(k('push:subs'), {
      [sub.endpoint]: { sub, email: viewer.email, addedAt: new Date().toISOString() },
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Could not save subscription' });
  }
}
