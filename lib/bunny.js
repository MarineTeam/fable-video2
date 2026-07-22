import crypto from 'crypto';

// bunny.net Stream API. Server-side only — the API key must never reach the
// client. Env values are trimmed because a stray newline pasted into Vercel
// corrupts TUS signatures.

const API_BASE = 'https://video.bunnycdn.com';

const env = (name) => (process.env[name] || '').trim();
const libraryId = () => env('BUNNY_LIBRARY_ID');
const apiKey = () => env('BUNNY_API_KEY');

async function api(path, { method = 'GET', body } = {}) {
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
