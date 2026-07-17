import { requireAdmin } from '../../../lib/guard';
import { pushEnabled, sendToAll } from '../../../lib/push';
import { logAction } from '../../../lib/audit';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  if (!pushEnabled()) return res.status(400).json({ error: 'Push is not configured' });

  const title = String(req.body?.title || '').trim().slice(0, 80);
  const body = String(req.body?.body || '').trim().slice(0, 200);
  if (!title) return res.status(400).json({ error: 'Title required' });

  const result = await sendToAll({ title, body, url: '/' });
  await logAction(admin, 'push.broadcast', `"${title}" → ${result.sent} devices`);
  res.json(result);
}
