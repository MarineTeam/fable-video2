// Passage search in TITLES (pages/api/videos.js).
//
// Titles are searched by bunny as plain text, so "Philippians 2" never found
// a video titled "Phil 2:1-11". For a query that IS a passage, the route now
// reads every title and passage-matches it. These tests use a bunny stand-in
// that behaves like bunny: given `search`, it returns titles that contain the
// text; without it, it pages through the whole library.
import { beforeEach, describe, expect, it, vi } from 'vitest';

let viewer = null;
let library = [];
let listThrowsWithoutSearch = false;
let allowedGuids = null;
let notes = {};
const listCalls = [];

vi.mock('../guard', () => ({ requireViewer: async () => viewer }));
vi.mock('../ratelimit', () => ({ allowRequest: async () => true }));
vi.mock('../bunny', () => ({
  listVideos: async ({ page = 1, perPage = 100, search = '', collection = '' } = {}) => {
    listCalls.push({ page, search });
    if (search) {
      const needle = search.toLowerCase();
      const items = library.filter((v) => v.title.toLowerCase().includes(needle));
      return { items: items.slice(0, perPage), totalItems: items.length };
    }
    if (listThrowsWithoutSearch) throw new Error('bunny down');
    const items = library.filter((v) => !collection || v.collectionId === collection);
    return { items: items.slice((page - 1) * perPage, page * perPage), totalItems: items.length };
  },
  getVideo: async (guid) => library.find((v) => v.guid === guid) || null,
  thumbnailUrl: () => null,
  isPlayable: (v) => Boolean(v?.guid) && v.status !== 'encoding',
}));
vi.mock('../redis', () => ({
  k: (name) => `fable2:${name}`,
  redis: () => ({ get: async () => null }),
}));
vi.mock('../groups', () => ({
  contentScopeFor: async () => null,
  filterVideosByScope: (videos) => (allowedGuids ? videos.filter((v) => allowedGuids.includes(v.guid)) : videos),
}));
vi.mock('../scheduleStore', () => ({ loadSchedule: async () => ({}), viewerGroupIds: async () => [] }));
vi.mock('../notesStore', () => ({ loadAllNotes: async () => notes }));
vi.mock('../captionsStore', () => ({ loadAllTranscriptText: async () => ({}), matchingTranslatedGuids: async () => [] }));

const route = (await import('../../pages/api/videos')).default;

async function call(query) {
  const out = { statusCode: 200, body: undefined };
  const res = {
    status(code) {
      out.statusCode = code;
      return res;
    },
    json(payload) {
      out.body = payload;
      return res;
    },
    setHeader: () => res,
    end: () => res,
    headersSent: false,
  };
  await route({ method: 'GET', query, body: {}, headers: {}, url: '/' }, res);
  return out;
}
const guids = (res) => res.body.videos.map((v) => v.guid);
const vid = (guid, title, extra = {}) => ({ guid, title, length: 10, collectionId: '', ...extra });

beforeEach(() => {
  viewer = { email: 'viewer@example.com', admin: false, staff: false };
  library = [
    vid('humility', 'Phil 2:1-11 — Humility'),
    vid('joy', 'Joy — Php 4:4'),
    vid('harbour', 'Harbour tour'),
  ];
  listThrowsWithoutSearch = false;
  allowedGuids = null;
  notes = {};
  listCalls.length = 0;
});

describe('a passage search reads titles', () => {
  it('finds a title citing the passage in another spelling, and not a neighbouring chapter', async () => {
    expect(guids(await call({ q: 'Philippians 2' }))).toEqual(['humility']);
  });

  it('finds every title citing the book when the book is spelled out', async () => {
    expect(guids(await call({ q: 'philippians' })).sort()).toEqual(['humility', 'joy']);
  });

  it('does not list a video twice when bunny already found its title', async () => {
    library = [vid('p2', 'Philippians 2 study')];
    expect(guids(await call({ q: 'Philippians 2' }))).toEqual(['p2']);
  });

  it('reads the whole library only for a passage query', async () => {
    await call({ q: 'harbour' });
    expect(listCalls.every((c) => c.search)).toBe(true);
    listCalls.length = 0;
    await call({ q: 'Philippians 2' });
    expect(listCalls.some((c) => !c.search)).toBe(true);
  });
});

describe('a title passage match obeys everything else', () => {
  it('is still filtered by group scope', async () => {
    allowedGuids = ['joy', 'harbour'];
    expect(guids(await call({ q: 'Philippians 2' }))).toEqual([]);
  });

  it('is still limited to the requested collection', async () => {
    library = [vid('humility', 'Phil 2:1-11', { collectionId: 'sermons' }), vid('study', 'Phil 2 notes', { collectionId: 'studies' })];
    expect(guids(await call({ q: 'Philippians 2', collection: 'studies' }))).toEqual(['study']);
  });

  it('skips a video that is still encoding', async () => {
    library = [vid('humility', 'Phil 2:1-11', { status: 'encoding' })];
    expect(guids(await call({ q: 'Philippians 2' }))).toEqual([]);
  });
});

describe('when the title scan is incomplete, the search says so', () => {
  it('reports a library too large to read in full as truncated', async () => {
    library = Array.from({ length: 1050 }, (_, i) => vid(`v${i}`, `Talk ${i}`));
    const res = await call({ q: 'Philippians 2' });
    expect(res.body.truncated).toBe(true);
    expect(res.body.matchedExact).toBe(false);
  });

  it('still answers from bunny and notes when the scan fails, and reports it', async () => {
    listThrowsWithoutSearch = true;
    notes = { harbour: 'Text: Philippians 2:5' };
    const res = await call({ q: 'Philippians 2' });
    expect(res.statusCode).toBe(200);
    expect(guids(res)).toEqual(['harbour']);
    expect(res.body.truncated).toBe(true);
  });

  it('claims an exact count when the whole library was read', async () => {
    const res = await call({ q: 'Philippians 2' });
    expect(res.body.truncated).toBe(false);
    expect(res.body.matchedExact).toBe(true);
  });
});

describe('Browse by book counts titles too', () => {
  it('lists a book cited only in a title, and searching that book finds the video', async () => {
    library = [vid('humility', 'Phil 2:1-11 — Humility'), vid('harbour', 'Harbour tour')];
    notes = { harbour: 'John 3:16' };
    const books = (await call({ index: 'books' })).body.books;
    expect(books).toEqual([
      { book: 'John', count: 1 },
      { book: 'Philippians', count: 1 },
    ]);
    // The round trip the homepage makes when a book is clicked.
    expect(guids(await call({ q: 'Philippians' }))).toEqual(['humility']);
  });
});
