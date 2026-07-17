import { requireViewer } from '../../lib/guard';
import { allowRequest } from '../../lib/ratelimit';
import { listVideos, thumbnailUrl, isPlayable } from '../../lib/bunny';
import { redis, k } from '../../lib/redis';
import { applyOrder } from '../../lib/order';

const PAGE_SIZE = 10;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const viewer = await requireViewer(req, res);
  if (!viewer) return;
  if (!(await allowRequest('videos', viewer.email, 60, 60))) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  const search = String(req.query.q || '').slice(0, 100);
  const collection = String(req.query.collection || '').slice(0, 64);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  const r = redis();
  const [countRaw, orderRaw] = await Promise.all([
    r.get(k('settings:homeCount')).catch(() => null),
    r.get(k('order')).catch(() => null),
  ]);
  const homeCount = Math.min(Math.max(parseInt(countRaw, 10) || 48, 1), 200);
  const order = Array.isArray(orderRaw) ? orderRaw : [];

  try {
    const data = await listVideos({ page: 1, perPage: Math.min(homeCount, 100), search, collection });
    const playable = (data?.items || []).filter(isPlayable);
    const capped = applyOrder(playable, order).slice(0, homeCount);

    const start = (page - 1) * PAGE_SIZE;
    const videos = capped.slice(start, start + PAGE_SIZE).map((v) => ({
      guid: v.guid,
      title: v.title,
      length: v.length || 0,
      collectionId: v.collectionId || '',
      thumbnail: thumbnailUrl(v),
    }));
    res.json({
      videos,
      total: capped.length,
      page,
      pages: Math.max(1, Math.ceil(capped.length / PAGE_SIZE)),
    });
  } catch {
    res.status(502).json({ error: 'Video service unavailable' });
  }
}
