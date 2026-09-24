import { withMonitorApi } from '../../../../lib/monitor';
import { viewerAccessFor } from '../../../../lib/guard';
import { getVideo, isPlayable, signedCdnUrl } from '../../../../lib/bunny';
import { allowRequest } from '../../../../lib/ratelimit';
import { contentScopeFor, isVideoVisible } from '../../../../lib/groups';
import { isVideoInWindowFor } from '../../../../lib/scheduleStore';
import { emailForFeedToken, podcastEnabled } from '../../../../lib/podcastStore';

// One podcast episode's ARTWORK: GET /api/feed/<token>/<guid>.jpg.
//
// Why a route and not a signed URL in the feed, like the enclosures: podcast
// apps cache episode art for a long time, KEYED ON THE URL. A signed CDN URL
// in the feed changes on every refresh (its expiry moves), so an app would
// re-download every episode's art on every poll — and whatever it had cached
// would point at a signature that has since expired. The feed instead gives a
// stable address on this app; each fetch of it is re-checked here and answered
// with a short-lived signed redirect, which no cache needs to keep.
//
// The checks are the feed route's, per request, in the same order, and every
// refusal is the same bare 404:
//   * the feature is on and the token names someone;
//   * that person is approved NOW (the token grants nothing by itself);
//   * the video is playable, inside their group scope, and — unless they are
//     staff — inside its publish window. The window is read the way the feed
//     reads it (lib/scheduleStore.js fails open, by this repo's stated rule).
const ART_TTL_SECONDS = 15 * 60;

// A thumbnail file name as bunny reports it ('thumbnail.jpg', or
// 'thumbnail_1a2b3c.jpg' after a custom upload). It becomes a signed CDN path,
// so anything that is not a plain file name is refused.
const THUMBNAIL_FILE = /^[A-Za-z0-9_-]{1,64}\.(jpg|jpeg|png|webp)$/;

function notFound(res) {
  return res.status(404).json({ error: 'Not found' });
}

// '<guid>.jpg' -> guid. Strings only: a repeated key arrives as an array.
function guidFromFile(file) {
  if (typeof file !== 'string' || !file.endsWith('.jpg')) return null;
  const guid = file.slice(0, -4);
  return /^[A-Za-z0-9-]{8,64}$/.test(guid) ? guid : null;
}

async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!podcastEnabled()) return notFound(res);

  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const guid = guidFromFile(req.query.file);
  if (!guid) return notFound(res);

  // An app refreshing a feed fetches every episode's image at once, so the
  // budget is generous; it still bounds what a leaked URL can cost at bunny.
  if (!(await allowRequest('feed-art', token.slice(0, 16) || 'anon', 600, 3600))) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  const email = await emailForFeedToken(token);
  if (!email) return notFound(res);
  const { approved, owner, staff } = await viewerAccessFor(email);
  if (!approved) return notFound(res);
  const isStaff = owner || staff;

  let video;
  try {
    video = await getVideo(guid);
  } catch {
    return notFound(res);
  }
  if (!video?.guid || !isPlayable(video)) return notFound(res);

  const scope = await contentScopeFor(email, { staff: isStaff });
  if (!isVideoVisible(scope, video)) return notFound(res);
  if (!isStaff && !(await isVideoInWindowFor(video.guid, email))) return notFound(res);

  const name = String(video.thumbnailFileName || 'thumbnail.jpg');
  if (!THUMBNAIL_FILE.test(name)) return notFound(res);
  const url = signedCdnUrl(`/${video.guid}/${name}`, ART_TTL_SECONDS);
  if (!url) return notFound(res);

  // private + short: the Location carries a signed URL.
  res.setHeader('cache-control', 'private, max-age=60');
  res.setHeader('location', url);
  res.statusCode = 302;
  return res.end();
}

export default withMonitorApi(handler);
