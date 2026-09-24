// lib/scheduleStore.js — the Redis side of repeat rules and per-group windows:
// what survives a read, when a viewer's groups are consulted, what happens
// when they cannot be, and pruning a deleted group.
import { beforeEach, describe, expect, it, vi } from 'vitest';

let hash = {};
let failHgetall = false;
vi.mock('../redis', () => ({
  k: (name) => `fable2:${name}`,
  redis: () => ({
    hgetall: async () => {
      if (failHgetall) throw new Error('redis down');
      return { ...hash };
    },
    hget: async (_key, field) => hash[field] ?? null,
    hset: async (_key, obj) => Object.assign(hash, obj),
    hdel: async (_key, field) => {
      delete hash[field];
      return 1;
    },
  }),
}));

const membership = vi.fn(async () => []);
vi.mock('../groups', () => ({ groupIdsForEmail: (...a) => membership(...a) }));

const { getVideoWindow, isVideoInWindowFor, loadSchedule, pruneGroupFromSchedules } = await import(
  '../scheduleStore'
);

const GUID = 'abcdef12-3456';
const sundayMorning = { days: [0], start: '09:00', end: '13:00', timeZone: 'UTC' };
const future = '2099-01-01T00:00:00.000Z';
const past = '2020-01-01T00:00:00.000Z';

beforeEach(() => {
  hash = {};
  failHgetall = false;
  membership.mockReset().mockImplementation(async () => []);
});

describe('reading', () => {
  it('keeps a repeat rule and group windows, including on a record with no dates', async () => {
    hash[GUID] = JSON.stringify({ from: null, until: null, repeat: sundayMorning, groups: { 'youth-x1': { from: past } } });
    expect(await getVideoWindow(GUID)).toEqual({
      from: null,
      until: null,
      repeat: sundayMorning,
      groups: { 'youth-x1': { from: past, until: null } },
    });
    expect(Object.keys(await loadSchedule())).toEqual([GUID]);
  });

  it('still fails open on the list read', async () => {
    failHgetall = true;
    expect(await loadSchedule()).toEqual({});
  });
});

describe('isVideoInWindowFor', () => {
  it('does not read membership when the default window already allows it', async () => {
    hash[GUID] = { from: past, until: null, groups: { 'youth-x1': { from: past } } };
    expect(await isVideoInWindowFor(GUID, 'a@example.com')).toBe(true);
    expect(membership).not.toHaveBeenCalled();
  });

  it('does not read membership when the video has no group windows', async () => {
    hash[GUID] = { from: future, until: null };
    expect(await isVideoInWindowFor(GUID, 'a@example.com')).toBe(false);
    expect(membership).not.toHaveBeenCalled();
  });

  it("opens the video to a member during their group's window, for that viewer only", async () => {
    hash[GUID] = { from: future, until: null, groups: { 'youth-x1': { from: past } } };
    membership.mockImplementation(async (email) => (email === 'leader@example.com' ? ['youth-x1'] : ['choir-z9']));
    expect(await isVideoInWindowFor(GUID, 'leader@example.com')).toBe(true);
    expect(await isVideoInWindowFor(GUID, 'singer@example.com')).toBe(false);
    expect(membership).toHaveBeenCalledWith('leader@example.com');
  });

  it('applies the default window when membership cannot be read — never widens', async () => {
    hash[GUID] = { from: future, until: null, groups: { 'youth-x1': { from: past } } };
    membership.mockImplementation(async () => {
      throw new Error('redis down');
    });
    expect(await isVideoInWindowFor(GUID, 'leader@example.com')).toBe(false);
  });

  it('shows a video with no record', async () => {
    expect(await isVideoInWindowFor(GUID, 'a@example.com')).toBe(true);
  });
});

describe('pruneGroupFromSchedules', () => {
  it("removes only that group's window and keeps the rest of the record", async () => {
    hash.v1 = { from: future, until: null, repeat: sundayMorning, groups: { 'youth-x1': { from: past }, 'choir-z9': { from: past } } };
    hash.v2 = { from: future, until: null };
    expect(await pruneGroupFromSchedules('youth-x1')).toBe(1);
    expect(hash.v1).toEqual({
      from: future,
      until: null,
      repeat: sundayMorning,
      groups: { 'choir-z9': { from: past, until: null } },
    });
    expect(hash.v2).toEqual({ from: future, until: null });
  });

  it('deletes a record that held nothing but that group window', async () => {
    hash.v1 = { from: null, until: null, groups: { 'youth-x1': { from: past } } };
    await pruneGroupFromSchedules('youth-x1');
    expect(hash).toEqual({});
  });

  it('reports a failed read to its caller instead of silently doing nothing', async () => {
    failHgetall = true;
    await expect(pruneGroupFromSchedules('youth-x1')).rejects.toThrow('redis down');
  });
});
