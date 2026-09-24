import { withMonitorApi } from "../../../lib/monitor";
import { requireCapability } from '../../../lib/guard';
import { CAP } from '../../../lib/capabilities';
import { listCollections, createCollection, deleteCollection } from '../../../lib/bunny';
import { logAction } from '../../../lib/audit';
import { oneTrimmed } from '../../../lib/params';
import { pruneCollectionFromGroups } from '../../../lib/groups';

async function handler(req, res) {
  const admin = await requireCapability(req, res, req.method === 'GET' ? CAP.VIDEOS_READ : CAP.VIDEOS_MANAGE);
  if (!admin) return;

  if (req.method === 'GET') {
    try {
      const data = await listCollections();
      return res.json({
        collections: (data?.items || []).map((c) => ({
          guid: c.guid,
          name: c.name,
          videoCount: c.videoCount || 0,
        })),
      });
    } catch {
      return res.status(502).json({ error: 'Could not load collections' });
    }
  }

  if (req.method === 'POST') {
    const name = (oneTrimmed(req.body?.name) || '').slice(0, 100);
    if (!name) return res.status(400).json({ error: 'Bad name' });
    try {
      const created = await createCollection(name);
      await logAction(admin, 'collection.create', name);
      return res.json({ guid: created?.guid, name });
    } catch {
      return res.status(502).json({ error: 'Could not create collection' });
    }
  }

  if (req.method === 'DELETE') {
    const id = oneTrimmed(req.query.id) || oneTrimmed(req.body?.id);
    if (!id) return res.status(400).json({ error: 'Bad id' });
    try {
      await deleteCollection(id);
      // A group scoped to this collection must not keep granting it.
      const pruned = await pruneCollectionFromGroups(id);
      await logAction(
        admin,
        'collection.delete',
        pruned ? `${id} (cleared from ${pruned} group scope(s))` : id
      );
      return res.json({ ok: true });
    } catch {
      return res.status(502).json({ error: 'Could not delete collection' });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}

export default withMonitorApi(handler);
