// pages/api/rating.js — the gate, and what the counters are told.
//
// Two properties are worth pinning because losing either is silent: rating
// cannot be used to probe outside your scope, and the vote goes to storage as
// ONE call (recordRating, a single Redis script), so there is no second write
// for the totals to drift on. The arithmetic is in ratings.test.js and,
// against a real Redis, ratingScripts.test.js.
import { beforeEach, describe, expect, it, vi } from 'vitest';

let viewer = null;
let stored = {};
let allowed = true;
let video = null;
let scope = null;
let visible = true;
let window_ = null;

let recordFails = false;

// Stands in for the Redis script. The script's own arithmetic is proved
// against a real redis-server in ratingScripts.test.js; here only the route's
// side matters — what it asks for, and what it tells the viewer.
const recordRating = vi.fn(async (email, guid, vote) => {
  if (recordFails) return { ok: false, error: 'Could not save your rating' };
  if (vote) stored[guid] = vote;
  else delete stored[guid];
  return { ok: true, vote, changed: true };
});

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
vi.mock('../scheduleStore', async () => {
  const { isWithinWindow } = await vi.importActual('../schedule');
  return { isVideoInWindowFor: async () => isWithinWindow(window_) };
});
vi.mock('../ratingsStore', () => ({
  getRatings: async () => stored,
  recordRating: (...a) => recordRating(...a),
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
  recordFails = false;
  recordRating.mockClear();
});

describe('who may rate', () => {
  it('refuses a caller with no viewer session', async () => {
    viewer = null;
    expect((await post({ guid: GUID, vote: 'up' })).statusCode).toBe(401);
    expect(recordRating).not.toHaveBeenCalled();
  });

  it('refuses a video outside the viewer’s group scope, as 404', async () => {
    // 404 and not 403: a rating must not become a way to learn which guids
    // exist. Same answer the watch page gives.
    visible = false;
    expect((await post({ guid: GUID, vote: 'up' })).statusCode).toBe(404);
    expect(recordRating).not.toHaveBeenCalled();
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
    expect(recordRating).not.toHaveBeenCalled();
  });

  it('takes no email parameter — the session decides whose rating this is', async () => {
    await post({ guid: GUID, vote: 'up', email: 'someone@else.com' });
    expect(recordRating.mock.calls[0][0]).toBe('viewer@example.com');
  });
});

describe('voting', () => {
  it('records a vote in one call, with the session’s email', async () => {
    const res = await post({ guid: GUID, vote: 'up' });
    expect(res.body).toEqual({ ok: true, vote: 'up' });
    expect(recordRating).toHaveBeenCalledTimes(1);
    expect(recordRating).toHaveBeenCalledWith('viewer@example.com', GUID, 'up');
  });

  it('normalizes the vote before it reaches storage', async () => {
    await post({ guid: GUID, vote: ' DOWN ' });
    expect(recordRating).toHaveBeenCalledWith('viewer@example.com', GUID, 'down');
  });

  // The route no longer decides 'is this a repeat?' itself — that read lives
  // inside the script now, which is what stops two racing clicks both
  // counting. So a repeat is passed through, and the script answers no-op.
  it('leaves the repeat decision to the script rather than reading first', async () => {
    stored = { [GUID]: 'up' };
    const res = await post({ guid: GUID, vote: 'up' });
    expect(res.body).toEqual({ ok: true, vote: 'up' });
    expect(recordRating).toHaveBeenCalledTimes(1);
  });

  it('clears a vote on DELETE by recording null', async () => {
    stored = { [GUID]: 'down' };
    const res = await call({ method: 'DELETE', query: { guid: GUID } });
    expect(res.body).toEqual({ ok: true, vote: null });
    expect(recordRating).toHaveBeenCalledWith('viewer@example.com', GUID, null);
    expect(stored).toEqual({});
  });

  it('reports a failed write instead of claiming the vote stood', async () => {
    recordFails = true;
    const res = await post({ guid: GUID, vote: 'up' });
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: 'Could not save your rating' });
  });

  it('refuses a vote that is neither up nor down', async () => {
    expect((await post({ guid: GUID, vote: 'sideways' })).statusCode).toBe(400);
    expect(recordRating).not.toHaveBeenCalled();
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
