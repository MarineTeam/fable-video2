import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  parseResolutions,
  lowestRenditionHeight,
  mp4Path,
  escapeXml,
  rfc2822,
  formatDuration,
  buildFeedXml,
  isValidFeedToken,
  DEFAULT_RENDITION_HEIGHT,
} from '../podcast';

describe('parseResolutions', () => {
  it('parses and sorts what Bunny reports', () => {
    expect(parseResolutions('720p,240p,360p')).toEqual([240, 360, 720]);
    expect(parseResolutions(' 480p , 1080p ')).toEqual([480, 1080]);
  });

  it('is safe on missing or junk input', () => {
    expect(parseResolutions('')).toEqual([]);
    expect(parseResolutions(null)).toEqual([]);
    expect(parseResolutions('auto,,p')).toEqual([]);
  });
});

describe('lowestRenditionHeight', () => {
  // A listener only needs the audio, so every extra pixel is download cost.
  it('picks the smallest rendition the library offers', () => {
    expect(lowestRenditionHeight({ availableResolutions: '360p,720p,1080p' })).toBe(360);
  });

  it('falls back conservatively when nothing is reported', () => {
    expect(lowestRenditionHeight({})).toBe(DEFAULT_RENDITION_HEIGHT);
    expect(lowestRenditionHeight(null)).toBe(DEFAULT_RENDITION_HEIGHT);
  });
});

describe('mp4Path', () => {
  it('builds the documented direct-play path', () => {
    expect(mp4Path('abc-123', 240)).toBe('/abc-123/play_240p.mp4');
  });
});

describe('escapeXml', () => {
  it('escapes every character that would break a parser', () => {
    expect(escapeXml('Fish & Chips')).toBe('Fish &amp; Chips');
    expect(escapeXml('<script>')).toBe('&lt;script&gt;');
    expect(escapeXml('say "hi"')).toBe('say &quot;hi&quot;');
    expect(escapeXml("it's")).toBe('it&apos;s');
  });

  it('is null-safe', () => {
    expect(escapeXml(null)).toBe('');
    expect(escapeXml(undefined)).toBe('');
  });
});

describe('rfc2822', () => {
  it('formats a parseable date', () => {
    expect(rfc2822('2026-06-15T12:00:00Z')).toBe('Mon, 15 Jun 2026 12:00:00 GMT');
  });

  // Returning null lets the caller omit the element rather than emit garbage.
  it('returns null for anything unparseable', () => {
    expect(rfc2822('not a date')).toBeNull();
    expect(rfc2822(null)).toBeNull();
    expect(rfc2822('')).toBeNull();
  });
});

describe('formatDuration', () => {
  it('matches the iTunes duration shape', () => {
    expect(formatDuration(95)).toBe('1:35');
    expect(formatDuration(5400)).toBe('1:30:00');
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(null)).toBe('0:00');
  });
});

describe('buildFeedXml', () => {
  const item = {
    title: 'Contentment & Peace',
    guid: 'abc-123',
    enclosureUrl: 'https://cdn.example.net/abc-123/play_240p.mp4?token=t&expires=1',
    link: 'https://portal.example/watch/abc-123',
    pubDate: '2026-06-15T12:00:00Z',
    description: 'Philippians 4',
    durationSeconds: 5400,
  };

  it('produces a well-formed RSS document', () => {
    const xml = buildFeedXml({
      title: 'Test Portal',
      description: 'Recordings',
      siteUrl: 'https://portal.example',
      feedUrl: 'https://portal.example/api/feed/tok',
      items: [item],
    });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain('xmlns:itunes=');
    expect(xml).toContain('<itunes:duration>1:30:00</itunes:duration>');
    expect(xml).toContain('<pubDate>Mon, 15 Jun 2026 12:00:00 GMT</pubDate>');
    expect(xml.trimEnd().endsWith('</rss>')).toBe(true);
  });

  // A private feed must never end up in a podcast directory.
  it('blocks directory listing', () => {
    const xml = buildFeedXml({ title: 't', description: 'd', siteUrl: 's', feedUrl: 'f', items: [] });
    expect(xml).toContain('<itunes:block>Yes</itunes:block>');
  });

  it('escapes titles and URLs rather than emitting raw ampersands', () => {
    const xml = buildFeedXml({
      title: 'A & B',
      description: 'd',
      siteUrl: 's',
      feedUrl: 'f',
      items: [item],
    });
    expect(xml).toContain('<title>A &amp; B</title>');
    expect(xml).toContain('token=t&amp;expires=1');
    expect(xml).not.toMatch(/token=t&expires/);
  });

  it('omits optional elements it has no value for', () => {
    const xml = buildFeedXml({
      title: 't',
      description: 'd',
      siteUrl: 's',
      feedUrl: 'f',
      items: [{ title: 'x', guid: 'g', enclosureUrl: 'u', pubDate: 'nonsense' }],
    });
    expect(xml).not.toContain('<pubDate>');
    expect(xml).not.toContain('<itunes:duration>');
  });

  it('handles an empty feed', () => {
    const xml = buildFeedXml({ title: 't', description: 'd', siteUrl: 's', feedUrl: 'f', items: [] });
    expect(xml).toContain('<channel>');
    expect(xml).not.toContain('<item>');
  });
});

