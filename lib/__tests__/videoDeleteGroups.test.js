// Deleting a video — singly or in bulk — clears it from every group that
// granted it. Uploads can now tick a video into groups, and cancelling an
// upload deletes its half-made video through the single-delete route, so
// without this every cancelled upload left a stale guid in those groups.
import { beforeEach, describe, expect, it, vi } from 'vitest';

let pruned = [];
let deleteFails = [];
let forgotten = [];

vi.mock('../groups', () => ({ pruneVideoFromGroups: async (ids) => pruned.push(ids) }));
// The per-video cleanup both paths share (lib/videoCleanup.js).
vi.mock('../videoCleanup', () => ({ forgetVideo: async (id) => forgotten.push(id) }));
vi.mock('../guard', () => ({ requireCapability: async () => 'admin@example.com' }));
vi.mock('../ratelimit', () => ({ allowRequest: async () => true }));
vi.mock('../audit', () => ({ logAction: async () => {} }));
vi.mock('../redis', () => ({
  k: (name) => `fable2:${name}`,
  redis: () => ({ get: async () => null, set: async () => 'OK' }),
}));
vi.mock('../bunny', () => ({
  deleteVideo: async (id) => {
    if (deleteFails.includes(id)) throw new Error('bunny said no');
  },
  updateVideo: async () => {},
  listVideos: async () => ({ items: [] }),
  isPlayable: () => true,
  isFailed: () => false,
  isEncoding: () => false,
  thumbnailUrl: () => null,
  updateVideoTitle: async () => {},
}));
vi.mock('../order', () => ({ applyOrder: (v) => v }));
vi.mock('../scheduleStore', () => ({ loadSchedule: async () => ({}), clearVideoWindow: async () => {} }));
vi.mock('../chaptersStore', () => ({ loadAllChapters: async () => ({}), clearVideoChapters: async () => {} }));
vi.mock('../notesStore', () => ({ loadAllNotes: async () => ({}), clearVideoNotes: async () => {} }));
vi.mock('../captionsStore', () => ({ clearVideoTranscript: async () => {} }));
vi.mock('../publicVideosStore', () => ({ loadPublicVideoGuids: async () => [], clearVideoPublic: async () => {} }));
vi.mock('../ratingsStore', () => ({ clearVideoRatingCounts: async () => {}, getRatingCounts: async () => ({}) }));
vi.mock('../push', () => ({ announceNewVideos: async () => {} }));
vi.mock('../transcriptCollect', () => ({ collectFinishedTranscripts: async () => {} }));
vi.mock('../watermark', () => ({
  getVideoModes: async () => ({}),
  setVideoMode: async () => {},
  clampWatermarkMode: (m) => m,
}));

const single = (await import('../../pages/api/admin/videos')).default;
const bulk = (await import('../../pages/api/admin/videos-bulk')).default;

async function call(route, req) {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = () => res;
  res.end = () => res;
  await route({ headers: {}, query: {}, body: {}, ...req }, res);
  return res;
}

beforeEach(() => {
  pruned = [];
  deleteFails = [];
  forgotten = [];
});

describe('single delete (and so a cancelled upload)', () => {
  it('prunes the deleted video from groups', async () => {
    const res = await call(single, { method: 'DELETE', query: { id: 'vid-1' } });
    expect(res.statusCode).toBe(200);
    expect(pruned).toEqual(['vid-1']);
    expect(forgotten).toEqual(['vid-1']);
  });

  it('prunes nothing when bunny refused the delete', async () => {
    deleteFails = ['vid-1'];
    await call(single, { method: 'DELETE', query: { id: 'vid-1' } });
    expect(pruned).toEqual([]);
    expect(forgotten).toEqual([]);
  });
});

describe('bulk delete', () => {
  it('prunes only the videos that were actually deleted', async () => {
    deleteFails = ['b'];
    await call(bulk, { method: 'POST', body: { action: 'delete', ids: ['a', 'b', 'c'] } });
    expect(pruned).toHaveLength(1);
    expect([...pruned[0]].sort()).toEqual(['a', 'c']);
  });
});
