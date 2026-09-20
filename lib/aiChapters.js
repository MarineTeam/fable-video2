// bunny.net's AI chapter suggestions, read into this repo's chapter shape.
//
// PURE — imports only lib/chapters.js, which imports nothing. The admin Videos
// tab renders suggestions in the browser, so anything pulled in here lands in
// the client bundle; the same split as chapters.js / chaptersStore.js.
//
// SUGGESTIONS ARE NOT CHAPTERS. Nothing here writes, and the route that calls
// it writes nothing either. A suggestion becomes a chapter only when an admin
// loads it into the chapters textarea and saves, through the same
// /api/admin/chapters + parseChapters path a typed list takes. That is the
// whole feature: bunny can generate chapters from the transcript, but a second
// writer for the `chapters` hash is how hand-written ones get silently
// replaced, so the AI may propose and only a person may accept.
//
// SHAPE, and what is guessed about it. bunny's video object documents chapters
// as `[{ title, start, end }]` with the times in SECONDS, and moments as
// `[{ label, timestamp }]`. `title`/`start` are the documented names; the rest
// are accepted as fallbacks because this has never run against a live
// transcription job — a field spelled differently than the docs say should
// cost one wrong label, not an empty list with no explanation. Whatever cannot
// be read is REPORTED, never dropped quietly: the admin has to be able to tell
// 'bunny generated nothing' from 'bunny generated something we could not read'.
import { MAX_CHAPTERS, formatTimestamp, normalizeChapterLabel } from './chapters';

// Documented name first; the rest are the defensive fallbacks described above.
const TIME_KEYS = ['start', 'timestamp', 'time'];
const LABEL_KEYS = ['title', 'label', 'text'];

function readTime(entry) {
  for (const key of TIME_KEYS) {
    const value = entry?.[key];
    // Empty and null are skipped rather than coerced: Number('') is 0, which
    // would turn a missing field into a chapter at 0:00 that reads like a real
    // suggestion.
    if (value === null || value === undefined || value === '') continue;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return seconds;
  }
  return null;
}

function readLabel(entry) {
  for (const key of LABEL_KEYS) {
    const label = normalizeChapterLabel(entry?.[key]);
    if (label) return label;
  }
  return null;
}

// Reads a bunny video object's `chapters` (falling back to `moments`, the same
// idea under another name) into { chapters, ignored }.
//
// The return shape mirrors parseChapters deliberately — including the duration
// and duplicate-timestamp rules, so a suggestion is held to exactly the same
// standard as a line the admin typed, and the panel can report what was
// skipped the way it already does.
export function suggestedChapters(video, { durationSeconds = 0 } = {}) {
  const raw =
    Array.isArray(video?.chapters) && video.chapters.length
      ? video.chapters
      : Array.isArray(video?.moments)
        ? video.moments
        : [];

  const chapters = [];
  const ignored = [];
  const seen = new Set();

  raw.forEach((entry, i) => {
    const index = i + 1;
    const label = readLabel(entry);
    const text = label || '';

    if (chapters.length >= MAX_CHAPTERS) {
      ignored.push({ index, text, reason: `Over the ${MAX_CHAPTERS}-chapter limit` });
      return;
    }
    const seconds = readTime(entry);
    if (seconds === null || seconds < 0) {
      ignored.push({ index, text, reason: 'No usable start time' });
      return;
    }
    const at = Math.floor(seconds);
    if (!label) {
      ignored.push({ index, text: formatTimestamp(at), reason: 'No title' });
      return;
    }
    // A duration of 0 means 'unknown' (bunny reports 0 while encoding), the
    // same rule parseChapters follows.
    if (durationSeconds > 0 && at > durationSeconds) {
      ignored.push({
        index,
        text: label,
        reason: `Past the end of the video (${formatTimestamp(durationSeconds)})`,
      });
      return;
    }
    if (seen.has(at)) {
      ignored.push({ index, text: label, reason: 'Duplicate timestamp' });
      return;
    }
    seen.add(at);
    chapters.push({ at, label });
  });

  chapters.sort((a, b) => a.at - b.at);
  return { chapters, ignored };
}

// Whether a suggested list would change anything. Lets the panel say 'these
// match what you already have' instead of offering a replacement that does
// nothing — and makes Accept feel safe, because the one case where it costs
// the admin nothing is named out loud.
export function sameChapters(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  if (left.length !== right.length) return false;
  return left.every((chapter, i) => {
    const other = right[i];
    return (
      Math.floor(Number(chapter?.at)) === Math.floor(Number(other?.at)) &&
      String(chapter?.label || '') === String(other?.label || '')
    );
  });
}
