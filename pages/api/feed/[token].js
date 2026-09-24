import { withMonitorApi } from '../../../lib/monitor';
import { viewerAccessFor } from '../../../lib/guard';
import { listVideos, signedCdnUrl, isPlayable } from '../../../lib/bunny';
import { redis, k } from '../../../lib/redis';
import { applyOrder } from '../../../lib/order';
import { contentScopeFor, filterVideosByScope } from '../../../lib/groups';
import { filterVideosBySchedule } from '../../../lib/schedule';
import { loadSchedule } from '../../../lib/scheduleStore';
import { loadAllNotes } from '../../../lib/notesStore';
import { getSiteName } from '../../../lib/siteNameStore';
import { emailForFeedToken, podcastEnabled } from '../../../lib/podcastStore';
import { buildFeedXml, lowestRenditionHeight, mp4Path } from '../../../lib/podcast';
import { getAppIconVersion } from '../../../lib/appIconStore';

// The per-subscriber podcast feed. This is the ONLY route in the app that
// authenticates with something other than an Auth0 session, because podcast
// apps cannot log in — the token in the URL is the whole credential.
//
// It is therefore deliberately narrow:
//   * the token resolves to exactly one viewer, and that viewer's CURRENT
//     access is re-checked on every fetch. Removing someone from the viewer
//     list kills their feed on the next refresh even if the URL still exists;
//   * the item list is built through the same isPlayable -> group scope ->
//     publish window pipeline as /api/videos, so a feed can never show a video
//     its owner could not open in the browser;
//   * every refusal is the same bare 404. A wrong, revoked or malformed token
//     is indistinguishable, so the route cannot be used to test tokens;
//   * no-store, because the response is per-subscriber and carries signed
//     enclosure URLs. A shared cache holding this would hand one person's feed
//     to another.
//
// Enclosures are signed CDN URLs with a 48h TTL: long enough for a podcast app
// to queue and download, short enough that a forwarded URL stops working. The
// feed URL itself does not expire — regenerating it in the app is the revoke.
const ENCLOSURE_TTL_SECONDS = 48 * 3600;
const MAX_ITEMS = 50;

function notFound(res) {
  return res.status(404).json({ error: 'Not found' });
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  // Inert until a CDN hostname exists — without one there is no enclosure to
  // publish and a feed of broken links is worse than no feed.
  if (!podcastEnabled()) return notFound(res);

  const email = await emailForFeedToken(String(req.query.token || ''));
  if (!email) return notFound(res);

  // Re-check access every fetch: the token names a person, it does not grant
  // anything by itself.
  const { approved, owner, staff } = await viewerAccessFor(email);
  if (!approved) return notFound(res);

  const r = redis();
  const isStaff = owner || staff;
  const [countRaw, orderRaw, scope, schedule, notesByGuid, siteName] = await Promise.all([
    r.get(k('settings:homeCount')).catch(() => null),
    r.get(k('order')).catch(() => null),
    contentScopeFor(email, { staff: isStaff }),
    isStaff ? Promise.resolve({}) : loadSchedule(),
    loadAllNotes(),
    getSiteName(),
  ]);
  const homeCount = Math.min(Math.max(parseInt(countRaw, 10) || 48, 1), 200);
  const order = Array.isArray(orderRaw) ? orderRaw : [];

  let videos;
  try {
    const data = await listVideos({ page: 1, perPage: Math.min(homeCount, 100) });
    videos = filterVideosBySchedule(
      filterVideosByScope((data?.items || []).filter(isPlayable), scope),
      schedule
    );
  } catch {
    return res.status(502).json({ error: 'Video service unavailable' });
  }

  const base = `https://${req.headers.host}`;
  const items = applyOrder(videos, order)
    .slice(0, MAX_ITEMS)
    .map((v) => {
      const enclosureUrl = signedCdnUrl(
        mp4Path(v.guid, lowestRenditionHeight(v)),
        ENCLOSURE_TTL_SECONDS
      );
      if (!enclosureUrl) return null;
      return {
        title: v.title || 'Untitled',
        guid: v.guid,
        enclosureUrl,
        // A stable address on this app, re-checked per fetch — see
        // pages/api/feed/[token]/[file].js for why art is not a signed URL.
        imageUrl: `${base}/api/feed/${encodeURIComponent(String(req.query.token || ''))}/${encodeURIComponent(v.guid)}.jpg`,
        link: `${base}/watch/${v.guid}`,
        pubDate: v.dateUploaded,
        description: notesByGuid[v.guid] || '',
        durationSeconds: v.length || 0,
      };
    })
    .filter(Boolean);

  const iconVersion = await getAppIconVersion().catch(() => null);
  const xml = buildFeedXml({
    imageUrl: iconVersion ? `${base}/api/app-icon/512?v=${iconVersion}` : `${base}/icon-512.png`,
    title: siteName,
    description: `Recordings from ${siteName}. This feed is private to you — please don't share the link.`,
    siteUrl: base,
    feedUrl: `${base}${req.url || ''}`,
    items,
  });

  res.setHeader('content-type', 'application/rss+xml; charset=utf-8');
  res.setHeader('cache-control', 'private, no-store');
  res.status(200).send(xml);
}

export default withMonitorApi(handler);
