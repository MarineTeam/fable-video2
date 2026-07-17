import { requireAdmin } from '../../../lib/guard';
import {
  listVideos,
  updateVideo,
  deleteVideo,
  thumbnailUrl,
} from '../../../lib/bunny';
import { redis, k } from '../../../lib/redis';
import { applyOrder } from '../../../lib/order';
import { announceNewVideos } from '../../../lib/push';
import { logAction } from '../../../lib/audit';

export default async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const r = redis();

  if (req.method === 'GET') {
    try {
      const data = await listVideos({ page: 1, perPage: 100 });
      const items = data?.items || [];
      // Announce freshly finished uploads (atomic once-only guard inside).
      await announceNewVideos(items).catch(() => {});
      const orderRaw = await r.get(k('order')).catch(() => null);
      const ordered = applyOrder(items, Array.isArray(orderRaw) ? orderRaw : []);
      return res.json({
        videos: ordered.map((v) => ({
          guid: v.guid,
          title: v.title,
          length: v.length || 0,
          status: v.status,
          encodeProgress: v.encodeProgress || 0,
          views: v.views || 0,
          collectionId: v.collectionId || '',
          dateUploaded: v.dateUploaded || null,
          thumbnail: thumbnailUrl(v),
        })),
      });
    } catch {
      return res.status(502).json({ error: 'Video service unavailable' });
    }
  }

  if (req.method === 'PUT') {
    const { id, title, collectionId } = req.body || {};
    if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'Bad id' });
    const fields = {};
    if (typeof title === 'string' && title.trim()) fields.title = title.trim().slice(0, 200);
    if (typeof collectionId === 'string') fields.collectionId = collectionId;
    if (!Object.keys(fields).length) return res.status(400).json({ error: 'Nothing to update' });
    try {
      await updateVideo(id, fields);
      if (fields.title) await logAction(admin, 'video.rename', `${id} → "${fields.title}"`);
      if ('collectionId' in fields) await logAction(admin, 'video.collection', id);
      return res.json({ ok: true });
    } catch {
      return res.status(502).json({ error: 'Update failed' });
    }
  }

  if (req.method === 'DELETE') {
    const id = String(req.query.id || req.body?.id || '');
    if (!id) return res.status(400).json({ error: 'Bad id' });
    try {
      await deleteVideo(id);
      // Prune the deleted video from the saved order.
      try {
        const orderRaw = await r.get(k('order'));
        if (Array.isArray(orderRaw) && orderRaw.includes(id)) {
          await r.set(k('order'), orderRaw.filter((g) => g !== id));
        }
      } catch {}
      await logAction(admin, 'video.delete', id);
      return res.json({ ok: true });
    } catch {
      return res.status(502).json({ error: 'Delete failed' });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}
