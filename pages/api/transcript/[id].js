import { withMonitorApi } from '../../../lib/monitor';
import { requireViewer } from '../../../lib/guard';
import { oneTrimmed } from '../../../lib/params';
import { contentScopeFor, isVideoVisible } from '../../../lib/groups';
import { isWithinWindow } from '../../../lib/schedule';
import { getVideoWindow } from '../../../lib/scheduleStore';
import { getVideo } from '../../../lib/bunny';
import { getVideoTranscript } from '../../../lib/captionsStore';

// One video's transcript, for the watch page.
//
// GUARDED EXACTLY LIKE pages/watch/[id].js, which is the whole point of this
// file. A transcript is the entire content of a private video in text form, so
// anything laxer than that page's gate is a way to READ a video you cannot
// WATCH. The checks below mirror it in the same order:
//
//   1. approved viewer + geo                 (requireViewer)
//   2. group content gating, enforcement 4   (contentScopeFor/isVideoVisible)
//   3. publish window, staff exempt          (isWithinWindow)
//
// Note that 2 needs the VIDEO, not just its id — isVideoVisible reads the
// video's collection — so this route fetches it, exactly as the page does.
// Skipping that fetch and gating on the id alone would silently drop the
// collection half of the rule.
//
// The caption file is never proxied as a URL: lib/bunny.js fetches the VTT
// server-side and this returns parsed cues from our own origin.
async function handler(req, res) {
  const viewer = await requireViewer(req, res);
  if (!viewer) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = oneTrimmed(req.query.id);
  if (!id || !/^[0-9a-f-]{10,64}$/i.test(id)) {
    return res.status(400).json({ error: 'Bad video id' });
  }

  // requireViewer returns admin=owner and staff separately; the watch page
  // treats either as staff for gating purposes, so this must too.
  const admin = Boolean(viewer.admin || viewer.staff);

  let video;
  try {
    video = await getVideo(id);
  } catch {
    return res.status(404).json({ error: 'Not found' });
  }
  if (!video?.guid) return res.status(404).json({ error: 'Not found' });

  const scope = await contentScopeFor(viewer.email, { staff: admin });
  if (!isVideoVisible(scope, video)) {
    return res.status(404).json({ error: 'Not found' });
  }

  if (!admin && !isWithinWindow(await getVideoWindow(video.guid))) {
    return res.status(404).json({ error: 'Not found' });
  }

  // An empty transcript is a normal answer, not an error: most videos have
  // never been transcribed, and the panel renders nothing for them.
  // getVideoTranscript already swallows read failures into [].
  return res.json({ cues: await getVideoTranscript(video.guid) });
}

export default withMonitorApi(handler);
