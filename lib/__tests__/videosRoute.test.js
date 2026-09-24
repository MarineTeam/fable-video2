// pages/api/videos.js — the two caps on the search path, and saying so.
//
// Search here already reaches the whole library (Bunny searches titles across
// all of it; notes and transcripts join as a union). What it did not do was
// admit when it stopped early. Two caps shorten the answer — 25 note/
// transcript matches, then the admin's homeCount — and `total` described the
// CAPPED list as though it were the whole truth. A viewer whose sermon was
// match 26 saw a search that confidently did not contain it.
import { beforeEach, describe, expect, it, vi } from 'vitest';

let viewer = null;
let allowed = true;
let bunnyItems = [];
let notes = {};
let transcripts = {};
let homeCount = 48;
const fetched = new Map();

vi.mock('../guard', () => ({
  requireViewer: async (req, res) => {
    if (!viewer) {
      res.status(401).json({ error: 'Sign in' });
      return null;
    }
    return viewer;
  },
}));
vi.mock('../ratelimit', () => ({ allowRequest: async () => allowed }));
vi.mock('../bunny', () => ({
  listVideos: async () => ({ items: bunnyItems }),
  getVideo: async (guid) => fetched.get(guid) || null,
  thumbnailUrl: () => 'https://cdn.example/thumb.jpg',
  isPlayable: (v) => Boolean(v?.guid),
}));
vi.mock('../redis', () => ({
  k: (name) => `fable2:${name}`,
  redis: () => ({
    get: async (key) => (key === 'fable2:settings:homeCount' ? String(homeCount) : null),
  }),
}));
vi.mock('../groups', () => ({
  contentScopeFor: async () => null,
  filterVideosByScope: (videos) => videos,
}));
vi.mock('../schedule', () => ({ filterVideosBySchedule: (videos) => videos }));
vi.mock('../scheduleStore', () => ({ loadSchedule: async () => ({}), viewerGroupIds: async () => [] }));
vi.mock('../notesStore', () => ({ loadAllNotes: async () => notes }));
vi.mock('../captionsStore', () => ({ loadAllTranscriptText: async () => transcripts }));

const route = (await import('../../pages/api/videos')).default;

async function call(query = {}) {
  const out = { statusCode: 200, body: undefined };
  const res = {
    status(code) {
      out.statusCode = code;
      return res;
    },
    json(payload) {
      out.body = payload;
      res.headersSent = true;
      return res;
    },
    setHeader: () => res,
    end() {
      res.headersSent = true;
      return res;
    },
    headersSent: false,
  };
  await route({ method: 'GET', query, body: {}, headers: {}, url: '/' }, res);
  return out;
}

const video = (n) => ({ guid: `v${n}`, title: `Video ${n}`, length: 10, collectionId: '' });

beforeEach(() => {
  viewer = { email: 'viewer@example.com', admin: false, staff: false };
  allowed = true;
  bunnyItems = [video(1), video(2)];
  notes = {};
  transcripts = {};
  homeCount = 48;
  fetched.clear();
});

describe('an ordinary, complete search', () => {
  it('reports no truncation', async () => {
    const res = await call({ q: 'video' });
    expect(res.body.truncated).toBe(false);
    expect(res.body.matched).toBe(2);
    expect(res.body.matchedExact).toBe(true);
  });

  it('never calls the unfiltered library view truncated', async () => {
    // homeCount doing its job on a plain page load is not a search stopping
    // early, and warning about it would put a notice on every visit.
    homeCount = 1;
    const res = await call({});
    expect(res.body.truncated).toBe(false);
  });
});

describe('when the display cap cuts the results', () => {
  it('says so, with the true pre-cap count', async () => {
    bunnyItems = Array.from({ length: 5 }, (_, i) => video(i + 1));
    homeCount = 2;
    const res = await call({ q: 'video' });
    expect(res.body.truncated).toBe(true);
    expect(res.body.total).toBe(2);
    expect(res.body.matched).toBe(5);
    expect(res.body.matchedExact).toBe(true);
  });
});

describe('when the note/transcript union cuts matches', () => {
  beforeEach(() => {
    // 30 videos match only by transcript — five more than the union cap.
    bunnyItems = [];
    transcripts = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`t${i}`, 'the anchor watch'])
    );
    for (let i = 0; i < 30; i += 1) fetched.set(`t${i}`, { ...video(i), guid: `t${i}` });
  });

  it('fetches only up to the cap', async () => {
    const res = await call({ q: 'anchor' });
    expect(res.body.matched).toBe(25);
  });

  it('reports truncation, and refuses to claim an exact total', async () => {
    // The five dropped matches were never fetched, so whether they would have
    // survived the scope and schedule filters is unknown. Claiming a precise
    // total here would be inventing one.
    const res = await call({ q: 'anchor' });
    expect(res.body.truncated).toBe(true);
    expect(res.body.matchedExact).toBe(false);
  });
});

describe('the gate still holds', () => {
  it('refuses an unauthenticated caller', async () => {
    viewer = null;
    expect((await call({ q: 'video' })).statusCode).toBe(401);
  });

  it('is rate limited', async () => {
    allowed = false;
    expect((await call({ q: 'video' })).statusCode).toBe(429);
  });
});
