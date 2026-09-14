import { describe, it, expect } from 'vitest';
import {
  parseTimestamp,
  formatTimestamp,
  normalizeChapterLabel,
  parseChapters,
  chaptersToText,
  parseStoredChapters,
  MAX_CHAPTERS,
  MAX_CHAPTER_LABEL_LENGTH,
} from '../chapters';

describe('parseTimestamp', () => {
  it('accepts every documented format', () => {
    expect(parseTimestamp('0:00')).toBe(0);
    expect(parseTimestamp('8:05')).toBe(485); // M:SS
    expect(parseTimestamp('18:30')).toBe(1110); // MM:SS
    expect(parseTimestamp('1:11:00')).toBe(4260); // H:MM:SS
    expect(parseTimestamp('  24:15  ')).toBe(1455);
  });

  // A typo should be reported, not guessed at — '1:5' is ambiguous between
  // 1:05 and 1:50, so it is refused rather than silently read as one of them.
  it('refuses ambiguous or malformed input rather than guessing', () => {
    expect(parseTimestamp('1:5')).toBeNull();
    expect(parseTimestamp('24')).toBeNull();
    expect(parseTimestamp('')).toBeNull();
    expect(parseTimestamp('sermon')).toBeNull();
    expect(parseTimestamp('1:2:3:4')).toBeNull();
    expect(parseTimestamp(null)).toBeNull();
  });

  it('refuses impossible seconds and minutes', () => {
    expect(parseTimestamp('1:60')).toBeNull();
    expect(parseTimestamp('1:99:00')).toBeNull();
    // Without an hours part, a large minute count is legitimate: a 90-minute
    // recording is reasonably written 90:00.
    expect(parseTimestamp('90:00')).toBe(5400);
  });
});

describe('formatTimestamp', () => {
  it('drops the hour when there is none and pads otherwise', () => {
    expect(formatTimestamp(0)).toBe('0:00');
    expect(formatTimestamp(485)).toBe('8:05');
    expect(formatTimestamp(4260)).toBe('1:11:00');
  });

  it('round-trips with parseTimestamp', () => {
    for (const seconds of [0, 59, 485, 1110, 4260, 5400]) {
      expect(parseTimestamp(formatTimestamp(seconds))).toBe(seconds);
    }
  });

  it('is null-safe and never negative', () => {
    expect(formatTimestamp(null)).toBe('0:00');
    expect(formatTimestamp(-10)).toBe('0:00');
  });
});

describe('normalizeChapterLabel', () => {
  it('trims, collapses whitespace and caps length', () => {
    expect(normalizeChapterLabel('  Sermon   part  two ')).toBe('Sermon part two');
    expect(normalizeChapterLabel('x'.repeat(200))).toHaveLength(MAX_CHAPTER_LABEL_LENGTH);
    expect(normalizeChapterLabel('   ')).toBeNull();
  });
});

