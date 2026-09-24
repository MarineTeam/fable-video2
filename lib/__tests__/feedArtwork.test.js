// pages/api/feed/[token]/[file].js — per-episode podcast artwork.
//
// A route rather than a signed URL in the feed, because apps cache art keyed
// on the URL: a stable address here, re-checked on every fetch, answered with
// a short-lived signed redirect. The checks are the feed route's, and every
// refusal is the same bare 404.
import { beforeEach, describe, expect, it, vi } from 'vitest';

let enabled = true;
let tokenEmail = 'viewer@example.com';
let access = { approved: true, owner: false, staff: false };
let video = null;
let bunnyThrows = false;
let scopeVisible = true;
let windowOpen = true;
const signed = [];

vi.mock('../podcastStore', () => ({
  podcastEnabled: () => enabled,
  emailForFeedToken: async (t) => (t === 'tok-valid' ? tokenEmail : null),
}));
vi.mock('../guard', () => ({ viewerAccessFor: async () => access }));
vi.mock('../ratelimit', () => ({ allowRequest: async () => true }));
vi.mock('../bunny', () => ({
  getVideo: async () => {
    if (bunnyThrows) throw new Error('404');
    return video;
  },
  isPlayable: (v) => v.status === 4,
  signedCdnUrl: (path, ttl) => {
    signed.push([path, ttl]);
    return `https://vz.b-cdn.net${path}?token=sig&expires=1`;
  },
}));
vi.mock('../groups', () => ({
  contentScopeFor: async () => 'scope',
  isVideoVisible: () => scopeVisible,
}));
vi.mock('../scheduleStore', () => ({ isVideoInWindowFor: async () => windowOpen }));

const route = (await import('../../pages/api/feed/[token]/[file]')).default;

async function art(file = 'abcdef12-3456.jpg', token = 'tok-valid', method = 'GET') {
  const out = { statusCode: 200, headers: {}, body: undefined };
  const res = {
    status(c) { out.statusCode = c; return res; },
    json(b) { out.body = b; return res; },
    setHeader(n, v) { out.headers[n.toLowerCase()] = v; return res; },
    end() { return res; },
    set statusCode(c) { out.statusCode = c; },
  };
  await route({ method, query: { token, file }, headers: {} }, res);
  return out;
}

beforeEach(() => {
  enabled = true;
  tokenEmail = 'viewer@example.com';
  access = { approved: true, owner: false, staff: false };
  video = { guid: 'abcdef12-3456', status: 4, thumbnailFileName: 'thumbnail_9f.jpg' };
  bunnyThrows = false;
  scopeVisible = true;
  windowOpen = true;
  signed.length = 0;
});

describe('episode artwork', () => {
  it('redirects to a SHORT-LIVED signed custom thumbnail', async () => {
    const res = await art();
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('/abcdef12-3456/thumbnail_9f.jpg');
    expect(signed[0][1]).toBeLessThanOrEqual(15 * 60);
    expect(res.headers['cache-control']).toMatch(/private/);
  });

  it.each([
    ['the feature is off', () => { enabled = false; }],
    ['the token is unknown', () => { tokenEmail = null; }],
    ['the person is no longer approved', () => { access = { approved: false }; }],
    ['bunny does not have the video', () => { bunnyThrows = true; }],
    ['the video is not playable', () => { video.status = 1; }],
    ['the video is outside their group scope', () => { scopeVisible = false; }],
    ['the video is outside its publish window', () => { windowOpen = false; }],
  ])('404s, signing nothing, when %s', async (_why, arrange) => {
    arrange();
    const res = await art();
    expect(res.statusCode).toBe(404);
    expect(signed).toEqual([]);
  });

  it('lets staff see art outside the publish window, as the feed does', async () => {
    windowOpen = false;
    access = { approved: true, owner: false, staff: true };
    expect((await art()).statusCode).toBe(302);
  });

  it('refuses anything but <guid>.jpg', async () => {
    for (const file of ['abcdef12-3456.mp4', '../x.jpg', 'abc.jpg', ['a.jpg', 'b.jpg']]) {
      expect((await art(file)).statusCode, String(file)).toBe(404);
    }
  });

  it('refuses a thumbnail file name that is not a plain file name', async () => {
    for (const name of ['../../secret.jpg', 'a/b.jpg', 'x.svg']) {
      video.thumbnailFileName = name;
      expect((await art()).statusCode, name).toBe(404);
    }
    expect(signed).toEqual([]);
  });
});
