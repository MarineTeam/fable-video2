// Per-video notes: what the talk covered, passages referenced, anything worth
// finding again months later.
//
// PURE — imports only lib/scripture.js (pure too), for the same reason as
// lib/chapters.js: the watch page renders notes during render, so importing
// lib/redis here would reach Node built-ins and fail the client build. Redis
// lives in lib/notesStore.js.
//
// Additive: no stored entry means no notes section and a page identical to
// today's.

import { parsePassageQuery, parseReferences, passageMatches } from './scripture';
import { queryStems, stemSet, stemsMatch } from './stem';

export const MAX_NOTES_LENGTH = 4000;

// C0/C1 controls plus the zero-width and bidi characters that survive a
// trim. Written as escapes on purpose: invisible characters in source are
// unreviewable. TAB (\u0009) and LF (\u000a) are deliberately absent --
// they are real formatting in a notes field, not noise.
const STRIP = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g;

// Admin-authored, but still normalised: CRLF folded so stored text is stable
// across browsers, control and zero-width characters stripped, trailing spaces
// and runs of blank lines collapsed, and the whole thing clamped.
//
// Rendering is plain text with preserved line breaks. React escapes text
// nodes, so there is no markup to sanitise — which is precisely why markup is
// not accepted in the first place.
export function normalizeNotes(raw) {
  const text = String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(STRIP, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_NOTES_LENGTH);
  return text || null;
}

// Case-insensitive substring match. Deliberately not word-boundary or fuzzy:
// someone searching 'philipp' should find 'Philippians', which a word-boundary
// match would miss.
//
// A query that IS a scripture reference ('Philippians', 'phil 2', 'Phil
// 2:1-11') also matches notes citing an OVERLAPPING passage in any spelling —
// 'Philippians 2' finds 'Phil 1:27-2:11'. That only adds matches. `passage`
// is the parsed query, passed in by matchingNoteGuids so a search parses it
// once rather than once per note.
//
// A query's WORDS also match by stem (lib/stem.js): 'baptism' finds notes
// saying 'baptised', every word somewhere, in any order. Also additive. A
// passage query is answered by passage overlap ALONE — stems would read
// 'Philippians 2' as the word 'philippians' and widen it to the whole book.
// `stems` is the query's stems, passed in by matchingNoteGuids for the same
// parse-once reason as `passage`.
export function noteMatches(
  notes,
  query,
  passage = parsePassageQuery(query),
  stems = passage ? [] : queryStems(query)
) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return false;
  if (String(notes || '').toLowerCase().includes(q)) return true;
  if (passage) return passageMatches(parseReferences(notes), passage);
  return stemsMatch(stemSet(notes), stems);
}

// The guids whose notes match, for widening a search Bunny has already run
// over titles. Sorted for a stable order; the caller still applies every
// access filter to whatever comes back.
export function matchingNoteGuids(notesByGuid, query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const passage = parsePassageQuery(q);
  const stems = passage ? [] : queryStems(q);
  return Object.entries(notesByGuid || {})
    .filter(([, notes]) => noteMatches(notes, q, passage, stems))
    .map(([guid]) => guid)
    .sort();
}

export function parseStoredNotes(value) {
  if (typeof value === 'string') return normalizeNotes(value);
  // A non-string (an object left by another tool) is not usable as notes.
  return value === null || value === undefined ? null : normalizeNotes(String(value));
}
