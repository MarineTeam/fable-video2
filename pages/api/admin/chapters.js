import { withMonitorApi } from '../../../lib/monitor';
import { requireCapability } from '../../../lib/guard';
import { CAP } from '../../../lib/capabilities';
import { logAction } from '../../../lib/audit';
import { parseChapters } from '../../../lib/chapters';
import { setVideoChapters } from '../../../lib/chaptersStore';
import { oneNumber, oneTrimmed } from '../../../lib/params';

// Sets a video's chapter list. videos.manage — the same capability as renaming
// a video. Reading chapters is not here on purpose: they ship with the video
// list in /api/admin/videos, so the Videos tab needs one fetch rather than two
// (the reasoning admin/schedule.js documents).
//
// The guard runs before req.method is inspected, so an unauthorised caller
// cannot learn the route's expected verb from a 405.
async function handler(req, res) {
  const admin = await requireCapability(req, res, CAP.VIDEOS_MANAGE);
  if (!admin) return;

  if (req.method === 'POST') {
    const guid = oneTrimmed(req.body?.guid) || '';
    if (!/^[0-9a-f-]{10,64}$/i.test(guid)) return res.status(400).json({ error: 'Bad video id' });
    const durationSeconds = oneNumber(req.body?.durationSeconds, 0);
    const { chapters, ignored } = parseChapters(req.body?.text, { durationSeconds });
    try {
      await setVideoChapters(guid, chapters);
      await logAction(
        admin,
        'video.chapters',
        chapters.length ? `${guid}: ${chapters.length} chapters` : `${guid}: cleared`
      );
      // `ignored` is returned, never swallowed: the admin UI shows exactly
      // which lines did not make it and why.
      return res.json({ ok: true, chapters, ignored });
    } catch {
      return res.status(500).json({ error: 'Could not save the chapters' });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}

export default withMonitorApi(handler);
