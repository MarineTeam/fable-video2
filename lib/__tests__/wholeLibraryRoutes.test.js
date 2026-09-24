// The routes that mean "the library" read all of it, not bunny's newest 100.
//
// Before lib/videoLibrary.js each of these asked bunny for page 1 and stopped:
// the admin Videos tab had no row for the 101st video, Analytics counted 100,
// and the homepage and podcast feed applied a viewer's groups and publish
// windows to the newest 100 only — so a group granted an older collection
// could see nothing, and a homepage count above 100 was never honoured.
import { beforeEach, describe, expect, it, vi } from 'vitest';

let library = [];
let homeCount = 48;
// Scope stand-in: when set, only videos in this collection are visible.
let scopeCollection = null;
let savedOrder = null;

vi.mock('../bunny', () => ({
  listVideos: async ({ page = 1, perPage = 100, search = '', collection = '' } = {}) => {
    let items = library;
    if (search) items = items.filter((v) => v.title.toLowerCase().includes(search.toLowerCase()));
    if (collection) items = items.filter((v) => v.collectionId === collection);
    const start = (page - 1) * perPage;
    return { items: items.slice(start, start + perPage), totalItems: items.length };
  },
  getVideo: async () => null,
  thumbnailUrl: () => null,
  isPlayable: (v) => Boolean(v?.guid),
  signedCdnUrl: (path) => `https://vz.b-cdn.net${path}?token=sig`,
  getStatistics: async () => ({}),
  updateVideo: async () => {},
  deleteVideo: async () => {},
}));
vi.mock('../guard', () => ({
  requireViewer: async () => ({ email: 'viewer@example.com', admin: false, staff: false }),
  requireCapability: async () => ({ email: 'admin@example.com' }),
  viewerAccessFor: async () => ({ approved: true, owner: false, staff: false }),
}));
vi.mock('../ratelimit', () => ({ allowRequest: async () => true }));
vi.mock('../redis', () => ({
  k: (name) => `fable2:${name}`,
  redis: () => ({
    get: async (key) => (key === 'fable2:settings:homeCount' ? String(homeCount) : null),
    set: async (key, value) => {
      if (key === 'fable2:order') savedOrder = value;
    },
  }),
}));
vi.mock('../groups', () => ({
  contentScopeFor: async () => scopeCollection,
  filterVideosByScope: (videos, scope) =>
    scope ? videos.filter((v) => v.collectionId === scope) : videos,
  pruneVideoFromGroups: async () => {},
}));
vi.mock('../schedule', () => ({ filterVideosBySchedule: (videos) => videos }));
vi.mock('../scheduleStore', () => ({ loadSchedule: async () => ({}), viewerGroupIds: async () => [] }));
vi.mock('../notesStore', () => ({ loadAllNotes: async () => ({}) }));
vi.mock('../captionsStore', () => ({
  loadAllTranscriptText: async () => ({}),
  matchingTranslatedGuids: async () => [],
}));
vi.mock('../chaptersStore', () => ({ loadAllChapters: async () => ({}) }));
vi.mock('../publicVideosStore', () => ({ loadPublicVideoGuids: async () => new Set() }));
vi.mock('../ratingsStore', () => ({ getRatingCounts: async () => ({}) }));
vi.mock('../videoCleanup', () => ({ forgetVideo: async () => {} }));
vi.mock('../push', () => ({ announceNewVideos: async () => {} }));
vi.mock('../transcriptCollect', () => ({ collectFinishedTranscripts: async () => ({ collected: [] }) }));
vi.mock('../audit', () => ({ logAction: async () => {} }));
vi.mock('../watermark', () => ({
  getVideoModes: async () => ({}),
  setVideoMode: async () => 'default',
  clampWatermarkMode: (m) => m,
}));
vi.mock('../siteNameStore', () => ({ getSiteName: async () => 'Grace Chapel' }));
vi.mock('../appIconStore', () => ({ getAppIconVersion: async () => null }));
vi.mock('../podcastStore', () => ({
  podcastEnabled: () => true,
  emailForFeedToken: async () => 'viewer@example.com',
}));

const videosRoute = (await import('../../pages/api/videos')).default;
const adminVideosRoute = (await import('../../pages/api/admin/videos')).default;
const analyticsRoute = (await import('../../pages/api/admin/analytics')).default;
const feedRoute = (await import('../../pages/api/feed/[token]')).default;
const orderRoute = (await import('../../pages/api/admin/order')).default;

async function call(route, { method = 'GET', query = {}, body = {} } = {}) {
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
    send(payload) {
      out.body = payload;
      return res;
    },
    setHeader: () => res,
    end: () => res,
  };
  await route({ method, query, body, headers: { host: 'portal.example' }, url: '/' }, res);
  return out;
}

