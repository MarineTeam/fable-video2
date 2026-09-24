// pages/api/videos.js with REAL publish-window filtering: a group's own
// window shows a video to that group's members before everyone else, the
// weekly repeat hides it between slots, and staff skip both.
import { beforeEach, describe, expect, it, vi } from 'vitest';

let viewer = null;
let schedule = {};
let groupIds = [];
const groupReads = [];
const bunnyItems = [{ guid: 'early', title: 'Early', length: 10, collectionId: '' }, { guid: 'plain', title: 'Plain', length: 10, collectionId: '' }];

vi.mock('../guard', () => ({ requireViewer: async () => viewer }));
vi.mock('../ratelimit', () => ({ allowRequest: async () => true }));
vi.mock('../bunny', () => ({
  listVideos: async () => ({ items: bunnyItems }),
  getVideo: async () => null,
  thumbnailUrl: () => 'https://cdn.example/thumb.jpg',
  isPlayable: (v) => Boolean(v?.guid),
}));
vi.mock('../redis', () => ({
  k: (name) => `fable2:${name}`,
  redis: () => ({ get: async () => null }),
}));
vi.mock('../groups', () => ({
  contentScopeFor: async () => null,
  filterVideosByScope: (videos) => videos,
}));
vi.mock('../scheduleStore', () => ({
  loadSchedule: async () => schedule,
  viewerGroupIds: async (email) => {
    groupReads.push(email);
    return groupIds;
  },
}));
vi.mock('../notesStore', () => ({ loadAllNotes: async () => ({}) }));
vi.mock('../captionsStore', () => ({ loadAllTranscriptText: async () => ({}) }));

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

const guids = (res) => res.body.videos.map((v) => v.guid);
const future = '2099-01-01T00:00:00.000Z';
const past = '2020-01-01T00:00:00.000Z';

beforeEach(() => {
  viewer = { email: 'leader@example.com', admin: false, staff: false };
  schedule = { early: { from: future, until: null, groups: { 'youth-x1': { from: past, until: null } } } };
  groupIds = [];
  groupReads.length = 0;
});

describe('the library with per-group windows', () => {
  it("shows the video to a member of the group, during the group's window", async () => {
    groupIds = ['youth-x1'];
    expect(guids(await call())).toEqual(['early', 'plain']);
    expect(groupReads).toEqual(['leader@example.com']);
  });

  it('hides it from everyone else until the default window opens', async () => {
    groupIds = ['choir-z9'];
    expect(guids(await call())).toEqual(['plain']);
  });

  it('hides it between weekly slots — the repeat narrows the default window', async () => {
    // A one-minute slot on TOMORROW's weekday (UTC), so it is never now.
    const tomorrow = (new Date().getUTCDay() + 1) % 7;
    schedule = { early: { from: null, until: null, repeat: { days: [tomorrow], start: '00:00', end: '00:01', timeZone: 'UTC' } } };
    expect(guids(await call())).toEqual(['plain']);
  });

  it('shows staff everything without reading their groups', async () => {
    viewer = { email: 'admin@example.com', admin: true, staff: true };
    expect(guids(await call())).toEqual(['early', 'plain']);
    expect(groupReads).toEqual([]);
  });
});
