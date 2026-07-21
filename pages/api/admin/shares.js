import { requireAdmin } from '../../../lib/guard';
import { redis, k } from '../../../lib/redis';
import { getVideo } from '../../../lib/bunny';
import { logAction } from '../../../lib/audit';
import { shareStatus, revokeShare } from '../../../lib/share';

export default async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const r = redis();

  if (req.method === 'GET') {
    try {
      const ids = (await r.smembers(k('shares'))) || [];
      const shares = [];
      await Promise.all(
        ids.map(async (id) => {
          const share = await r.get(k(`share:${id}`)).catch(() => null);
          if (!share) {
            // Truly gone (past its grace window) — self-prune the index.
            await r.srem(k('shares'), id).catch(() => {});
            return;
          }
          shares.push({ id, ...share, status: shareStatus(share) });
        })
      );
      // Titles for display, fetched once per unique video.
      const uniqueVideoIds = [...new Set(shares.map((s) => s.videoId))];
      const titles = {};
      await Promise.all(
        uniqueVideoIds.map(async (videoId) => {
          try {
            titles[videoId] = (await getVideo(videoId))?.title || videoId;
          } catch {
            titles[videoId] = videoId;
          }
        })
      );
      shares.forEach((s) => {
        s.videoTitle = titles[s.videoId];
      });
      shares.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
      return res.json({ shares });
    } catch {
      return res.status(500).json({ error: 'Could not load shares' });
    }
  }

  if (req.method === 'DELETE') {
    const id = String(req.query.id || req.body?.id || '');
    if (!id) return res.status(400).json({ error: 'Bad id' });
    try {
      const result = await revokeShare(id);
      if (!result.ok) return res.status(404).json({ error: result.error });
      await logAction(admin, 'share.revoke', id.slice(0, 8) + '…');
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'Could not revoke' });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}
