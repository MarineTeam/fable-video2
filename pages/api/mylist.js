import { withMonitorApi } from '../../lib/monitor';
import { requireViewer } from '../../lib/guard';
import { oneTrimmed } from '../../lib/params';
import { allowRequest } from '../../lib/ratelimit';
import { contentScopeFor, isVideoVisible } from '../../lib/groups';
import { isWithinWindow } from '../../lib/schedule';
import { getVideoWindow } from '../../lib/scheduleStore';
import { getVideo } from '../../lib/bunny';
import { getMyList, removeFromMyList, saveToMyList } from '../../lib/mylistStore';
import { isFull, listIds, MAX_ITEMS } from '../../lib/mylist';

// The viewer's own saved queue.
//
//   GET     -> { ids: [...] }   saved video ids, newest saved first
//   POST    -> { guid }         save one
//   DELETE  -> ?guid=...        unsave one
//
// Per-viewer data, so the email comes from the SESSION and this route takes no
// email parameter at all — a stronger guarantee than validating one, because
// there is no input that could name another person.
//
// SAVING IS GATED LIKE WATCHING. Without it a restricted viewer could pin a
// guid they cannot see: it would be filtered out of every read, but the write
// would have succeeded, and a 200 is itself an answer to "does this exist?".
// The gate has to match pages/watch/[id].js, and in THIS repo that means
// fetching the video — isVideoVisible reads its collection, so an id alone
// cannot answer the question.
//
// GET deliberately returns IDS ONLY, not video objects. The homepage already
// holds the library it is allowed to see; handing it ids lets it intersect,
// which means a saved video that has since left the viewer's scope simply
// matches nothing rather than needing to be filtered out again here.
const GUID = /^[0-9a-f-]{10,64}$/i;

async function handler(req, res) {
  const viewer = await requireViewer(req, res);
  if (!viewer) return;

  if (req.method === 'GET') {
    return res.json({ ids: listIds(await getMyList(viewer.email)), max: MAX_ITEMS });
  }

  if (req.method === 'POST' || req.method === 'DELETE') {
    // Seconds as a NUMBER — this repo's allowRequest builds `${n} s`. A
    // viewer write path rather than an admin one: cheap per call, unbounded
    // in aggregate, reachable by anyone approved.
    if (!(await allowRequest('mylist', viewer.email, 120, 3600))) {
      return res.status(429).json({ error: 'Too many changes — try again shortly' });
    }

    const guid = req.method === 'POST' ? oneTrimmed(req.body?.guid) : oneTrimmed(req.query.guid);
    if (!guid || !GUID.test(guid)) return res.status(400).json({ error: 'Bad video id' });

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

    if (!admin && !isWithinWindow(await getVideoWindow(video.guid))) {
      return res.status(404).json({ error: 'Not found' });
    }

    if (req.method === 'DELETE') {
      const result = await removeFromMyList(viewer.email, guid);
      if (!result.ok) return res.status(502).json({ error: result.error });
      return res.json({ ok: true, saved: false });
    }

    // Checked before the write so a full list is a clear refusal rather than
    // a silent drop. Re-saving something already present is free.
    if (isFull(await getMyList(viewer.email), guid)) {
      return res
        .status(409)
        .json({ error: `Your list is full (${MAX_ITEMS}). Remove something first.` });
    }
    const result = await saveToMyList(viewer.email, guid);
    if (!result.ok) return res.status(502).json({ error: result.error });
    return res.json({ ok: true, saved: true });
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}

export default withMonitorApi(handler);
