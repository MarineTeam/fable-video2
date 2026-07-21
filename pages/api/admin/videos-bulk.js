import { requireAdmin } from '../../../lib/guard';
import { allowRequest } from '../../../lib/ratelimit';
import { logAction } from '../../../lib/audit';
import { deleteVideo, updateVideo } from '../../../lib/bunny';
import { redis, k } from '../../../lib/redis';

const ACTIONS = new Set(['delete', 'assign-collection']);
const MAX_IDS = 50;

// Multi-select bulk action over existing videos, mirroring shares-bulk.js:
// every id is processed independently — one bad/missing video never aborts
// the rest of the batch.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  if (!(await allowRequest('videos-bulk', admin, 5, 60))) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  const { action, ids, collectionId } = req.body || {};
  if (!ACTIONS.has(action)) return res.status(400).json({ error: 'Bad action' });
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS) {
    return res.status(400).json({ error: `Select 1-${MAX_IDS} videos` });
  }
  if (action === 'assign-collection' && typeof collectionId !== 'string') {
    return res.status(400).json({ error: 'Bad collectionId' });
  }
  const uniqueIds = [...new Set(ids.map(String))];

  const results = await Promise.all(
    uniqueIds.map(async (id) => {
      try {
        if (action === 'delete') await deleteVideo(id);
        else await updateVideo(id, { collectionId });
        return { id, ok: true };
      } catch (err) {
        return { id, ok: false, error: err?.message || 'Failed' };
      }
    })
  );

  if (action === 'delete') {
    const succeeded = new Set(results.filter((r) => r.ok).map((r) => r.id));
    try {
      const r = redis();
      const orderRaw = await r.get(k('order'));
      if (Array.isArray(orderRaw)) {
        await r.set(k('order'), orderRaw.filter((g) => !succeeded.has(g)));
      }
    } catch {}
  }

  const okCount = results.filter((r) => r.ok).length;
  await logAction(admin, `video.bulk_${action}`, `${okCount}/${uniqueIds.length} succeeded`);

  res.json({ results });
}
