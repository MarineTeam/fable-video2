// POST /api/progress — what a viewer's player may write. Before these checks
// the route took any string up to 100 characters as a video id, with no rate
// limit, so a signed-in viewer could grow their own progress hash without
// bound. The hash's own cap is proved on a real Redis in progressStore.redis.
import { beforeEach, describe, expect, it, vi } from 'vitest';

let allowed = true;
const saved = [];

vi.mock('../guard', () => ({ requireViewer: async () => ({ email: 'jane@example.com' }) }));
vi.mock('../ratelimit', () => ({ allowRequest: async () => allowed }));
vi.mock('../redis', () => ({ k: (n) => `fable2:${n}`, redis: () => ({ hgetall: async () => ({}) }) }));
vi.mock('../progressStore', () => ({
  saveProgress: async (email, videoId, entry) => {
    saved.push([email, videoId, entry]);
  },
}));

const route = (await import('../../pages/api/progress')).default;

async function post(body) {
  const out = { statusCode: 200, body: undefined };
  const res = {
    status(c) {
      out.statusCode = c;
      return res;
    },
    json(b) {
      out.body = b;
      return res;
    },
    setHeader: () => res,
  };
  await route({ method: 'POST', body, query: {}, headers: {} }, res);
  return out;
}

beforeEach(() => {
  allowed = true;
  saved.length = 0;
});

describe('POST /api/progress', () => {
  it('saves a position for a real-looking video id', async () => {
    const res = await post({ videoId: '0a1b2c3d-0000-4000-8000-000000000001', seconds: 30.7, duration: 600, title: 'Sunday' });
    expect(res.statusCode).toBe(200);
    expect(saved).toHaveLength(1);
    expect(saved[0][0]).toBe('jane@example.com');
    expect(saved[0][2]).toMatchObject({ seconds: 30, duration: 600, title: 'Sunday' });
  });

  it('is rate limited, and saves nothing when it is', async () => {
    allowed = false;
    expect((await post({ videoId: 'vid-1', seconds: 1, duration: 10 })).statusCode).toBe(429);
    expect(saved).toEqual([]);
  });

  it('refuses an id that is not a video id', async () => {
    for (const videoId of ['has space', 'x/../y', 'a'.repeat(65), ['vid-1'], 5]) {
      expect((await post({ videoId, seconds: 1, duration: 10 })).statusCode, String(videoId)).toBe(400);
    }
    expect(saved).toEqual([]);
  });

  it('still refuses a bad position', async () => {
    expect((await post({ videoId: 'vid-1', seconds: -1, duration: 10 })).statusCode).toBe(400);
    expect((await post({ videoId: 'vid-1', seconds: 1, duration: 0 })).statusCode).toBe(400);
  });
});
