import { requireAdmin } from '../../../lib/guard';
import { listCollections, createCollection, deleteCollection } from '../../../lib/bunny';
import { logAction } from '../../../lib/audit';

export default async function handler(req, res) {
  const admin = await requireAdmin(req, res);
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
    const name = String(req.body?.name || '').trim().slice(0, 100);
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
    const id = String(req.query.id || req.body?.id || '');
    if (!id) return res.status(400).json({ error: 'Bad id' });
    try {
      await deleteCollection(id);
      await logAction(admin, 'collection.delete', id);
      return res.json({ ok: true });
    } catch {
      return res.status(502).json({ error: 'Could not delete collection' });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}
