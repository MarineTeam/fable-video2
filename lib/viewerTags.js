import { redis, k } from './redis';
import { normalizeEmail } from './auth';

export const MAX_TAG_LENGTH = 40;
export const MAX_TAGS_PER_VIEWER = 20;

export function normalizeTag(raw) {
  const tag = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, MAX_TAG_LENGTH);
  return tag || null;
}

// The Upstash client auto-serializes objects on write and parses JSON on
// read, but a raw string value (written by some other tool, or left over
// from a differently-shaped record) is handled defensively too.
function parseTags(value) {
  if (Array.isArray(value)) return value.filter((t) => typeof t === 'string');
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((t) => typeof t === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

// email -> sorted tag list, for every viewer that has at least one tag.
export async function getAllViewerTags() {
  try {
    const raw = (await redis().hgetall(k('viewer:tags'))) || {};
    const out = {};
    for (const [email, value] of Object.entries(raw)) {
      const tags = parseTags(value);
      if (tags.length) out[email] = [...tags].sort();
    }
    return out;
  } catch {
    return {};
  }
}

export function distinctTags(tagsByEmail) {
  const set = new Set();
  for (const tags of Object.values(tagsByEmail)) {
    for (const tag of tags) set.add(tag);
  }
  return [...set].sort();
}

export function emailsForTag(tagsByEmail, tag) {
  return Object.entries(tagsByEmail)
    .filter(([, tags]) => tags.includes(tag))
    .map(([email]) => email)
    .sort();
}

// Adds `tag` to each of `emails`, mirroring the shares-bulk/videos-bulk
// idiom: every email is processed independently, one bad email never aborts
// the rest of the batch. Only currently-approved viewers can be tagged.
export async function addTagToViewers(emails, tag) {
  const cleanTag = normalizeTag(tag);
  if (!cleanTag) return emails.map((email) => ({ email, ok: false, error: 'Bad tag' }));
  const r = redis();
  return Promise.all(
    emails.map(async (rawEmail) => {
      const email = normalizeEmail(rawEmail);
      if (!email) return { email: rawEmail, ok: false, error: 'Bad email' };
      try {
        const isViewer = (await r.sismember(k('viewers'), email)) === 1;
        if (!isViewer) return { email, ok: false, error: 'Not an approved viewer' };
        const current = parseTags(await r.hget(k('viewer:tags'), email));
        if (!current.includes(cleanTag)) {
          const next = [...current, cleanTag].slice(0, MAX_TAGS_PER_VIEWER);
          await r.hset(k('viewer:tags'), { [email]: next });
        }
        return { email, ok: true };
      } catch {
        return { email, ok: false, error: 'Failed' };
      }
    })
  );
}

export async function removeTagFromViewers(emails, tag) {
  const cleanTag = normalizeTag(tag);
  if (!cleanTag) return emails.map((email) => ({ email, ok: false, error: 'Bad tag' }));
  const r = redis();
  return Promise.all(
    emails.map(async (rawEmail) => {
      const email = normalizeEmail(rawEmail);
      if (!email) return { email: rawEmail, ok: false, error: 'Bad email' };
      try {
        const current = parseTags(await r.hget(k('viewer:tags'), email));
        const next = current.filter((t) => t !== cleanTag);
        if (next.length) await r.hset(k('viewer:tags'), { [email]: next });
        else await r.hdel(k('viewer:tags'), email);
        return { email, ok: true };
      } catch {
        return { email, ok: false, error: 'Failed' };
      }
    })
  );
}

// Called when a viewer is removed outright, so no orphaned tag data survives
// the viewer's own removal from the `viewers` set.
export async function clearViewerTags(email) {
  const norm = normalizeEmail(email);
  if (!norm) return;
  try {
    await redis().hdel(k('viewer:tags'), norm);
  } catch {
    // best-effort, same idiom as lastseen cleanup in viewers.js
  }
}
