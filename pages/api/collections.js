import { requireViewer } from '../../lib/guard';
import { listCollections } from '../../lib/bunny';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const viewer = await requireViewer(req, res);
  if (!viewer) return;
  try {
    const data = await listCollections();
    const collections = (data?.items || [])
      .map((c) => ({ guid: c.guid, name: c.name, videoCount: c.videoCount || 0 }))
      .filter((c) => c.videoCount > 0);
    res.json({ collections });
  } catch {
    res.json({ collections: [] });
  }
}
