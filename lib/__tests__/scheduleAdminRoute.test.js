// POST /api/admin/schedule with repeat rules and per-group windows, and the
// group delete that prunes a group's windows. The schedule validation is the
// REAL lib/schedule.js; only storage, groups and the guard are stand-ins.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CAP } from '../capabilities';

let groupRecords = {};
const setVideoWindow = vi.fn(async (guid, window) => ({ ok: true, window }));
const pruneGroupFromSchedules = vi.fn(async () => 1);
const deleteGroup = vi.fn(async () => ({ ok: true }));

vi.mock('../guard', () => ({
  requireCapability: async (req, res, capability) =>
    [CAP.VIDEOS_MANAGE, CAP.GROUPS_MANAGE].includes(capability) ? 'admin@example.com' : null,
  resolveActor: async (email) => ({ email, owner: true, capabilities: [], staff: true }),
}));
vi.mock('../ratelimit', () => ({ allowRequest: async () => true }));
vi.mock('../audit', () => ({ logAction: async () => {} }));
vi.mock('../redis', () => ({
  k: (name) => `fable2:${name}`,
  redis: () => ({ hgetall: async () => ({}), hget: async () => null, hset: async () => 1, hdel: async () => 1 }),
}));
vi.mock('../scheduleStore', () => ({
  setVideoWindow: (...a) => setVideoWindow(...a),
  pruneGroupFromSchedules: (...a) => pruneGroupFromSchedules(...a),
}));
vi.mock('../groups', async () => ({
  ...(await vi.importActual('../groups')),
  loadGroups: async () => groupRecords,
  deleteGroup: (...a) => deleteGroup(...a),
}));

const scheduleRoute = (await import('../../pages/api/admin/schedule')).default;
const groupsRoute = (await import('../../pages/api/admin/groups')).default;

async function call(route, { method = 'POST', body = {}, query = {} } = {}) {
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

const GUID = 'abcdef12-3456';
const sundayMorning = { days: [0, 3], start: '18:30', end: '21:00', timeZone: 'America/Los_Angeles' };

beforeEach(() => {
  groupRecords = { 'youth-x1': { id: 'youth-x1', name: 'Youth', collectionIds: [], videoIds: [] } };
  setVideoWindow.mockClear();
  pruneGroupFromSchedules.mockClear();
  deleteGroup.mockClear();
});

describe('POST /api/admin/schedule', () => {
  it('stores the dates, the weekly rule and the group windows as one entry', async () => {
    const res = await call(scheduleRoute, {
      body: {
        guid: GUID,
        from: '2026-10-01T09:00:00.000Z',
        until: '',
        repeat: sundayMorning,
        groups: { 'youth-x1': { from: '2026-09-25T09:00:00.000Z', until: null } },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(setVideoWindow).toHaveBeenCalledWith(GUID, {
      from: '2026-10-01T09:00:00.000Z',
      until: null,
      repeat: sundayMorning,
      groups: { 'youth-x1': { from: '2026-09-25T09:00:00.000Z', until: null } },
    });
  });

  it('stores a record that has only a weekly rule', async () => {
    await call(scheduleRoute, { body: { guid: GUID, from: '', until: '', repeat: sundayMorning } });
    expect(setVideoWindow).toHaveBeenCalledWith(GUID, { from: null, until: null, repeat: sundayMorning });
  });

  it('clears the entry when nothing is set', async () => {
    await call(scheduleRoute, { body: { guid: GUID, from: '', until: '', repeat: null, groups: {} } });
    expect(setVideoWindow).toHaveBeenCalledWith(GUID, null);
  });

  it.each([
    [{ ...sundayMorning, days: [] }, /at least one day/],
    [{ ...sundayMorning, timeZone: 'Nowhere/Special' }, /time zone/],
    [{ ...sundayMorning, end: '18:30' }, /same time/],
  ])('refuses a bad weekly rule, storing nothing (%j)', async (repeat, message) => {
    const res = await call(scheduleRoute, { body: { guid: GUID, repeat } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(message);
    expect(setVideoWindow).not.toHaveBeenCalled();
  });

  it('refuses a window for a group that does not exist, storing nothing', async () => {
    const res = await call(scheduleRoute, {
      body: { guid: GUID, groups: { 'gone-q1': { from: '2026-09-25T09:00:00.000Z' } } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/no longer exists/);
    expect(setVideoWindow).not.toHaveBeenCalled();
  });

  it('refuses an inverted group window', async () => {
    const res = await call(scheduleRoute, {
      body: { guid: GUID, groups: { 'youth-x1': { from: '2026-09-25T09:00', until: '2026-09-01T09:00' } } },
    });
    expect(res.statusCode).toBe(400);
    expect(setVideoWindow).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/admin/groups', () => {
  it("prunes the deleted group's publish windows", async () => {
    const res = await call(groupsRoute, { method: 'DELETE', query: { id: 'youth-x1' } });
    expect(res.statusCode).toBe(200);
    expect(deleteGroup).toHaveBeenCalledWith('youth-x1');
    expect(pruneGroupFromSchedules).toHaveBeenCalledWith('youth-x1');
  });

  it('still reports the delete when pruning fails — the group is gone either way', async () => {
    pruneGroupFromSchedules.mockImplementationOnce(async () => {
      throw new Error('redis down');
    });
    const res = await call(groupsRoute, { method: 'DELETE', query: { id: 'youth-x1' } });
    expect(res.statusCode).toBe(200);
  });
});
