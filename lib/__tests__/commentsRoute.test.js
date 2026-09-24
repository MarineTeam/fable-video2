// pages/api/comments.js — who may read, write and delete comments.
//
// Gated like watching (the video must exist and be in the viewer's group
// scope; the publish window for reading and writing, staff exempt). The author
// is always the SESSION; other viewers never see an email; removing someone
// else's comment needs comments.manage (or ownership) and is audited.
import { beforeEach, describe, expect, it, vi } from 'vitest';

let viewer = null;
let actor = { owner: false, capabilities: [] };
let videoExists = true;
let visible = true;
let live = true;
let allowed = true;
let profileName = 'Bob Jones';
let store = {};
let full = false;
const audit = [];
const GUID = 'abcdef12-3456';

vi.mock('../guard', () => ({
  requireViewer: async (req, res) => {
    if (!viewer) {
      res.status(401).json({ error: 'Not signed in' });
      return null;
    }
    return viewer;
  },
  resolveActor: async (email) => ({ email, ...actor }),
}));
vi.mock('../bunny', () => ({ getVideo: async (guid) => (videoExists ? { guid, collectionId: '' } : null) }));
vi.mock('../groups', () => ({ contentScopeFor: async () => ({}), isVideoVisible: () => visible }));
vi.mock('../scheduleStore', () => ({ isVideoInWindowFor: async () => live }));
vi.mock('../ratelimit', () => ({ allowRequest: async () => allowed }));
vi.mock('../audit', () => ({ logAction: async (...a) => audit.push(a) }));
vi.mock('../auth0', () => ({ auth0: { getSession: async () => ({ user: { name: profileName } }) } }));
vi.mock('../commentsStore', async () => {
  const { parseComment, sortComments } = await vi.importActual('../comments');
  let n = 0;
  return {
    listComments: async (g) => sortComments(Object.values(store[g] || {}).map(parseComment)),
    getComment: async (g, id) => (store[g]?.[id] ? parseComment(store[g][id]) : null),
    addComment: async (g, { email, name, text }) => {
      if (full) return { ok: false, error: 'full' };
      n += 1;
      const comment = { id: `cnew${String(n).padStart(4, '0')}`, email, name, text, at: 1000 + n };
      store[g] = { ...(store[g] || {}), [comment.id]: comment };
      return { ok: true, comment: parseComment(comment) };
    },
    deleteComment: async (g, id) => {
      delete store[g]?.[id];
    },
  };
});

const route = (await import('../../pages/api/comments')).default;

async function call({ method = 'GET', query = {}, body = {} } = {}) {
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
  };
  await route({ method, query, body, headers: {}, url: '/' }, res);
  return out;
}
const get = () => call({ query: { guid: GUID } });
const post = (body) => call({ method: 'POST', body: { guid: GUID, ...body } });
const del = (id) => call({ method: 'DELETE', query: { guid: GUID, id } });
const janes = { id: 'cjane0001', email: 'jane@example.com', name: 'Jane Smith', text: 'Amen', at: 1 };

beforeEach(() => {
  viewer = { email: 'bob@example.com', admin: false, staff: false };
  actor = { owner: false, capabilities: [] };
  videoExists = true;
  visible = true;
  live = true;
  allowed = true;
  profileName = 'Bob Jones';
  store = { [GUID]: { [janes.id]: { ...janes } } };
  full = false;
  audit.length = 0;
});

