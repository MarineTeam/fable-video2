import { redis, k } from './redis';
import { normalizeEmail } from './auth';

// Self-serve access requests. A signed-in but unapproved user can file exactly
// one pending request; an admin approves or dismisses it from the Viewers tab.
//
//   k('access-requests')  email -> { email, note, at }
//
// One HASH rather than a list: the email IS the identity everywhere else in
// this app, so keying by it makes a repeat request an idempotent overwrite
// instead of a way to flood the queue. The cap below is a second line of
// defence behind the per-email rate limit on the route.

export const MAX_PENDING_REQUESTS = 200;
export const MAX_NOTE_LENGTH = 200;

export function normalizeNote(raw) {
  const note = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, MAX_NOTE_LENGTH);
  return note;
}

function parseRequest(email, value) {
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object') return null;
  return {
    email,
    note: typeof raw.note === 'string' ? raw.note.slice(0, MAX_NOTE_LENGTH) : '',
    at: typeof raw.at === 'string' ? raw.at : null,
  };
}

// Oldest first — the queue is worked front to back.
export function sortRequests(requests) {
  return [...requests].sort((a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0));
}

export async function loadAccessRequests() {
  const raw = (await redis().hgetall(k('access-requests'))) || {};
  const out = [];
  for (const [email, value] of Object.entries(raw)) {
    const parsed = parseRequest(email, value);
    if (parsed) out.push(parsed);
  }
  return sortRequests(out);
}

export async function countAccessRequests() {
  try {
    return await redis().hlen(k('access-requests'));
  } catch {
    return 0;
  }
}

// Returns { ok, duplicate } — a repeat request from the same address is a
// deliberate no-op rather than an error, so the UI can say "already pending"
// without the caller learning anything they didn't already know.
export async function recordAccessRequest(email, note) {
  const norm = normalizeEmail(email);
  if (!norm) return { ok: false, error: 'Bad email' };
  const r = redis();
  const existing = await r.hget(k('access-requests'), norm);
  if (existing) return { ok: true, duplicate: true };
  if ((await countAccessRequests()) >= MAX_PENDING_REQUESTS) {
    return { ok: false, error: 'Too many pending requests' };
  }
  await r.hset(k('access-requests'), {
    [norm]: { email: norm, note: normalizeNote(note), at: new Date().toISOString() },
  });
  return { ok: true, duplicate: false };
}

export async function removeAccessRequest(email) {
  const norm = normalizeEmail(email);
  if (!norm) return;
  try {
    await redis().hdel(k('access-requests'), norm);
  } catch {
    // best-effort: an approval must not fail because the queue entry lingered
  }
}
