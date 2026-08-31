import { withMonitorApi } from '../../../lib/monitor';
import { requireCapability } from '../../../lib/guard';
import { CAP } from '../../../lib/capabilities';
import { logAction } from '../../../lib/audit';
import { normalizeWindow } from '../../../lib/schedule';
import { setVideoWindow } from '../../../lib/scheduleStore';

// Sets a video's publish window. videos.manage — the same capability as
// renaming or deleting a video. Reading windows is not here on purpose: they
// ship with the video list in /api/admin/videos, so the Videos tab needs one
// fetch rather than two.
async function handler(req, res) {
  const admin = await requireCapability(req, res, CAP.VIDEOS_MANAGE);
  if (!admin) return;

  if (req.method === 'POST') {
    const guid = String(req.body?.guid || '');
    if (!/^[0-9a-f-]{10,64}$/i.test(guid)) return res.status(400).json({ error: 'Bad video id' });
    const window = normalizeWindow({ from: req.body?.from, until: req.body?.until });
    if (window?.invalid) {
      return res.status(400).json({ error: 'The end of the window must be after its start' });
    }
    try {
      await setVideoWindow(guid, window);
      await logAction(
        admin,
        'video.schedule',
        window ? `${guid}: ${window.from || 'now'} → ${window.until || 'forever'}` : `${guid}: cleared`
      );
      return res.json({ ok: true, window });
    } catch {
      return res.status(500).json({ error: 'Could not save the schedule' });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}

export default withMonitorApi(handler);
