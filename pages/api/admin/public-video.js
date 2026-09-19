import { withMonitorApi } from '../../../lib/monitor';
import { requireCapability } from '../../../lib/guard';
import { CAP } from '../../../lib/capabilities';
import { logAction } from '../../../lib/audit';
import { isValidVideoGuid } from '../../../lib/publicVideos';
import { setVideoPublic } from '../../../lib/publicVideosStore';
import { isExplicitlyTrue, oneTrimmed } from '../../../lib/params';

// Opens or closes a video's public door. videos.manage — the same capability
// as deleting a video, because making one world-readable is at least as
// consequential.
//
// Guard first, before req.method, so an unauthorised caller cannot learn the
// route's expected verb from a 405.
async function handler(req, res) {
  const admin = await requireCapability(req, res, CAP.VIDEOS_MANAGE);
  if (!admin) return;

  if (req.method === 'POST') {
    const guid = oneTrimmed(req.body?.guid) || '';
    if (!isValidVideoGuid(guid)) return res.status(400).json({ error: 'Bad video id' });
    // Only an explicit true opens the door; anything else closes it.
    const isPublic = isExplicitlyTrue(req.body?.isPublic);
    try {
      const result = await setVideoPublic(guid, isPublic);
      if (!result.ok) return res.status(400).json({ error: result.error });
      await logAction(admin, isPublic ? 'video.public_on' : 'video.public_off', guid);
      return res.json({ ok: true, isPublic: result.isPublic });
    } catch {
      return res.status(500).json({ error: 'Could not change public access' });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}

export default withMonitorApi(handler);