// Newest first, as bunny orders them: v1 is the newest.
const makeLibrary = (n, extra = () => ({})) =>
  Array.from({ length: n }, (_, i) => ({
    guid: `v${i + 1}`,
    title: `Talk ${i + 1}`,
    status: 4,
    collectionId: 'recent',
    dateUploaded: new Date(Date.UTC(2026, 0, 1) - i * 86400000).toISOString(),
    views: 1,
    ...extra(i + 1),
  }));

beforeEach(() => {
  library = [];
  homeCount = 48;
  scopeCollection = null;
  savedOrder = null;
});

describe('homepage (/api/videos, no search)', () => {
  it('shows a group its older collection even when 150 newer videos are outside it', async () => {
    library = makeLibrary(160, (n) => (n > 150 ? { collectionId: 'archive' } : {}));
    scopeCollection = 'archive';
    const out = await call(videosRoute);
    expect(out.statusCode).toBe(200);
    expect(out.body.total).toBe(10);
    expect(out.body.videos.map((v) => v.guid)).toContain('v151');
  });

  it('honours a homepage count above 100', async () => {
    library = makeLibrary(180);
    homeCount = 150;
    const out = await call(videosRoute);
    expect(out.body.total).toBe(150);
  });

  it('filters a collection across the whole library', async () => {
    library = makeLibrary(130, (n) => (n > 120 ? { collectionId: 'old' } : {}));
    const out = await call(videosRoute, { query: { collection: 'old' } });
    expect(out.body.total).toBe(10);
    expect(out.body.videos.every((v) => v.collectionId === 'old')).toBe(true);
  });

  it('never calls a plain page truncated', async () => {
    library = makeLibrary(130);
    const out = await call(videosRoute);
    expect(out.body.truncated).toBe(false);
  });
});

describe('search (/api/videos?q=)', () => {
  it('says so when bunny matched more titles than one page returns', async () => {
    library = makeLibrary(140);
    homeCount = 200;
    const out = await call(videosRoute, { query: { q: 'Talk' } });
    expect(out.body.total).toBe(100);
    expect(out.body.truncated).toBe(true);
    expect(out.body.matchedExact).toBe(false);
  });

  it('is not truncated when every title match fits', async () => {
    library = makeLibrary(140);
    homeCount = 200;
    const out = await call(videosRoute, { query: { q: 'Talk 13' } });
    expect(out.body.truncated).toBe(false);
  });
});

describe('admin Videos tab (/api/admin/videos)', () => {
  it('lists every video, past the first 100', async () => {
    library = makeLibrary(230);
    const out = await call(adminVideosRoute);
    expect(out.statusCode).toBe(200);
    expect(out.body.videos).toHaveLength(230);
    expect(out.body.videos.map((v) => v.guid)).toContain('v230');
    expect(out.body.truncated).toBe(false);
  });

  it('reports a library past the read bound', async () => {
    library = makeLibrary(1005);
    const out = await call(adminVideosRoute);
    expect(out.body.videos).toHaveLength(1000);
    expect(out.body.truncated).toBe(true);
  });
});

describe('Analytics (/api/admin/analytics)', () => {
  it('counts views and videos across the whole library', async () => {
    library = makeLibrary(250, (n) => (n === 240 ? { views: 999 } : {}));
    const out = await call(analyticsRoute);
    expect(out.body.videoCount).toBe(250);
    expect(out.body.totalViews).toBe(249 + 999);
    expect(out.body.top[0].guid).toBe('v240');
    expect(out.body.truncated).toBe(false);
  });
});

describe('podcast feed (/api/feed/[token])', () => {
  it('gives a group its older collection instead of an empty feed', async () => {
    library = makeLibrary(160, (n) => (n > 150 ? { collectionId: 'archive' } : {}));
    scopeCollection = 'archive';
    const out = await call(feedRoute, { query: { token: 'tok' } });
    expect(out.statusCode).toBe(200);
    expect(String(out.body)).toContain('/watch/v151');
  });

  it('still bounds the feed by the homepage count', async () => {
    library = makeLibrary(60);
    homeCount = 5;
    const out = await call(feedRoute, { query: { token: 'tok' } });
    expect((String(out.body).match(/<item>/g) || []).length).toBe(5);
  });
});

describe('saved order (/api/admin/order)', () => {
  it('accepts the order of a library larger than 500', async () => {
    const order = makeLibrary(800).map((v) => v.guid);
    const out = await call(orderRoute, { method: 'POST', body: { order } });
    expect(out.statusCode).toBe(200);
    expect(savedOrder).toHaveLength(800);
  });

  it('still refuses an order longer than the library bound', async () => {
    const order = makeLibrary(1001).map((v) => v.guid);
    const out = await call(orderRoute, { method: 'POST', body: { order } });
    expect(out.statusCode).toBe(400);
  });
});
