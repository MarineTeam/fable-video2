import { withMonitorApi } from "../../../lib/monitor";
import { requireActor } from '../../../lib/guard';
import { SCOPED_REFUSAL } from '../../../lib/staffScope';
import { isScoped } from '../../../lib/staffScopeRules';
import { CAP } from '../../../lib/capabilities';
import { redis, k } from '../../../lib/redis';
import { logAction } from '../../../lib/audit';
// The Videos tab saves the order of the whole list it shows, which is up to
// this many videos; a lower bound here made reordering a larger library fail.
import { MAX_LIBRARY_VIDEOS } from '../../../lib/videoLibrary';

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const actor = await requireActor(req, res, CAP.VIDEOS_MANAGE);
  if (!actor) return;
  const admin = actor.email;
  // The homepage order is one list for everyone.
  if (isScoped(actor)) return res.status(403).json({ error: SCOPED_REFUSAL });

  const order = req.body?.order;
  if (
    !Array.isArray(order) ||
    order.length > MAX_LIBRARY_VIDEOS ||
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
