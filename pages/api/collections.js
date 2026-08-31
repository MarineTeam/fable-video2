import { withMonitorApi } from "../../lib/monitor";
import { requireViewer } from '../../lib/guard';
import { listCollections } from '../../lib/bunny';
import { contentScopeFor, filterCollectionsByScope } from '../../lib/groups';

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const viewer = await requireViewer(req, res);
  if (!viewer) return;
  try {
    const [data, scope] = await Promise.all([
      listCollections(),
      contentScopeFor(viewer.email, { staff: viewer.admin || viewer.staff }),
    ]);
    const collections = filterCollectionsByScope(
      (data?.items || [])
        .map((c) => ({ guid: c.guid, name: c.name, videoCount: c.videoCount || 0 }))
        .filter((c) => c.videoCount > 0),
      scope
    );
    res.json({ collections });
  } catch {
    res.json({ collections: [] });
  }
}

export default withMonitorApi(handler);
