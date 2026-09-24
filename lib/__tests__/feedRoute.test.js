// pages/api/feed/[token].js — that each item points its artwork at the stable
// entitlement-checked address, and never at a CDN URL of its own.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../podcastStore', () => ({
  podcastEnabled: () => true,
  emailForFeedToken: async (t) => (t === 'tok-valid' ? 'viewer@example.com' : null),
}));
vi.mock('../guard', () => ({
  viewerAccessFor: async () => ({ approved: true, owner: false, staff: false }),
}));
vi.mock('../redis', () => ({ k: (n) => `fable2:${n}`, redis: () => ({ get: async () => null }) }));
vi.mock('../bunny', () => ({
  listVideos: async () => ({ items: [{ guid: 'abcdef12-3456', title: 'Sunday', status: 4 }] }),
  isPlayable: () => true,
  signedCdnUrl: (path) => `https://vz.b-cdn.net${path}?token=sig`,
}));
vi.mock('../groups', () => ({
  contentScopeFor: async () => null,
  filterVideosByScope: (v) => v,
}));
vi.mock('../schedule', () => ({ filterVideosBySchedule: (v) => v }));
vi.mock('../scheduleStore', () => ({ loadSchedule: async () => ({}), viewerGroupIds: async () => [] }));
vi.mock('../notesStore', () => ({ loadAllNotes: async () => ({}) }));
vi.mock('../siteNameStore', () => ({ getSiteName: async () => 'Grace Chapel' }));
let iconVersion = null;
vi.mock('../appIconStore', () => ({ getAppIconVersion: async () => iconVersion }));

const route = (await import('../../pages/api/feed/[token]')).default;

describe('feed artwork', () => {
  it('points each episode at /api/feed/<token>/<guid>.jpg on this app', async () => {
    const out = {};
    const res = {
      status(c) { out.statusCode = c; return res; },
      json(b) { out.body = b; return res; },
      send(b) { out.body = b; return res; },
      setHeader: () => res,
    };
    await route(
      { method: 'GET', query: { token: 'tok-valid' }, headers: { host: 'portal.example.com' }, url: '/api/feed/tok-valid' },
      res
    );
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain(
      '<itunes:image href="https://portal.example.com/api/feed/tok-valid/abcdef12-3456.jpg"/>'
    );
    // The enclosure is a signed CDN URL in this repo; the ARTWORK never is.
    expect(out.body).not.toMatch(/itunes:image href="https:\/\/vz\.b-cdn\.net/);
  });

  it('uses the app icon as the show cover — the admin-set one when there is one', async () => {
    const run = async () => {
      const out = {};
      const res = {
        status(c) { out.statusCode = c; return res; },
        json(b) { out.body = b; return res; },
        send(b) { out.body = b; return res; },
        setHeader: () => res,
      };
      await route(
        { method: 'GET', query: { token: 'tok-valid' }, headers: { host: 'portal.example.com' }, url: '/api/feed/tok-valid' },
        res
      );
      return out.body;
    };
    iconVersion = null;
    expect(await run()).toContain('<itunes:image href="https://portal.example.com/icon-512.png"/>');
    iconVersion = 'vabc123def456';
    expect(await run()).toContain('<itunes:image href="https://portal.example.com/api/app-icon/512?v=vabc123def456"/>');
  });
});
