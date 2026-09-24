import { randomUUID } from 'node:crypto';
import { redis, k } from './redis';
import { MAX_CUES, isLanguageCode, normalizeLanguages, normalizeSpokenText, transcriptText } from './captions';

// Redis side of transcripts, kept apart from lib/captions.js so the pure
// parsing and searching stay importable from client-rendered code (see the
// note there) — the same split this repo uses for chapters, notes, schedule,
// podcast and public videos.
//
// TWO hashes, and the reason is the access pattern rather than tidiness:
//
//   k('transcripts')       videoGuid -> [{ start, end, text }, ...]  (default)
//   k('transcript_text')   videoGuid -> the same words as one string
//   k('transcripts_alt')   `${videoGuid}:${lang}` -> cues, other languages
//   k('transcript_text_alt') `${videoGuid}:${lang}` -> those words, normalised,
//                          searched inside Redis (matchingTranslatedGuids)
//   k('transcript_langs')  videoGuid -> { default, all: [...] }
//
// The extra languages CANNOT share k('transcripts'): loadTranscribedGuids()
// reads its field names with hkeys to drive the admin badge, so a field named
// `guid:es` there would be reported as a transcribed video that does not
// exist. Two field shapes in one hash is a trap for the next reader as much
// as for that function.
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

// Which languages a video has, and which is its default. Fails soft to "one
// unnamed track", which is what every transcript written before languages
// existed actually is.
export async function getTranscriptLanguages(guid) {
  const id = String(guid || '').trim();
  if (!id) return { default: null, all: [] };
  let raw;
  try {
    raw = await redis().hget(k('transcript_langs'), id);
  } catch {
    return { default: null, all: [] };
  }
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return { default: null, all: [] };
    }
  }
  const all = normalizeLanguages(value?.all);
  const preferred = String(value?.default || '').trim().toLowerCase();
  return { default: all.includes(preferred) ? preferred : all[0] || null, all };
}

// One additional language: its cues for the transcript panel, and its words
// for library search. The words go to their own hash (not the default text
// hash the search route loads), already normalised, because that hash is
// searched INSIDE Redis — see matchingTranslatedGuids.
export async function setTranscriptLanguage(guid, lang, cues) {
  const id = String(guid || '').trim();
  const code = String(lang || '').trim().toLowerCase();
  if (!id || !isLanguageCode(code)) return { ok: false, error: 'Bad request' };
  const list = Array.isArray(cues) ? cues.slice(0, MAX_CUES) : [];
  if (!list.length) return { ok: false, error: 'Empty transcript' };
  try {
    const field = `${id}:${code}`;
    await redis().hset(k('transcripts_alt'), { [field]: JSON.stringify(list) });
    await redis().hset(k('transcript_text_alt'), { [field]: normalizeSpokenText(transcriptText(list)) });
    return { ok: true };
  } catch {
    return { ok: false, error: 'Could not store the transcript' };
  }
}

// Records which languages a video has. `defaultLang` names the track stored in
// the main hash, so a read knows which language it is getting when nobody asks.
export async function setTranscriptLanguages(guid, defaultLang, langs) {
  const id = String(guid || '').trim();
  if (!id) return;
  const all = normalizeLanguages(langs);
  const preferred = String(defaultLang || '').trim().toLowerCase();
  try {
    if (!all.length) {
      await redis().hdel(k('transcript_langs'), id);
      return;
    }
    await redis().hset(k('transcript_langs'), {
      [id]: JSON.stringify({ default: all.includes(preferred) ? preferred : all[0], all }),
    });
  } catch {
    // best-effort: losing the index costs the picker, not the transcript
  }
}

