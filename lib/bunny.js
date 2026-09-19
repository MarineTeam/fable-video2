import crypto from 'crypto';
import { recordExternal } from './monitor';

// bunny.net Stream API. Server-side only — the API key must never reach the
// client. Env values are trimmed because a stray newline pasted into Vercel
// corrupts TUS signatures.

const API_BASE = 'https://video.bunnycdn.com';

const env = (name) => (process.env[name] || '').trim();
const libraryId = () => env('BUNNY_LIBRARY_ID');
const apiKey = () => env('BUNNY_API_KEY');

// Query Monitor instrumentation: every bunny.net call funnels through this
// one helper, so timing it here covers every call site below with no
// per-call-site edits — none of the signing functions further down call
// `api()`, so they're untouched by this. recordExternal is a no-op outside a
// withMonitorApi/withMonitorPage context and when the monitor is off.
async function api(path, { method = 'GET', body } = {}) {
  const start = process.hrtime.bigint();
  try {
    const res = await fetch(`${API_BASE}/library/${libraryId()}${path}`, {
      method,
      headers: {
        AccessKey: apiKey(),
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Bunny ${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
    }
    return res.json().catch(() => null);
  } finally {
    recordExternal(bunnyLabel(path), Number(process.hrtime.bigint() - start) / 1e6);
  }
}

// /videos?... -> "bunny /videos", /collections/<id> -> "bunny /collections",
// keeping ids and query strings out of the label.
function bunnyLabel(path) {
  const segment = String(path || '').split('?')[0].split('/').filter(Boolean)[0];
  return `bunny /${segment || 'api'}`;
}

// ---- Videos -----------------------------------------------------------------

export function listVideos({ page = 1, perPage = 100, search = '', collection = '' } = {}) {
  const params = new URLSearchParams({
    page: String(page),
    itemsPerPage: String(perPage),
    orderBy: 'date',
  });
  if (search) params.set('search', search);
  if (collection) params.set('collection', collection);
  return api(`/videos?${params}`);
}

export const getVideo = (id) => api(`/videos/${id}`);

export const createVideo = (title, collectionId) =>
  api('/videos', { method: 'POST', body: { title, ...(collectionId ? { collectionId } : {}) } });

export const updateVideo = (id, fields) =>
  api(`/videos/${id}`, { method: 'POST', body: fields });

export const deleteVideo = (id) => api(`/videos/${id}`, { method: 'DELETE' });

// ---- Collections --------------------------------------------------------------

export const listCollections = () =>
  api('/collections?page=1&itemsPerPage=100&orderBy=date');

export const createCollection = (name) =>
  api('/collections', { method: 'POST', body: { name } });

export const deleteCollection = (id) => api(`/collections/${id}`, { method: 'DELETE' });

// ---- Statistics ---------------------------------------------------------------

export function getStatistics({ dateFrom, dateTo } = {}) {
  const params = new URLSearchParams();
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);
  return api(`/statistics?${params}`);
}

// ---- Signing ------------------------------------------------------------------

// Not password hashing: this SHA256 concatenation is bunny.net's mandated
// token-signing formula (embed + TUS auth). The algorithm is fixed by their
// server-side verifier — it recomputes the same SHA256 and string-compares,
// so switching to a slower KDF here would just make every signed URL invalid.
// codeql[js/insufficient-password-hash] -- not a password hash, see comment above
const sha256Hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Embed View Token Authentication: token = SHA256_HEX(key + videoId + expires),
// expires in unix SECONDS.
export function signedEmbedUrl(videoId, ttlSeconds = 4 * 3600) {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const token = sha256Hex(`${env('BUNNY_TOKEN_AUTH_KEY')}${videoId}${expires}`);
  return `https://iframe.mediadelivery.net/embed/${libraryId()}/${videoId}?token=${token}&expires=${expires}&autoplay=false&preload=false`;
}

// CDN URL token auth for thumbnails: base64url(SHA256_RAW(key + path + expires)).
// Signed only when a token key is available, so thumbnails keep working with
// "Block Direct URL File Access" enabled.
export function thumbnailUrl(video, ttlSeconds = 12 * 3600) {
  const host = env('BUNNY_CDN_HOSTNAME');
  if (!host || !video?.guid) return null;
  const path = `/${video.guid}/${video.thumbnailFileName || 'thumbnail.jpg'}`;
  const key = env('BUNNY_CDN_TOKEN_KEY') || env('BUNNY_TOKEN_AUTH_KEY');
  if (!key) return `https://${host}${path}`;
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  // Not password hashing: bunny.net's CDN token-auth formula, fixed by their
  // verifier (see sha256Hex above for the same rationale).
  const token = crypto
    .createHash('sha256') // codeql[js/insufficient-password-hash] -- not a password hash, see comment above
    .update(`${key}${path}${expires}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `https://${host}${path}?token=${token}&expires=${expires}`;
}

// Signed CDN URL for an ARBITRARY path on the pull zone — used for podcast
// enclosures (/{guid}/play_{height}p.mp4).
//
// This is scheme (b), the same formula thumbnailUrl uses:
// base64url(SHA256_RAW(key + path + expires)), path with a leading slash and
// no query string, expires in unix SECONDS. thumbnailUrl is deliberately NOT
// refactored to call this — the signing helpers are byte-exact vendor
// contracts and are not to be touched — so the two must stay in lockstep.
// lib/__tests__/podcast.test.js re-derives this formula independently with
// node:crypto so a drift in either copy fails a test rather than a 403.
//
// Returns null when no CDN host is configured, so callers stay inert rather
// than emitting a broken URL.
export function signedCdnUrl(path, ttlSeconds = 48 * 3600) {
  const host = env('BUNNY_CDN_HOSTNAME');
  if (!host || typeof path !== 'string' || !path.startsWith('/')) return null;
  const key = env('BUNNY_CDN_TOKEN_KEY') || env('BUNNY_TOKEN_AUTH_KEY');
  if (!key) return `https://${host}${path}`;
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  // NOT password hashing. This is bunny.net's CDN token-auth formula: their
  // verifier recomputes the same SHA256 and string-compares, so a slower KDF
  // here would invalidate every signed URL rather than harden anything.
  //
  // Code scanning reports js/insufficient-password-hash on the .update() line
  // below, because it treats the env-sourced key as a password reaching a fast
  // hash. It is a false positive and is dismissed as one in the repository's
  // Security tab. Do NOT try to silence it with an inline `codeql[...]` or
  // `lgtm[...]` comment: this repository uses CodeQL default setup, which does
  // not honour inline suppressions — that was tried on this exact line and the
  // alert persisted. The same applies to thumbnailUrl above, which still
  // carries such a comment; it is equally inert there.
  const token = crypto
    .createHash('sha256')
    .update(`${key}${path}${expires}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `https://${host}${path}?token=${token}&expires=${expires}`;
}

// TUS upload authorization: SHA256_HEX(libraryId + apiKey + expire + videoId),
// expire in unix SECONDS. Generated server-side; only the signature ships to
// the browser.
export function tusAuth(videoId, ttlSeconds = 6 * 3600) {
  const expire = Math.floor(Date.now() / 1000) + ttlSeconds;
  return {
    endpoint: 'https://video.bunnycdn.com/tusupload',
    headers: {
      AuthorizationSignature: sha256Hex(`${libraryId()}${apiKey()}${expire}${videoId}`),
      AuthorizationExpire: String(expire),
      VideoId: videoId,
      LibraryId: libraryId(),
    },
  };
}

// Bunny status codes: 0 created, 1 uploaded, 2 processing, 3 transcoding,
// 4 finished, 5 error, 6 upload failed.
export const isPlayable = (v) => v && (v.status === 3 || v.status === 4);
export const isFailed = (v) => v && (v.status === 5 || v.status === 6);
export const isEncoding = (v) => v && v.status >= 0 && v.status <= 3;

// Queues bunny's Transcribe AI (Whisper). ASYNCHRONOUS — this returns once the
// job is queued, not when captions exist.
//
// THIS CALL COSTS MONEY: $0.10 per minute of video, per language. A 90-minute
// service in three languages is $27 from one POST, which is why the route in
// front of it is capability-gated and rate-limited.
//
// Everything bunny can generate BESIDES captions is explicitly off:
//
//   generateTitle/generateDescription — titles here are admin-authored. A
//     transcription job must never rename someone's library.
//   generateChapters/generateMoments  — this repo already has chapters
//     (lib/chapters.js + lib/chaptersStore.js), typed by an admin. Two writers
//     for one concept is how hand-written chapters get silently replaced. AI
//     chapters belong behind an explicit "accept" action, not a background
//     write.
//
// `force` re-runs transcription on a video that already has it — a second
// charge for the same minutes — so it defaults to false and must be opted in.
export function transcribeVideo(id, { sourceLanguage, force = false } = {}) {
  return api(`/videos/${id}/transcribe${force ? '?force=true' : ''}`, {
    method: 'POST',
    body: {
      ...(sourceLanguage ? { sourceLanguage } : {}),
      generateTitle: false,
      generateDescription: false,
      generateChapters: false,
      generateMoments: false,
    },
  });
}

// Fetches one caption track's WebVTT text, SERVER-SIDE ONLY.
//
// Caption files sit on the pull zone at /{guid}/captions/{srclang}.vtt. This
// returns the VTT *text*, never the URL, and no caller is given a way to get
// the URL — so the transcript inherits the video's access gate instead of
// being readable by anyone who learns a GUID. That matters because a
// transcript is the whole content of a private video in text form.
//
// The signed URL is deliberately short-lived: it only has to survive this
// server-side fetch, unlike thumbnails which a browser re-requests.
export async function fetchCaptionVtt(guid, srclang) {
  const id = String(guid || '').trim();
  const lang = String(srclang || '').trim();
  // Path traversal would turn this into an arbitrary pull-zone fetch.
  if (!/^[0-9a-f-]{10,64}$/i.test(id) || !/^[A-Za-z0-9-]{2,12}$/.test(lang)) {
    return null;
  }
  const url = signedCdnUrl(`/${id}/captions/${lang}.vtt`, 300);
  if (!url) return null;
  const res = await fetch(url);
  // A 404 is the ordinary "not transcribed yet" answer, not a failure.
  if (!res.ok) return null;
  return res.text();
}
