// Per-subscriber podcast feed.
//
// HONEST SCOPE — read this before believing the word "podcast":
//
// bunny.net Stream has NO audio-only rendition. Its direct-play files are
// MP4 video at `/{guid}/play_{height}p.mp4` (MP4 Fallback, a per-library
// setting), and the only other playback path is the iframe embed, which a
// podcast app cannot use as an enclosure. So these feeds carry VIDEO, and the
// enclosure deliberately points at the LOWEST rendition the library offers:
// a listener gets the audio either way, so every extra pixel is download cost
// on someone's mobile data. A 90-minute service is still a large file. Say
// that to anyone who asks rather than letting "podcast" imply a small audio
// download.
//
// PURE — imports nothing. Redis and crypto live in lib/podcastStore.js.

export const DEFAULT_RENDITION_HEIGHT = 240;

// Bunny reports availableResolutions as e.g. '240p,360p,720p'. Order is not
// guaranteed, so it is parsed and sorted rather than trusted.
export function parseResolutions(raw) {
  return String(raw || '')
    .split(',')
    .map((part) => parseInt(String(part).trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
}

// The smallest rendition available, falling back to a conservative default
// when the library did not report any — a guess that is too small simply 404s
// at the CDN, whereas guessing large wastes a listener's data.
export function lowestRenditionHeight(video, fallback = DEFAULT_RENDITION_HEIGHT) {
  const heights = parseResolutions(video?.availableResolutions);
  return heights.length ? heights[0] : fallback;
}

export function mp4Path(guid, height) {
  return `/${guid}/play_${height}p.mp4`;
}

// XML escaping for text nodes and attribute values. Titles and notes are
// admin-authored, but they still land in a document another program parses,
// so they are escaped rather than trusted.
export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// RFC 2822, which RSS requires for pubDate. Invalid input yields null so the
// caller can omit the element rather than emit an unparseable one.
export function rfc2822(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toUTCString();
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// RSS 2.0 with the iTunes namespace. Deliberately hand-built rather than
// pulling a dependency: this is a fixed, small document, and the repo's
// dependency-minimalism rule asks what a package would do that a few lines of
// string building cannot.
export function buildFeedXml({ title, description, siteUrl, feedUrl, items = [] }) {
  const channel = [
    `<title>${escapeXml(title)}</title>`,
    `<link>${escapeXml(siteUrl)}</link>`,
    `<description>${escapeXml(description)}</description>`,
    '<language>en</language>',
    // A private feed must never be indexed or listed in a directory.
    '<itunes:block>Yes</itunes:block>',
    '<itunes:explicit>false</itunes:explicit>',
    `<atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml"/>`,
  ];

  const entries = items.map((item) => {
    const parts = [
      `<title>${escapeXml(item.title)}</title>`,
      `<guid isPermaLink="false">${escapeXml(item.guid)}</guid>`,
      `<enclosure url="${escapeXml(item.enclosureUrl)}" type="video/mp4"${
        item.lengthBytes ? ` length="${item.lengthBytes}"` : ' length="0"'
      }/>`,
    ];
    if (item.link) parts.push(`<link>${escapeXml(item.link)}</link>`);
    const pub = rfc2822(item.pubDate);
    if (pub) parts.push(`<pubDate>${pub}</pubDate>`);
    if (item.description) {
      parts.push(`<description>${escapeXml(item.description)}</description>`);
    }
    if (item.durationSeconds) {
      parts.push(`<itunes:duration>${formatDuration(item.durationSeconds)}</itunes:duration>`);
    }
    return `    <item>\n      ${parts.join('\n      ')}\n    </item>`;
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    ${channel.join('\n    ')}`,
    ...entries,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

// Tokens are opaque and compared as whole strings; this only rejects shapes
// that could never be one, before any lookup happens.
export function isValidFeedToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(token);
}