// With no language, or the video's default one, this reads exactly the field
// it always read — the default track stays where it was, so nothing about an
// existing transcript had to be migrated to add languages beside it.
export async function getVideoTranscript(guid, lang = null) {
  const id = String(guid || '').trim();
  const code = String(lang || '').trim().toLowerCase();
  try {
    if (!code || !isLanguageCode(code)) return parseCues(await redis().hget(k('transcripts'), id));
    const { default: fallback } = await getTranscriptLanguages(id);
    if (code === fallback) return parseCues(await redis().hget(k('transcripts'), id));
    return parseCues(await redis().hget(k('transcripts_alt'), `${id}:${code}`));
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

// Which videos said this in a TRANSLATION — guids only, sorted.
//
// Search in every language without multiplying what every search loads. The
// default track's text is loaded into /api/videos and matched there, as it
// always was; loading every translation the same way would multiply that read
// by the number of languages, to return the same videos. So translations are
// matched where they already are: a short script walks the translation hash
// inside Redis and hands back only the guids whose words contain the query.
//
// Both sides are normalised by the same JavaScript function (Unicode-aware),
// leaving the script a plain byte-for-byte substring find — exactly what
// matchingTranscriptGuids does for the default track. The guids join the same
// note/transcript union in /api/videos, and so go through the same scope and
// publish-window pipeline as every other match. Fails soft, like the reads
// above: losing it costs only these matches.
const TRANSLATED_MATCH_SCRIPT = `
local fields = redis.call("HGETALL", KEYS[1])
local needle = ARGV[1]
local seen = {}
local out = {}
for i = 1, #fields, 2 do
  local id = string.match(fields[i], "^(.+):[^:]+$")
  if id and not seen[id] and string.find(fields[i + 1], needle, 1, true) then
    seen[id] = true
    out[#out + 1] = id
  end
end
return out
`;

export async function matchingTranslatedGuids(query) {
  const needle = normalizeSpokenText(query);
  if (!needle) return [];
  try {
    const ids = await redis().eval(TRANSLATED_MATCH_SCRIPT, [k('transcript_text_alt')], [needle]);
    // String(): the client parses an all-digit id into a number.
    return (Array.isArray(ids) ? ids : []).map((id) => String(id)).sort();
  } catch {
    return [];
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
  if (!id) return;
  // The alt fields are named per language, so the index has to be read BEFORE
  // it is deleted or there is nothing left to say what to clean up. That is
  // why the index exists rather than being derived by scanning.
  const { all } = await getTranscriptLanguages(id);
  try {
    await redis().hdel(k('transcripts'), id);
    await redis().hdel(k('transcript_text'), id);
    await redis().hdel(k('transcript_langs'), id);
    if (all.length) {
      const fields = all.map((code) => `${id}:${code}`);
      await redis().hdel(k('transcripts_alt'), ...fields);
      await redis().hdel(k('transcript_text_alt'), ...fields);
    }
  } catch {
    // best-effort, as before
  }
}

// --- The queue of transcriptions waiting to be collected -------------------
//
//   k('transcribe_pending')  videoGuid -> epoch ms when it was queued
//
// A marker, not a job. The admin video list and the scheduled job
// (pages/api/cron/transcripts.js) check these and ingest whatever bunny has
// finished (see lib/transcribeQueue.js for why).
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

// --- One collector at a time ------------------------------------------------
//
//   k('transcribe_collecting')  random token, expires after five minutes
//
// Collection can start from two places at once — an admin loading the video
// list while the scheduled job runs, or the scheduler delivering one run twice
// (Vercel says it can). Both would fetch the same captions from bunny and log
// the same "collected" line twice. The lock makes the second one skip; the
// work it skipped is still pending and is picked up next time.
//
// The token is compared on release, so a run that outlived its lock can never
// delete a lock a newer run now holds. A lock that cannot be taken is treated
// as held: skipping is always safe here, and collecting twice is the thing
// being prevented.
const COLLECT_LOCK_SECONDS = 5 * 60;
const RELEASE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

export async function acquireCollectLock() {
  const token = `lock-${randomUUID()}`;
  try {
    const ok = await redis().set(k('transcribe_collecting'), token, { nx: true, ex: COLLECT_LOCK_SECONDS });
    return ok === 'OK' ? token : null;
  } catch {
    return null;
  }
}

export async function releaseCollectLock(token) {
  if (!token) return;
  try {
    await redis().eval(RELEASE_LOCK_SCRIPT, [k('transcribe_collecting')], [token]);
  } catch {
    // It expires on its own; the next run waits at most five minutes.
  }
}
