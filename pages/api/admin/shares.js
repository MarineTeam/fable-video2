import { requireAdmin } from '../../../lib/guard';
import { redis, k } from '../../../lib/redis';
import { getVideo } from '../../../lib/bunny';
import { logAction } from '../../../lib/audit';
import { shareStatus, revokeShare, unrevokeShare, purgeShare, loadShares } from '../../../lib/share';

export default async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const r = redis();

  if (req.method === 'GET') {
    try {
      const ids = (await r.smembers(k('shares'))) || [];
      // One MGET for every share instead of one GET per id — this is what
      // keeps a 1,000-share list at ~4 Redis commands total instead of ~1,000.
      const loaded = await loadShares(ids);
      const gone = [];
      const shares = [];
      loaded.forEach((share, i) => {
        if (!share) {
          gone.push(ids[i]); // truly gone (past its grace window)
          return;
        }
        shares.push({ ...share, status: shareStatus(share) });
      });
      if (gone.length > 0) {
        // Self-prune the index in one multi-member SREM, not one per id.
        await r.srem(k('shares'), ...gone).catch(() => {});
      }
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
    const permanent = req.query.permanent === '1' || req.body?.permanent === true;
    try {
      if (permanent) {
        const result = await purgeShare(id);
        if (!result.ok) return res.status(409).json({ error: result.error });
        await logAction(admin, 'share.purge', id.slice(0, 8) + '…');
        return res.json({ ok: true });
      }
      const result = await revokeShare(id);
      if (!result.ok) return res.status(404).json({ error: result.error });
      await logAction(admin, 'share.revoke', id.slice(0, 8) + '…');
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: permanent ? 'Could not permanently delete' : 'Could not revoke' });
    }
  }

  // Un-revoke: a deliberate, separate action from Extend and Bulk Revoke —
  // restores the link with its pre-revoke expiresAt untouched, no new token.
  if (req.method === 'PUT') {
    const id = String(req.body?.id || '');
    if (!id) return res.status(400).json({ error: 'Bad id' });
    try {
      const result = await unrevokeShare(id);
      if (!result.ok) return res.status(409).json({ error: result.error });
      await logAction(admin, 'share.unrevoke', id.slice(0, 8) + '…');
      return res.json({ ok: true, expiresAt: result.share.expiresAt });
    } catch {
      return res.status(500).json({ error: 'Could not un-revoke' });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}