describe('parseChapters', () => {
  it('parses a normal list', () => {
    const { chapters, ignored } = parseChapters(
      '0:00 Worship\n18:30 Announcements\n24:15 Sermon\n1:11:00 Communion'
    );
    expect(ignored).toEqual([]);
    expect(chapters).toEqual([
      { at: 0, label: 'Worship' },
      { at: 1110, label: 'Announcements' },
      { at: 1455, label: 'Sermon' },
      { at: 4260, label: 'Communion' },
    ]);
  });

  // Input order is never trusted.
  it('sorts by timestamp regardless of the order typed', () => {
    const { chapters } = parseChapters('24:15 Sermon\n0:00 Worship\n18:30 Announcements');
    expect(chapters.map((c) => c.label)).toEqual(['Worship', 'Announcements', 'Sermon']);
  });

  it('ignores blank lines without treating them as errors', () => {
    const { chapters, ignored } = parseChapters('\n0:00 Worship\n\n  \n24:15 Sermon\n');
    expect(chapters).toHaveLength(2);
    expect(ignored).toEqual([]);
  });

  // The whole point of returning `ignored`: a dropped line must be reportable
  // back to the admin with its original line number.
  it('reports junk lines with a reason and the original line number', () => {
    const { chapters, ignored } = parseChapters('0:00 Worship\nthis is not a chapter\n24:15 Sermon');
    expect(chapters).toHaveLength(2);
    expect(ignored).toHaveLength(1);
    expect(ignored[0]).toMatchObject({ line: 2, text: 'this is not a chapter' });
    expect(ignored[0].reason).toMatch(/timestamp/i);
  });

  it('reports a timestamp with no title', () => {
    const { chapters, ignored } = parseChapters('24:15');
    expect(chapters).toEqual([]);
    expect(ignored[0].reason).toMatch(/title/i);
  });

  it('reports a duplicate timestamp rather than keeping both', () => {
    const { chapters, ignored } = parseChapters('0:00 Worship\n0:00 Also worship');
    expect(chapters).toHaveLength(1);
    expect(ignored[0].reason).toMatch(/duplicate/i);
  });

  it('handles empty input', () => {
    expect(parseChapters('')).toEqual({ chapters: [], ignored: [] });
    expect(parseChapters(null)).toEqual({ chapters: [], ignored: [] });
  });

  describe('timestamps past the end of the video', () => {
    it('reports them when the duration is known', () => {
      const { chapters, ignored } = parseChapters('0:00 Worship\n2:00:00 Way too late', {
        durationSeconds: 5400,
      });
      expect(chapters).toHaveLength(1);
      expect(ignored[0].reason).toMatch(/past the end/i);
    });

    // Bunny reports 0 while a video is still encoding, so "unknown" must not
    // be read as "zero length" and reject every chapter.
    it('does not apply the check when the duration is unknown', () => {
      const { chapters, ignored } = parseChapters('2:00:00 Late', { durationSeconds: 0 });
      expect(chapters).toHaveLength(1);
      expect(ignored).toEqual([]);
    });

    it('accepts a chapter exactly at the final second', () => {
      const { chapters } = parseChapters('1:30:00 End', { durationSeconds: 5400 });
      expect(chapters).toHaveLength(1);
    });
  });

  it('caps the list and reports the overflow', () => {
    const text = Array.from({ length: MAX_CHAPTERS + 5 }, (_, i) => `${i}:00 Chapter ${i}`).join('\n');
    const { chapters, ignored } = parseChapters(text);
    expect(chapters).toHaveLength(MAX_CHAPTERS);
    expect(ignored).toHaveLength(5);
    expect(ignored[0].reason).toMatch(/limit/i);
  });

  it('keeps multi-word titles intact', () => {
    const { chapters } = parseChapters('24:15 Sermon — Philippians 4:13');
    expect(chapters[0].label).toBe('Sermon — Philippians 4:13');
  });
});

describe('chaptersToText', () => {
  it('round-trips through parseChapters', () => {
    const source = '0:00 Worship\n18:30 Announcements\n1:11:00 Communion';
    const { chapters } = parseChapters(source);
    expect(chaptersToText(chapters)).toBe(source);
    expect(parseChapters(chaptersToText(chapters)).chapters).toEqual(chapters);
  });

  it('is null-safe', () => {
    expect(chaptersToText(null)).toBe('');
  });
});

describe('parseStoredChapters', () => {
  it('reads the stored array and re-sorts it', () => {
    expect(parseStoredChapters([{ at: 60, label: 'B' }, { at: 0, label: 'A' }])).toEqual([
      { at: 0, label: 'A' },
      { at: 60, label: 'B' },
    ]);
  });

  it('reads a raw JSON string too', () => {
    expect(parseStoredChapters('[{"at":0,"label":"A"}]')).toEqual([{ at: 0, label: 'A' }]);
  });

  it('drops unusable entries rather than rendering them', () => {
    expect(
      parseStoredChapters([
        { at: 0, label: 'Good' },
        { at: 'nope', label: 'Bad time' },
        { at: 10 },
        { at: -5, label: 'Negative' },
        null,
        'string',
      ])
    ).toEqual([{ at: 0, label: 'Good' }]);
  });

  it('returns an empty list for unusable input', () => {
    expect(parseStoredChapters(null)).toEqual([]);
    expect(parseStoredChapters('not json')).toEqual([]);
    expect(parseStoredChapters({})).toEqual([]);
  });
});
