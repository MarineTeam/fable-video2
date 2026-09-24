import { withMonitorApi } from '../../lib/monitor';
import { requireViewer } from '../../lib/guard';
import { oneTrimmed } from '../../lib/params';
import { allowRequest } from '../../lib/ratelimit';
import { contentScopeFor, isVideoVisible } from '../../lib/groups';
import { isVideoInWindowFor } from '../../lib/scheduleStore';
import { getVideo } from '../../lib/bunny';
import { getRatings, recordRating } from '../../lib/ratingsStore';
import { normalizeVote, ratingOf } from '../../lib/ratings';

// The viewer's own rating of one video.
//
//   GET    ?guid=...        -> { vote: 'up' | 'down' | null }
//   POST   { guid, vote }   -> set it
//   DELETE ?guid=...        -> clear it
//
// Per-viewer data, so the email comes from the SESSION and this route takes no
// email parameter at all — the same guarantee /api/mylist gives.
//
// RATING IS GATED LIKE WATCHING, matching pages/watch/[id].js, which in THIS
// repo means fetching the video: isVideoVisible reads its collection, so a
// guid alone cannot answer the question. Without the gate a restricted viewer
// could rate a video they cannot see; the vote would be invisible to them
// afterwards, but the write would have succeeded, and a 200 is itself an
// answer to 'does this exist?'.
//
// TOTALS ARE NEVER RETURNED HERE. A viewer sees their own vote and nothing
// else; the counts are staff-only and served with the admin video list. See
// lib/ratings.js for why.
const GUID = /^[0-9a-f-]{10,64}$/i;

async function handler(req, res) {
  const viewer = await requireViewer(req, res);
  if (!viewer) return;

  const guid = req.method === 'POST' ? oneTrimmed(req.body?.guid) : oneTrimmed(req.query.guid);
  if (!guid || !GUID.test(guid)) return res.status(400).json({ error: 'Bad video id' });

  if (req.method === 'GET') {
    return res.json({ vote: ratingOf(await getRatings(viewer.email), guid) });
  }

  if (req.method === 'POST' || req.method === 'DELETE') {
    // Seconds as a NUMBER — this repo's allowRequest builds `${n} s`. A viewer
    // write path rather than an admin one: cheap per call, unbounded in
    // aggregate, reachable by anyone approved.
    if (!(await allowRequest('rating', viewer.email, 120, 3600))) {
      return res.status(429).json({ error: 'Too many ratings — try again shortly' });
    }

    // Strict: 'up', 'down', or nothing. A DELETE clears, so there is no third
    // spelling of 'no opinion' to get wrong.
    const next = req.method === 'DELETE' ? null : normalizeVote(req.body?.vote);
    if (req.method === 'POST' && !next) {
      return res.status(400).json({ error: 'Rating must be up or down' });
    }

    const admin = Boolean(viewer.admin || viewer.staff);

    let video;
    try {
      video = await getVideo(guid);
    } catch {
      return res.status(404).json({ error: 'Not found' });
    }
    if (!video?.guid) return res.status(404).json({ error: 'Not found' });

    const scope = await contentScopeFor(viewer.email, { staff: admin });
    if (!isVideoVisible(scope, video)) return res.status(404).json({ error: 'Not found' });

    if (!admin && !(await isVideoInWindowFor(video.guid, viewer.email))) {
      return res.status(404).json({ error: 'Not found' });
    }

    // One Redis script writes the vote and moves both counters, reading the
    // previous vote inside itself — so a repeated vote is a no-op, two racing
    // clicks cannot both count, and there is no second write left to fail
    // after the first succeeded. See lib/ratingScripts.js.
    const result = await recordRating(viewer.email, guid, next);
    if (!result.ok) return res.status(502).json({ error: result.error });

    return res.json({ ok: true, vote: next });
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}

export default withMonitorApi(handler);