describe('the gate', () => {
  it('refuses a caller who is not signed in', async () => {
    viewer = null;
    expect((await get()).statusCode).toBe(401);
  });

  it('refuses a bad id, and other methods', async () => {
    expect((await call({ query: { guid: 'x' } })).statusCode).toBe(400);
    expect((await call({ method: 'PUT', query: { guid: GUID } })).statusCode).toBe(405);
  });

  it.each(['GET', 'POST', 'DELETE'])('404s a %s when the video is missing or outside the viewer’s groups', async (method) => {
    for (const arrange of [() => (videoExists = false), () => (visible = false)]) {
      videoExists = true;
      visible = true;
      arrange();
      const res = await call({ method, query: { guid: GUID, id: janes.id }, body: { guid: GUID, text: 'hi' } });
      expect(res.statusCode).toBe(404);
    }
    expect(store[GUID][janes.id]).toBeDefined();
    expect(Object.keys(store[GUID])).toHaveLength(1);
  });

  it('404s reading or writing outside the publish window, but not for staff', async () => {
    live = false;
    expect((await get()).statusCode).toBe(404);
    expect((await post({ text: 'early' })).statusCode).toBe(404);
    viewer = { email: 'admin@example.com', admin: false, staff: true };
    expect((await get()).statusCode).toBe(200);
  });
});

describe('reading', () => {
  it('shows names and never emails to an ordinary viewer', async () => {
    const res = await get();
    expect(res.body.comments).toEqual([
      { id: janes.id, name: 'Jane Smith', text: 'Amen', at: 1, mine: false, canDelete: false },
    ]);
    expect(JSON.stringify(res.body)).not.toContain('jane@example.com');
  });

  it('shows the email to viewers.read holders and to owners', async () => {
    actor = { owner: false, capabilities: ['viewers.read'] };
    expect((await get()).body.comments[0].email).toBe('jane@example.com');
    actor = { owner: true, capabilities: [] };
    expect((await get()).body.comments[0].email).toBe('jane@example.com');
  });
});

describe('writing', () => {
  it('posts as the session’s person, under their profile name', async () => {
    const res = await post({ text: '  Thank you ', email: 'jane@example.com' });
    expect(res.body.comment).toMatchObject({ name: 'Bob Jones', text: 'Thank you', mine: true });
    expect(Object.values(store[GUID]).find((c) => c.text === 'Thank you').email).toBe('bob@example.com');
  });

  it('never shows an email-shaped profile name', async () => {
    profileName = 'bob@example.com';
    expect((await post({ text: 'hello' })).body.comment.name).toBe('bob');
  });

  it('refuses an empty or oversized comment, a full video, and a flood', async () => {
    expect((await post({ text: ' ' })).statusCode).toBe(400);
    expect((await post({ text: 'x'.repeat(1001) })).statusCode).toBe(400);
    full = true;
    expect((await post({ text: 'one more' })).statusCode).toBe(409);
    allowed = false;
    expect((await post({ text: 'spam' })).statusCode).toBe(429);
  });
});

describe('deleting', () => {
  it('lets an author delete their own, even outside the window, unaudited', async () => {
    viewer = { email: 'jane@example.com', admin: false, staff: false };
    live = false;
    expect((await del(janes.id)).statusCode).toBe(200);
    expect(store[GUID][janes.id]).toBeUndefined();
    expect(audit).toEqual([]);
  });

  it('refuses someone else’s comment without comments.manage', async () => {
    actor = { owner: false, capabilities: ['videos.manage', 'viewers.manage'] };
    expect((await del(janes.id)).statusCode).toBe(403);
    expect(store[GUID][janes.id]).toBeDefined();
  });

  it('lets a comments.manage holder remove anyone’s, and audits it', async () => {
    viewer = { email: 'mod@example.com', admin: false, staff: true };
    actor = { owner: false, capabilities: ['comments.manage'] };
    expect((await del(janes.id)).statusCode).toBe(200);
    expect(audit).toEqual([['mod@example.com', 'comment.delete', `${GUID}: a comment by Jane Smith`]]);
  });

  it('lets an owner remove anyone’s comment', async () => {
    viewer = { email: 'owner@example.com', admin: true, staff: false };
    actor = { owner: true, capabilities: [] };
    expect((await del(janes.id)).statusCode).toBe(200);
  });

  it('404s a comment that does not exist', async () => {
    expect((await del('cmissing01')).statusCode).toBe(404);
  });
});
