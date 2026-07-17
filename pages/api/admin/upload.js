import { requireAdmin } from '../../../lib/guard';
import { allowRequest } from '../../../lib/ratelimit';
import { createVideo, tusAuth } from '../../../lib/bunny';
import { logAction } from '../../../lib/audit';

// Creates the Bunny video record and returns a server-signed TUS ticket.
// The browser then streams the file straight to bunny.net — no video bytes
// ever touch this server, and the API key stays here.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  if (!(await allowRequest('upload', admin, 20, 3600))) {
    return res.status(429).json({ error: 'Too many uploads, slow down' });
  }

  const title = String(req.body?.title || '').trim().slice(0, 200) || 'Untitled';
  const collectionId = typeof req.body?.collectionId === 'string' ? req.body.collectionId : '';

  try {
    const created = await createVideo(title, collectionId);
    if (!created?.guid) throw new Error('No guid returned');
    const { endpoint, headers } = tusAuth(created.guid);
    await logAction(admin, 'video.upload', `"${title}"`);
    res.json({ videoId: created.guid, endpoint, headers });
  } catch {
    res.status(502).json({ error: 'Could not create video' });
  }
}
