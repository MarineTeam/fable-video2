// pages/api/videos.js?index=books — "Browse by book".
//
// A count is information ("Philippians (3)" says three videos exist), so the
// properties that matter are: it is counted AFTER playable -> scope ->
// schedule, over the WHOLE library (bunny pages it 100 at a time), and a
// library past the page bound is reported as truncated, not counted as if
// complete.
import { beforeEach, describe, expect, it, vi } from 'vitest';

let viewer = null;
let library = [];
let hidden = new Set();
let notes = {};
let pagesAsked = [];
let bunnyThrows = false;

vi.mock('../guard', () => ({
  requireViewer: async (req, res) => {
    if (!viewer) {
      res.status(401).json({ error: 'Sign in' });
      return null;
    }
    return viewer;
  },
}));
vi.mock('../ratelimit', () => ({ allowRequest: async () => true }));
vi.mock('../bunny', () => ({
  listVideos: async ({ page, perPage }) => {
    if (bunnyThrows) throw new Error('bunny down');
    pagesAsked.push(page);
    const start = (page - 1) * perPage;
    return { items: library.slice(start, start + perPage), totalItems: library.length };
  },
  getVideo: async () => null,
  thumbnailUrl: () => null,
  isPlayable: (v) => v.status === 4,
}));
vi.mock('../redis', () => ({ k: (n) => `fable2:${n}`, redis: () => ({ get: async () => null }) }));
vi.mock('../groups', () => ({
  contentScopeFor: async () => 'scope',
  filterVideosByScope: (videos) => videos.filter((v) => !hidden.has(v.guid)),
}));
vi.mock('../schedule', () => ({ filterVideosBySchedule: (videos) => videos }));
vi.mock('../scheduleStore', () => ({ loadSchedule: async () => ({}), viewerGroupIds: async () => [] }));
vi.mock('../notesStore', () => ({ loadAllNotes: async () => notes }));
vi.mock('../captionsStore', () => ({ loadAllTranscriptText: async () => ({}) }));

const route = (await import('../../pages/api/videos')).default;

async function books() {
  const out = { statusCode: 200, body: undefined };
  const res = {
    status(c) { out.statusCode = c; return res; },
    json(b) { out.body = b; return res; },
    setHeader: () => res,
    end: () => res,
  };
  await route({ method: 'GET', query: { index: 'books' }, headers: {} }, res);
  return out;
}

const video = (guid, status = 4) => ({ guid, title: guid, status });

beforeEach(() => {
  viewer = { email: 'viewer@example.com', admin: false, staff: false };
  library = [video('a'), video('b'), video('c'), video('enc', 1)];
  hidden = new Set();
  pagesAsked = [];
  bunnyThrows = false;
  notes = { a: 'Phil 2:1-11', b: 'Php 4:4; John 3', c: 'no passage', enc: 'Romans 8' };
});

describe('?index=books', () => {
  it('counts videos per book from the notes, in Bible order', async () => {
    const res = await books();
    expect(res.body).toEqual({
      books: [
        { book: 'John', count: 1 },
        { book: 'Philippians', count: 2 },
      ],
      truncated: false,
    });
  });

  it('counts nothing for a video the scope hides, or one still encoding', async () => {
    hidden = new Set(['a']);
    const res = await books();
    expect(res.body.books).toEqual([
      { book: 'John', count: 1 },
      { book: 'Philippians', count: 1 },
    ]);
    expect(res.body.books.some((b) => b.book === 'Romans')).toBe(false);
  });

  it('pages through the whole library, not just the first page', async () => {
    library = Array.from({ length: 250 }, (_, i) => video(`v${i}`));
    notes = { v249: 'Jude 3' };
    const res = await books();
    expect(pagesAsked).toEqual([1, 2, 3]);
    expect(res.body.books).toEqual([{ book: 'Jude', count: 1 }]);
  });

  it('reports a library past the page bound as truncated', async () => {
    library = Array.from({ length: 1001 }, (_, i) => video(`v${i}`));
    notes = {};
    const res = await books();
    expect(pagesAsked).toHaveLength(10);
    expect(res.body.truncated).toBe(true);
  });

  it('refuses an anonymous caller before touching bunny', async () => {
    viewer = null;
    expect((await books()).statusCode).toBe(401);
    expect(pagesAsked).toEqual([]);
  });

  it('502s when bunny fails, rather than answering with a short list', async () => {
    bunnyThrows = true;
    expect((await books()).statusCode).toBe(502);
  });
});
