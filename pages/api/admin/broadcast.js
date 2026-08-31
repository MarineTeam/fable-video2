import { withMonitorApi } from "../../../lib/monitor";
import { requireCapability } from '../../../lib/guard';
import { CAP } from '../../../lib/capabilities';
import { pushEnabled, sendToAll } from '../../../lib/push';
import { logAction } from '../../../lib/audit';

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const admin = await requireCapability(req, res, CAP.BROADCAST_SEND);
  if (!admin) return;
  if (!pushEnabled()) return res.status(400).json({ error: 'Push is not configured' });

  const title = String(req.body?.title || '').trim().slice(0, 80);
  const body = String(req.body?.body || '').trim().slice(0, 200);
  if (!title) return res.status(400).json({ error: 'Title required' });

  const result = await sendToAll({ title, body, url: '/' });
  await logAction(admin, 'push.broadcast', `"${title}" → ${result.sent} devices`);
  res.json(result);
}

export default withMonitorApi(handler);
