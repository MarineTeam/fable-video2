// The WHOLE video library, not bunny's first page of it.
//
// bunny hands videos over at most 100 a page. A route that asks for page 1
// and stops sees the newest 100 and nothing else, and it fails silently: the
// admin Videos tab simply had no row for the 101st video, Analytics counted
// views on 100 of them, and the homepage and podcast feed filtered a viewer's
// groups and publish windows over the newest 100 — so a group granted an older
// collection could see nothing at all. Every list that means "the library"
// reads it through here instead.
//
// Bounded, and honest about the bound: past MAX_LIBRARY_PAGES pages the answer
// comes back with truncated: true, for the caller to say so rather than
// present a partial library as the whole one.
//
// Pages after the first are fetched in parallel — the first page carries the
// total, so the rest are known up front. A video uploaded between two page
// reads can push another across a page boundary, so results are de-duplicated
// by guid; the next load sees the library settled.
import { listVideos } from './bunny';

export const LIBRARY_PAGE_SIZE = 100;
export const MAX_LIBRARY_PAGES = 10;
// The most videos a whole-library read returns. Also the most a saved custom
// order may hold (pages/api/admin/order.js), since the Videos tab saves the
// order of exactly the list this returns.
export const MAX_LIBRARY_VIDEOS = LIBRARY_PAGE_SIZE * MAX_LIBRARY_PAGES;

const itemsOf = (data) => (Array.isArray(data?.items) ? data.items : []);

function unique(videos) {
  const seen = new Set();
  return videos.filter((v) => {
    if (!v?.guid || seen.has(v.guid)) return false;
    seen.add(v.guid);
    return true;
  });
}

// Returns { videos, truncated, total } — `total` is bunny's count of the whole
// library when it gave one, else how many were read. Throws if the FIRST page
// cannot be read — there is no library to answer with — and likewise if a
// later page fails, because a library quietly missing a page is the failure
// this exists to end.
export async function listAllVideos() {
  const first = await listVideos({ page: 1, perPage: LIBRARY_PAGE_SIZE });
  const all = [...itemsOf(first)];
  const total = Number(first?.totalItems) || 0;

  if (total > 0) {
    const needed = Math.ceil(total / LIBRARY_PAGE_SIZE);
    const pages = Math.min(needed, MAX_LIBRARY_PAGES);
    const rest = await Promise.all(
      Array.from({ length: Math.max(0, pages - 1) }, (_, i) =>
        listVideos({ page: i + 2, perPage: LIBRARY_PAGE_SIZE })
      )
    );
    for (const data of rest) all.push(...itemsOf(data));
    const videos = unique(all);
    return { videos, truncated: needed > MAX_LIBRARY_PAGES, total: Math.max(total, videos.length) };
  }

  // No total in the reply: walk pages until a short one arrives.
  let last = itemsOf(first);
  let page = 1;
  while (last.length === LIBRARY_PAGE_SIZE && page < MAX_LIBRARY_PAGES) {
    page += 1;
    last = itemsOf(await listVideos({ page, perPage: LIBRARY_PAGE_SIZE }));
    all.push(...last);
  }
  const videos = unique(all);
  return { videos, truncated: last.length === LIBRARY_PAGE_SIZE, total: videos.length };
}
