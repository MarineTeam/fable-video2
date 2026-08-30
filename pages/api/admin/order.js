import { withMonitorApi } from "../../../lib/monitor";
import { requireCapability } from '../../../lib/guard';
import { CAP } from '../../../lib/capabilities';
import { redis, k } from '../../../lib/redis';
import { logAction } from '../../../lib/audit';

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const admin = await requireCapability(req, res, CAP.VIDEOS_MANAGE);
  if (!admin) return;

  const order = req.body?.order;
  if (
    !Array.isArray(order) ||
    order.length > 500 ||
    order.some((g) => typeof g !== 'string' || !g || g.length > 64)
  ) {
    return res.status(400).json({ error: 'Bad order' });
  }
  try {
    await redis().set(k('order'), order);
    await logAction(admin, 'videos.reorder', `${order.length} videos`);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Could not save order' });
  }
}

export default withMonitorApi(handler);