describe('isValidFeedToken', () => {
  it('accepts a base64url token of credential length', () => {
    expect(isValidFeedToken('a'.repeat(43))).toBe(true);
    expect(isValidFeedToken('A-b_9'.repeat(5))).toBe(true);
  });

  it('rejects shapes that could never be one, before any lookup', () => {
    expect(isValidFeedToken('short')).toBe(false);
    expect(isValidFeedToken('has spaces in it right here')).toBe(false);
    expect(isValidFeedToken('../../etc/passwd/aaaaaaaaaaaaaaaa')).toBe(false);
    expect(isValidFeedToken('')).toBe(false);
    expect(isValidFeedToken(null)).toBe(false);
  });
});

// lib/bunny.js's signedCdnUrl duplicates the CDN token formula rather than
// refactoring thumbnailUrl, because the signing helpers are byte-exact vendor
// contracts that must not be touched. This re-derives the documented formula
// independently — the security-analysis-toolkit's recipe 2 method — so a drift
// in either copy fails here instead of becoming an opaque 403.
describe('signedCdnUrl matches the documented CDN token formula', () => {
  it('is base64url(SHA256_RAW(key + path + expires)) over the bare path', async () => {
    process.env.BUNNY_CDN_HOSTNAME = 'cdn.example.net';
    process.env.BUNNY_CDN_TOKEN_KEY = 'cdnkey';
    const { signedCdnUrl } = await import('../bunny');

    const path = '/abc-123/play_240p.mp4';
    const url = new URL(signedCdnUrl(path));
    const expires = url.searchParams.get('expires');

    const expected = crypto
      .createHash('sha256')
      .update(`cdnkey${path}${expires}`)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    expect(url.searchParams.get('token')).toBe(expected);
    expect(url.pathname).toBe(path);
    // Unix SECONDS, not milliseconds — the classic 1000x bug in this scheme.
    expect(Number(expires)).toBeLessThan(2e10);
  });

  it('returns null without a CDN host, so callers stay inert', async () => {
    delete process.env.BUNNY_CDN_HOSTNAME;
    const { signedCdnUrl } = await import('../bunny');
    expect(signedCdnUrl('/abc/play_240p.mp4')).toBeNull();
  });

  it('refuses a path that is not rooted, which would sign the wrong string', async () => {
    process.env.BUNNY_CDN_HOSTNAME = 'cdn.example.net';
    const { signedCdnUrl } = await import('../bunny');
    expect(signedCdnUrl('abc/play_240p.mp4')).toBeNull();
    expect(signedCdnUrl(null)).toBeNull();
  });
});

describe('per-episode artwork in the feed', () => {
  it('writes itunes:image for an item that has one, and nothing for one that does not', () => {
    const xml = buildFeedXml({
      title: 'T',
      description: 'D',
      siteUrl: 'https://x',
      feedUrl: 'https://x/f',
      items: [
        { title: 'A', guid: 'a', enclosureUrl: 'https://cdn/a.mp4', imageUrl: 'https://x/api/feed/t/a.jpg' },
        { title: 'B', guid: 'b', enclosureUrl: 'https://cdn/b.mp4' },
      ],
    });
    expect(xml).toContain('<itunes:image href="https://x/api/feed/t/a.jpg"/>');
    expect(xml.match(/itunes:image/g)).toHaveLength(1);
  });
});
