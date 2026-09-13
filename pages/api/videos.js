import { withMonitorApi } from "../../lib/monitor";
import { requireViewer } from '../../lib/guard';
import { allowRequest } from '../../lib/ratelimit';
import { listVideos, getVideo, thumbnailUrl, isPlayable } from '../../lib/bunny';
import { redis, k } from '../../lib/redis';
import { applyOrder } from '../../lib/order';
import { contentScopeFor, filterVideosByScope } from '../../lib/groups';
import { filterVideosBySchedule } from '../../lib/schedule';
import { loadSchedule } from '../../lib/scheduleStore';
import { matchingNoteGuids } from '../../lib/notes';
import { loadAllNotes } from '../../lib/notesStore';

const PAGE_SIZE = 10;

// Cap on how many note-only matches are pulled in by guid on a single search.
// Each one is a Bunny round trip, and a search that matched a hundred notes
// would be useless to read anyway.
const MAX_NOTE_MATCHES = 25;

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const viewer = await requireViewer(req, res);
  if (!viewer) return;
  if (!(await allowRequest('videos', viewer.email, 60, 60))) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  const search = String(req.query.q || '').slice(0, 100);
  const collection = String(req.query.collection || '').slice(0, 64);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  const r = redis();
  // Group content scope. Inert (always "unrestricted") unless
  // GROUP_CONTENT_GATING=1, and always unrestricted for staff — see
  // lib/groups.js. This is one of the three enforcement points that have to
  // agree; the others are /api/collections and the /watch/[id] GSSP.
  const staff = viewer.admin || viewer.staff;
  const [countRaw, orderRaw, scope, schedule] = await Promise.all([
    r.get(k('settings:homeCount')).catch(() => null),
    r.get(k('order')).catch(() => null),
    contentScopeFor(viewer.email, { staff }),
    // Staff see unpublished and expired videos so they can find and fix them;
    // for everyone else the window applies. Paired with the /watch/[id] check.
    staff ? Promise.resolve({}) : loadSchedule(),
  ]);
  const homeCount = Math.min(Math.max(parseInt(countRaw, 10) || 48, 1), 200);
  const order = Array.isArray(orderRaw) ? orderRaw : [];

  try {
    // Title search stays server-side at Bunny, which searches the WHOLE
    // library. Dropping it to filter locally would only ever see the first
    // page (<=100), silently regressing search for a large library — so notes
    // are added as a UNION instead: Bunny's title matches, plus the videos
    // whose notes match, fetched by guid.
    //
    // Access is unaffected by any of this. Every candidate, however it got
    // here, goes through exactly the same isPlayable -> group scope ->
    // publish window pipeline below, so widening the search can never widen
    // what a given viewer is allowed to see.
    const data = await listVideos({ page: 1, perPage: Math.min(homeCount, 100), search, collection });
    const found = (data?.items || []).filter(isPlayable);

    let candidates = found;
    if (search) {
      const seen = new Set(found.map((v) => v.guid));
      const extraGuids = matchingNoteGuids(await loadAllNotes(), search)
        .filter((guid) => !seen.has(guid))
        .slice(0, MAX_NOTE_MATCHES);
      if (extraGuids.length) {
        const fetched = await Promise.all(
          // A video whose note record outlived the video itself simply drops
          // out — a stale note must not break the whole search.
          extraGuids.map((guid) => getVideo(guid).catch(() => null))
        );
        candidates = found.concat(fetched.filter((v) => v?.guid && isPlayable(v)));
      }
      // A note match for a video outside the requested collection would
      // quietly widen a collection filter, so honour it here too.
      if (collection) {
        candidates = candidates.filter((v) => (v.collectionId || '') === collection);
      }
    }

    const playable = filterVideosBySchedule(
      filterVideosByScope(candidates, scope),
      schedule
    );
    const capped = applyOrder(playable, order).slice(0, homeCount);

    const start = (page - 1) * PAGE_SIZE;
    const videos = capped.slice(start, start + PAGE_SIZE).map((v) => ({
      guid: v.guid,
      title: v.title,
      length: v.length || 0,
      collectionId: v.collectionId || '',
      thumbnail: thumbnailUrl(v),
    }));
    res.json({
      videos,
      total: capped.length,
      page,
      pages: Math.max(1, Math.ceil(capped.length / PAGE_SIZE)),
    });
  } catch {
    res.status(502).json({ error: 'Video service unavailable' });
  }
}

export default withMonitorApi(handler);
