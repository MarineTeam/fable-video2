// pages/api/admin/videos-bulk.js delete: the videos bunny actually deleted —
// and only those — are forgotten with the same cleanup as a single delete.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const forgotten = [];
let deleteFails = [];
vi.mock('../guard', () => ({
  requireCapability: async () => 'admin@example.com',
  requireActor: async () => ({ email: 'admin@example.com', owner: true, capabilities: [], staff: true, staffScope: null }),
}));
vi.mock('../ratelimit', () => ({ allowRequest: async () => true }));
vi.mock('../audit', () => ({ logAction: async () => {} }));
vi.mock('../groups', () => ({ pruneVideoFromGroups: async () => {} }));
vi.mock('../redis', () => ({ k: (n) => `fable2:${n}`, redis: () => ({ get: async () => null, set: async () => 'OK' }) }));
vi.mock('../bunny', () => ({
  deleteVideo: async (id) => {
    if (deleteFails.includes(id)) throw new Error('bunny said no');
  },
  updateVideo: async () => {},
}));
vi.mock('../videoCleanup', () => ({ forgetVideo: async (id) => forgotten.push(id) }));

const route = (await import('../../pages/api/admin/videos-bulk')).default;

async function bulk(body) {
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
  };
  await route({ method: 'POST', body, query: {}, headers: {} }, res);
  return out;
}

beforeEach(() => {
  forgotten.length = 0;
  deleteFails = [];
});

describe('bulk delete forgets what it deleted', () => {
  it('runs the per-video cleanup for each video bunny deleted, and only those', async () => {
    deleteFails = ['v2'];
    await bulk({ action: 'delete', ids: ['v1', 'v2', 'v3'] });
    expect(forgotten.sort()).toEqual(['v1', 'v3']);
  });

  it('forgets nothing on a collection move', async () => {
    await bulk({ action: 'assign-collection', ids: ['v1'], collectionId: 'c1' });
    expect(forgotten).toEqual([]);
  });
});
