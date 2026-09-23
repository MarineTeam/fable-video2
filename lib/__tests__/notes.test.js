import { describe, it, expect } from 'vitest';
import {
  normalizeNotes,
  noteMatches,
  matchingNoteGuids,
  parseStoredNotes,
  MAX_NOTES_LENGTH,
} from '../notes';

describe('normalizeNotes', () => {
  it('keeps line breaks, which are the whole point of a notes field', () => {
    expect(normalizeNotes('Line one\nLine two')).toBe('Line one\nLine two');
  });

  it('folds CRLF so stored text is stable across browsers', () => {
    expect(normalizeNotes('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('collapses runs of blank lines but keeps a single one', () => {
    expect(normalizeNotes('a\n\nb')).toBe('a\n\nb');
    expect(normalizeNotes('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('strips trailing spaces per line', () => {
    expect(normalizeNotes('a   \nb\t\n')).toBe('a\nb');
  });

  // Tabs and newlines are real formatting here and must survive; the invisible
  // characters that are not formatting must not.
  it('strips control and zero-width characters but keeps tabs', () => {
    expect(normalizeNotes('a\u0000b')).toBe('ab');
    expect(normalizeNotes('a\u200bb')).toBe('ab');
    expect(normalizeNotes('\ufeffleading')).toBe('leading');
    expect(normalizeNotes('a\u2028b')).toBe('ab');
    expect(normalizeNotes('col\tumn')).toBe('col\tumn');
  });

  it('clamps length', () => {
    expect(normalizeNotes('x'.repeat(MAX_NOTES_LENGTH + 500))).toHaveLength(MAX_NOTES_LENGTH);
  });

  // null is the store's signal to delete the key, so blank input resets
  // rather than persisting an empty notes section.
  it('returns null for anything empty', () => {
    expect(normalizeNotes('')).toBeNull();
    expect(normalizeNotes('   \n\n  ')).toBeNull();
    expect(normalizeNotes(null)).toBeNull();
    expect(normalizeNotes(undefined)).toBeNull();
  });
});

describe('noteMatches', () => {
  const notes = 'Philippians 4:4-9 — contentment and the peace of God.';

  it('matches case-insensitively on a substring', () => {
    expect(noteMatches(notes, 'philippians')).toBe(true);
    expect(noteMatches(notes, 'PEACE')).toBe(true);
    // A partial word must match: someone typing 'philipp' is looking for this.
    expect(noteMatches(notes, 'philipp')).toBe(true);
  });

  it('does not match absent text', () => {
    expect(noteMatches(notes, 'romans')).toBe(false);
  });

  it('never matches on an empty query', () => {
    expect(noteMatches(notes, '')).toBe(false);
    expect(noteMatches(notes, '   ')).toBe(false);
    expect(noteMatches(notes, null)).toBe(false);
  });

  it('is safe on missing notes', () => {
    expect(noteMatches(null, 'anything')).toBe(false);
    expect(noteMatches(undefined, 'anything')).toBe(false);
  });
});

describe('matchingNoteGuids', () => {
  const notesByGuid = {
    'guid-b': 'On Philippians and contentment',
    'guid-a': 'A study in Romans',
    'guid-c': 'Nothing relevant here',
  };

  it('returns the matching guids, sorted for a stable order', () => {
    expect(matchingNoteGuids(notesByGuid, 'philipp')).toEqual(['guid-b']);
    expect(matchingNoteGuids(notesByGuid, 'a')).toEqual(['guid-a', 'guid-b', 'guid-c']);
  });

  it('returns nothing for an empty query, rather than everything', () => {
    expect(matchingNoteGuids(notesByGuid, '')).toEqual([]);
    expect(matchingNoteGuids(notesByGuid, '  ')).toEqual([]);
    expect(matchingNoteGuids(notesByGuid, null)).toEqual([]);
  });

  it('is safe on missing input', () => {
    expect(matchingNoteGuids(null, 'x')).toEqual([]);
    expect(matchingNoteGuids({}, 'x')).toEqual([]);
  });
});

describe('parseStoredNotes', () => {
  it('normalises a stored string', () => {
    expect(parseStoredNotes('a\r\nb')).toBe('a\nb');
  });

  it('returns null for a missing value', () => {
    expect(parseStoredNotes(null)).toBeNull();
    expect(parseStoredNotes(undefined)).toBeNull();
    expect(parseStoredNotes('')).toBeNull();
  });
});

describe('passage matching in notes', () => {
  const abbreviated = 'Text: Phil 1:27-2:11\nUnity and humility';

  it('finds a passage written in a different spelling', () => {
    // Before: typing 'Philippians' could not find 'Phil'.
    expect(noteMatches(abbreviated, 'Philippians')).toBe(true);
    expect(noteMatches(abbreviated, 'philippians 2')).toBe(true);
    expect(noteMatches(abbreviated, 'Php 2:5')).toBe(true);
  });

  it('matches by OVERLAP, not only an equal passage', () => {
    expect(noteMatches(abbreviated, 'Philippians 1:30')).toBe(true);
    expect(noteMatches(abbreviated, 'Philippians 2:12')).toBe(false);
    expect(noteMatches(abbreviated, 'Colossians 2')).toBe(false);
  });

  it('only ADDS matches — the substring rule still applies', () => {
    expect(noteMatches(abbreviated, 'phil')).toBe(true);
    expect(noteMatches(abbreviated, 'humil')).toBe(true);
  });

  it('flows through matchingNoteGuids, the one caller /api/videos uses', () => {
    const notesByGuid = {
      'guid-a': 'Phil 1:27-2:11',
      'guid-b': 'Philippians 4:10-20',
      'guid-c': 'Harbour tour',
    };
    expect(matchingNoteGuids(notesByGuid, 'Philippians 2')).toEqual(['guid-a']);
    expect(matchingNoteGuids(notesByGuid, 'Philippians')).toEqual(['guid-a', 'guid-b']);
  });
});
