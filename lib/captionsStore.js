import { redis, k } from './redis';
import { MAX_CUES, transcriptText } from './captions';

// Redis side of transcripts, kept apart from lib/captions.js so the pure
// parsing and searching stay importable from client-rendered code (see the
// note there) — the same split this repo uses for chapters, notes, schedule,
// podcast and public videos.
//
// TWO hashes, and the reason is the access pattern rather than tidiness:
//
//   k('transcripts')      videoGuid -> [{ start, end, text }, ...]
//   k('transcript_text')  videoGuid -> the same words as one string
//
// The watch page wants one video's cues and reads a single field. Library
// search wants "which videos said this?" across everything, which is one
// hgetall — and cues are bulky (~1,500 per 90-minute service, two timings
// each). Pulling all of that to use none of the timings is a cost that only
// shows up once the library is large. The text hash is a fraction of the size
// and is the only thing search touches.
//
// Reads fail back to "no transcript". A transcript is sugar over a video that
// plays fine without it, so an unreadable value must degrade to today's
// behaviour rather than break the watch page — same posture as
// lib/chaptersStore.js.

function parseCues(raw) {
  if (!raw) return [];
  try {
    // Upstash may hand back an already-parsed value or a JSON string
    // depending on what was written; accept both rather than assuming.
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(value)) return [];
    return value
      .filter((cue) => cue && typeof cue.text === 'string')
      .slice(0, MAX_CUES)
      .map((cue) => ({
        start: Number(cue.start) || 0,
        end: Number(cue.end) || 0,
        text: cue.text,
      }));
  } catch {
    return [];
  }
}

export async function getVideoTranscript(guid) {
  try {
    return parseCues(await redis().hget(k('transcripts'), guid));
  } catch {
    return [];
  }
}

// videoGuid -> plain transcript text, for library search. Deliberately NOT the
// cue array — see the two-hash note above.
export async function loadAllTranscriptText() {
  try {
    const raw = (await redis().hgetall(k('transcript_text'))) || {};
    const out = {};
    for (const [guid, value] of Object.entries(raw)) {
      if (typeof value === 'string' && value) out[guid] = value;
    }
    return out;
  } catch {
    return {};
  }
}

// Which videos have a transcript at all, without pulling any bodies.
export async function loadTranscribedGuids() {
  try {
    const guids = await redis().hkeys(k('transcripts'));
    return new Set(Array.isArray(guids) ? guids.map(String) : []);
  } catch {
    return new Set();
  }
}

// Writes both hashes together. Callers pass cues from parseVtt().
export async function setVideoTranscript(guid, cues) {
  const id = String(guid || '').trim();
  if (!id) return { ok: false, error: 'Bad video id' };
  const list = Array.isArray(cues) ? cues.slice(0, MAX_CUES) : [];
  if (!list.length) return clearVideoTranscript(id);
  try {
    await redis().hset(k('transcripts'), { [id]: JSON.stringify(list) });
    await redis().hset(k('transcript_text'), { [id]: transcriptText(list) });
    return { ok: true, cues: list.length };
  } catch {
    // A write failure is worth reporting, unlike a read: the admin pressed a
    // button and is owed an answer.
    return { ok: false, error: 'Could not store the transcript' };
  }
}

export async function clearVideoTranscript(guid) {
  const id = String(guid || '').trim();
  if (!id) return { ok: false, error: 'Bad video id' };
  try {
    await redis().hdel(k('transcripts'), id);
    await redis().hdel(k('transcript_text'), id);
    return { ok: true, cues: 0 };
  } catch {
    return { ok: false, error: 'Could not clear the transcript' };
  }
}

// --- The queue of transcriptions waiting to be collected -------------------
//
//   k('transcribe_pending')  videoGuid -> epoch ms when it was queued
//
// A marker, not a job: nothing runs it. The admin video list checks these and
// ingests whatever bunny has finished (see lib/transcribeQueue.js for why).
// Every function here swallows its own errors — a marker that cannot be
// written costs the admin the second click they used to make anyway, and must
// never fail the request that spent the money.
export async function markTranscribePending(guid) {
  const id = String(guid || '').trim();
  if (!id) return;
  try {
    await redis().hset(k('transcribe_pending'), { [id]: Date.now() });
  } catch {
    // best-effort
  }
}

export async function getTranscribePending() {
  try {
    return (await redis().hgetall(k('transcribe_pending'))) || {};
  } catch {
    return {};
  }
}

export async function clearTranscribePending(guids) {
  const ids = (Array.isArray(guids) ? guids : [guids])
    .map((g) => String(g || '').trim())
    .filter(Boolean);
  if (!ids.length) return;
  try {
    await redis().hdel(k('transcribe_pending'), ...ids);
  } catch {
    // best-effort
  }
}
