import { withMonitorApi } from "../../lib/monitor";
import { requireViewer } from '../../lib/guard';
import { allowRequest } from '../../lib/ratelimit';
import { listVideos, getVideo, thumbnailUrl, isPlayable } from '../../lib/bunny';
import { redis, k } from '../../lib/redis';
import { applyOrder } from '../../lib/order';
import { contentScopeFor, filterVideosByScope } from '../../lib/groups';
import { filterVideosBySchedule } from '../../lib/schedule';
import { loadSchedule, viewerGroupIds } from '../../lib/scheduleStore';
import { matchingNoteGuids } from '../../lib/notes';
import { loadAllNotes } from '../../lib/notesStore';
import { matchingTranscriptGuids } from '../../lib/captions';
import { loadAllTranscriptText } from '../../lib/captionsStore';
import { bookIndex, parseReferences } from '../../lib/scripture';

const PAGE_SIZE = 10;

// Cap on how many note- or transcript-only matches are pulled in by guid on a
// single search.
// Each one is a Bunny round trip, and a search that matched a hundred notes
// would be useless to read anyway.
//
// BOTH CAPS ON THIS PATH ARE NOW REPORTED. This one drops note/transcript
// matches beyond 25, and `homeCount` drops results beyond the admin's page
// size; until this was surfaced, a search simply returned fewer videos with
// nothing to say it had stopped early, and `total` described the CAPPED list
// as though it were the whole truth. A viewer whose sermon was match 26 saw a
// search that confidently did not contain it.
const MAX_NOTE_MATCHES = 25;

// "Browse by book" (?index=books) has to see the WHOLE library, and bunny
// hands it over 100 at a time. Bounded here; a library past it is reported
// as truncated rather than counted as if complete.
const INDEX_PAGE_SIZE = 100;
const MAX_INDEX_PAGES = 10;

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
  const [countRaw, orderRaw, scope, schedule, groupIds] = await Promise.all([
    r.get(k('settings:homeCount')).catch(() => null),
    r.get(k('order')).catch(() => null),
    contentScopeFor(viewer.email, { staff }),
    // Staff see unpublished and expired videos so they can find and fix them;
    // for everyone else the window applies. Paired with the /watch/[id] check.
    staff ? Promise.resolve({}) : loadSchedule(),
    // The viewer's groups, for per-group windows (lib/schedule.js).
    staff ? Promise.resolve([]) : viewerGroupIds(viewer.email),
  ]);
  const homeCount = Math.min(Math.max(parseInt(countRaw, 10) || 48, 1), 200);
  const order = Array.isArray(orderRaw) ? orderRaw : [];

  // ?index=books — the books the viewer's library cites, for "Browse by
  // book". A MODE of this route rather than a route of its own: requireViewer
  // above, and the scope and schedule resolved above, are exactly the gate
  // and filters the answer needs, and a second route would be a second copy
  // of them to keep in step. Counted AFTER isPlayable -> scope -> schedule,
  // because a count is itself information ("Philippians (3)" says three
  // videos exist). The homepage asks only when the viewer opens the list, so
  // an ordinary page load costs nothing extra.
  if (req.query.index === 'books') {
    try {
      const all = [];
      let truncated = false;
      for (let p = 1; p <= MAX_INDEX_PAGES; p += 1) {
        const data = await listVideos({ page: p, perPage: INDEX_PAGE_SIZE });
        const items = data?.items || [];
        all.push(...items);
        const totalItems = Number(data?.totalItems) || 0;
        if (items.length < INDEX_PAGE_SIZE || (totalItems && all.length >= totalItems)) break;
        if (p === MAX_INDEX_PAGES) truncated = true;
      }
      const visible = filterVideosBySchedule(
        filterVideosByScope(all.filter(isPlayable), scope),
        schedule,
        Date.now(),
        groupIds
      );
      const notesByGuid = await loadAllNotes();
      const books = bookIndex(visible, (v) => parseReferences(notesByGuid[v.guid] || ''));
      return res.json({ books, truncated });
    } catch {
      return res.status(502).json({ error: 'Could not load the book list' });
    }
  }

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
    // How many note/transcript matches were found but never fetched. Nonzero
    // means the answer below is incomplete in a way only this line knows.
    let unionDropped = 0;
    if (search) {
      const seen = new Set(found.map((v) => v.guid));
      // Notes AND transcripts, as one union. A transcript match is the same
      // shape of claim as a note match — "this video is about that" — so it
      // joins the same list and obeys the same cap, rather than getting its
      // own budget of Bunny round trips.
      const [notesByGuid, transcriptText] = await Promise.all([
        loadAllNotes(),
        loadAllTranscriptText(),
      ]);
      const matched = new Set([
        ...matchingNoteGuids(notesByGuid, search),
        ...matchingTranscriptGuids(transcriptText, search),
      ]);
      const eligible = [...matched].filter((guid) => !seen.has(guid)).sort();
      // Recorded before the slice: once they are gone there is nothing left
      // to notice they were dropped.
      unionDropped = Math.max(0, eligible.length - MAX_NOTE_MATCHES);
      const extraGuids = eligible.slice(0, MAX_NOTE_MATCHES);
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
      schedule,
      Date.now(),
      groupIds
    );
    const ordered = applyOrder(playable, order);
    const capped = ordered.slice(0, homeCount);

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
      // Only meaningful while SEARCHING. On the unfiltered view `homeCount` is
      // the admin's display choice doing exactly what it is for, and calling
      // that "truncated" would put a warning on every ordinary page load.
      truncated: Boolean(search) && (ordered.length > homeCount || unionDropped > 0),
      // What matched, before the display cap. EXACT only when the note union
      // was not cut: the matches dropped there were never fetched, so whether
      // they would have survived the scope and schedule filters is unknown,
      // and claiming a precise total would be inventing one.
      matched: ordered.length,
      matchedExact: unionDropped === 0,
    });
  } catch {
    res.status(502).json({ error: 'Video service unavailable' });
  }
}

export default withMonitorApi(handler);
