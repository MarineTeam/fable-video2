// Chapter markers for long recordings: 'Worship 0:00 · Sermon 24:15 · …'.
//
// PURE — imports nothing. The watch page and the admin Videos tab both format
// chapters during render, so anything pulled in here lands in the browser
// bundle; importing lib/redis would drag Node built-ins in and fail the client
// build. Redis access lives in lib/chaptersStore.js, the same split as
// schedule.js/scheduleStore.js and siteName.js/siteNameStore.js.
//
// Additive by default: no stored entry means no chapter list and a watch page
// identical to today's.

export const MAX_CHAPTERS = 100;
export const MAX_CHAPTER_LABEL_LENGTH = 80;

// Accepts M:SS, MM:SS and H:MM:SS. Minutes and seconds must be two digits
// once a larger unit precedes them, so '1:5' is rejected rather than silently
// read as 1:05 — a typo should be reported, not guessed at.
const TIMESTAMP = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/;

// Returns seconds, or null when the text is not a timestamp we accept.
export function parseTimestamp(raw) {
  const text = String(raw || '').trim();
  const m = TIMESTAMP.exec(text);
  if (!m) return null;
  const [, h, mm, ss] = m;
  const hours = h === undefined ? 0 : Number(h);
  const minutes = Number(mm);
  const seconds = Number(ss);
  // With an hours part present, minutes must also be a real minute value.
  if (seconds > 59) return null;
  if (h !== undefined && minutes > 59) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

export function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

export function normalizeChapterLabel(raw) {
  const label = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, MAX_CHAPTER_LABEL_LENGTH);
  return label || null;
}

// Parses the admin textarea: one chapter per line, '24:15 Sermon'.
//
// Returns BOTH the accepted chapters and the lines that were ignored, with the
// reason and the original line number. Silently dropping a typo'd line is the
// failure mode that makes an admin think the feature is broken, so the caller
// is expected to show `ignored` back to them.
//
// Sorted by time on the way out — input order is never trusted.
export function parseChapters(text, { durationSeconds = 0 } = {}) {
  const lines = String(text || '').split(/\r?\n/);
  const chapters = [];
  const ignored = [];
  const seen = new Set();

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return; // blank lines are not errors
    if (chapters.length >= MAX_CHAPTERS) {
      ignored.push({ line: i + 1, text: trimmed, reason: `Over the ${MAX_CHAPTERS}-chapter limit` });
      return;
    }
    // Split on the first run of whitespace: everything before is the
    // timestamp, everything after is the label.
    const split = trimmed.search(/\s/);
    const stamp = split === -1 ? trimmed : trimmed.slice(0, split);
    const rest = split === -1 ? '' : trimmed.slice(split + 1);

    const at = parseTimestamp(stamp);
    if (at === null) {
      ignored.push({ line: i + 1, text: trimmed, reason: 'No timestamp at the start of the line' });
      return;
    }
    const label = normalizeChapterLabel(rest);
    if (!label) {
      ignored.push({ line: i + 1, text: trimmed, reason: 'No title after the timestamp' });
      return;
    }
    // A duration of 0 means "unknown" (Bunny reports 0 while encoding), so the
    // check only applies once we actually know how long the video is.
    if (durationSeconds > 0 && at > durationSeconds) {
      ignored.push({
        line: i + 1,
        text: trimmed,
        reason: `Past the end of the video (${formatTimestamp(durationSeconds)})`,
      });
      return;
    }
    if (seen.has(at)) {
      ignored.push({ line: i + 1, text: trimmed, reason: 'Duplicate timestamp' });
      return;
    }
    seen.add(at);
    chapters.push({ at, label });
  });

  chapters.sort((a, b) => a.at - b.at);
  return { chapters, ignored };
}

// The stored shape back into textarea text, so the admin edits what they wrote.
export function chaptersToText(chapters) {
  return (Array.isArray(chapters) ? chapters : [])
    .map((c) => `${formatTimestamp(c.at)} ${c.label}`)
    .join('\n');
}

// Defensive read: the Upstash client parses JSON, but a value written by
// another tool or left over from a differently-shaped record is handled too.
export function parseStoredChapters(value) {
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const at = Number(entry.at);
    const label = normalizeChapterLabel(entry.label);
    if (!Number.isFinite(at) || at < 0 || !label) continue;
    out.push({ at: Math.floor(at), label });
  }
  return out.sort((a, b) => a.at - b.at);
}
