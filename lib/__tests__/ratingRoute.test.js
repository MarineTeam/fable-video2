// pages/api/rating.js — the gate, and what the counters are told.
//
// Three properties are worth pinning because losing any of them is silent:
// rating cannot be used to probe outside your scope; a repeated vote does not
// inflate the total; and a counter failure never costs the viewer their vote.
// The arithmetic itself lives in lib/__tests__/ratings.test.js.
import { beforeEach, describe, expect, it, vi } from 'vitest';

let viewer = null;
let stored = {};
let allowed = true;
let video = null;
let scope = null;
let visible = true;
let window_ = null;

const setRating = vi.fn(async (email, guid, vote) => {
  stored[guid] = vote;
  return { ok: true, vote };
});
const clearRating = vi.fn(async (email, guid) => {
  delete stored[guid];
  return { ok: true, vote: null };
});
const applyRatingCounts = vi.fn(async () => {});

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
  getVideo: async (guid) => {
    if (!video) throw new Error('not found');
    return { ...video, guid };
  },
}));
vi.mock('../groups', () => ({
  contentScopeFor: async () => scope,
  isVideoVisible: () => visible,
}));
vi.mock('../scheduleStore', () => ({ getVideoWindow: async () => window_ }));
vi.mock('../ratingsStore', () => ({
  getRatings: async () => stored,
  setRating: (...a) => setRating(...a),
  clearRating: (...a) => clearRating(...a),
  applyRatingCounts: (...a) => applyRatingCounts(...a),
}));

const route = (await import('../../pages/api/rating')).default;

const GUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

async function call({ method = 'POST', body = {}, query = {} } = {}) {
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
  await route({ method, body, query, headers: {}, url: '/' }, res);
  return out;
}

const post = (body) => call({ method: 'POST', body });

beforeEach(() => {
  viewer = { email: 'viewer@example.com', admin: false, staff: false };
  stored = {};
  allowed = true;
  video = { title: 'One' };
  scope = null;
  visible = true;
  window_ = null;
  setRating.mockClear();
  clearRating.mockClear();
  applyRatingCounts.mockClear();
});

describe('who may rate', () => {
  it('refuses a caller with no viewer session', async () => {
    viewer = null;
    expect((await post({ guid: GUID, vote: 'up' })).statusCode).toBe(401);
    expect(setRating).not.toHaveBeenCalled();
  });

  it('refuses a video outside the viewer’s group scope, as 404', async () => {
    // 404 and not 403: a rating must not become a way to learn which guids
    // exist. Same answer the watch page gives.
    visible = false;
    expect((await post({ guid: GUID, vote: 'up' })).statusCode).toBe(404);
    expect(setRating).not.toHaveBeenCalled();
  });

  it('refuses a video outside its publish window, but not for staff', async () => {
    window_ = { from: '2099-01-01T00:00:00.000Z', until: null };
    expect((await post({ guid: GUID, vote: 'up' })).statusCode).toBe(404);
    viewer = { email: 'admin@example.com', admin: true, staff: true };
    expect((await post({ guid: GUID, vote: 'up' })).statusCode).toBe(200);
  });

  it('refuses a video bunny does not have', async () => {
    video = null;
    expect((await post({ guid: GUID, vote: 'up' })).statusCode).toBe(404);
  });

  it('is rate limited', async () => {
    allowed = false;
    expect((await post({ guid: GUID, vote: 'up' })).statusCode).toBe(429);
    expect(setRating).not.toHaveBeenCalled();
  });

  it('takes no email parameter — the session decides whose rating this is', async () => {
    await post({ guid: GUID, vote: 'up', email: 'someone@else.com' });
    expect(setRating.mock.calls[0][0]).toBe('viewer@example.com');
  });
});

describe('voting', () => {
  it('stores a first vote and tells the counters about it once', async () => {
    const res = await post({ guid: GUID, vote: 'up' });
    expect(res.body).toEqual({ ok: true, vote: 'up' });
    expect(applyRatingCounts).toHaveBeenCalledWith({ [`${GUID}:up`]: 1 });
  });

  it('moves the count across when the vote changes', async () => {
    stored = { [GUID]: 'up' };
    await post({ guid: GUID, vote: 'down' });
    expect(applyRatingCounts).toHaveBeenCalledWith({
      [`${GUID}:up`]: -1,
      [`${GUID}:down`]: 1,
    });
  });

  it('does NOT double-count a repeated vote', async () => {
    stored = { [GUID]: 'up' };
    const res = await post({ guid: GUID, vote: 'up' });
    expect(res.body).toEqual({ ok: true, vote: 'up' });
    expect(setRating).not.toHaveBeenCalled();
    expect(applyRatingCounts).not.toHaveBeenCalled();
  });

  it('clears a vote on DELETE and takes the count back', async () => {
    stored = { [GUID]: 'down' };
    const res = await call({ method: 'DELETE', query: { guid: GUID } });
    expect(res.body).toEqual({ ok: true, vote: null });
    expect(applyRatingCounts).toHaveBeenCalledWith({ [`${GUID}:down`]: -1 });
  });

  it('refuses a vote that is neither up nor down', async () => {
    expect((await post({ guid: GUID, vote: 'sideways' })).statusCode).toBe(400);
    expect(setRating).not.toHaveBeenCalled();
  });

  it('refuses a malformed guid before anything else', async () => {
    expect((await post({ guid: 'nope', vote: 'up' })).statusCode).toBe(400);
  });
});

describe('reading your own rating', () => {
  it('returns it, and null when there is none, and nothing else', async () => {
    stored = { [GUID]: 'up' };
    let res = await call({ method: 'GET', query: { guid: GUID } });
    expect(res.body).toEqual({ vote: 'up' });
    expect(Object.keys(res.body)).toEqual(['vote']);
    stored = {};
    res = await call({ method: 'GET', query: { guid: GUID } });
    expect(res.body).toEqual({ vote: null });
  });
});

describe('shape', () => {
  it('rejects an unsupported method', async () => {
    expect((await call({ method: 'PUT', query: { guid: GUID } })).statusCode).toBe(405);
  });
});
