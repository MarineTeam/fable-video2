// The AI-suggestion reader, and the route that serves it.
//
// Two things must not drift. A suggestion must stay a SUGGESTION: reading one
// back writes nothing, so a transcription job can never replace a chapter list
// an admin typed. And the route SPENDS MONEY, so the free branches must not be
// able to reach the paid call — not even with the rate limit exhausted.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_CHAPTERS, MAX_CHAPTER_LABEL_LENGTH } from '../chapters';
import { sameChapters, suggestedChapters } from '../aiChapters';

describe('suggestedChapters: bunny’s documented shape', () => {
  it('reads { title, start } in seconds', () => {
    expect(
      suggestedChapters({
        chapters: [
          { title: 'Worship', start: 0, end: 1110 },
          { title: 'Sermon', start: 1455, end: 3600 },
        ],
      }).chapters
    ).toEqual([
      { at: 0, label: 'Worship' },
      { at: 1455, label: 'Sermon' },
    ]);
  });

  it('falls back to moments when there are no chapters', () => {
    expect(
      suggestedChapters({ chapters: [], moments: [{ label: 'Baptism', timestamp: 300 }] }).chapters
    ).toEqual([{ at: 300, label: 'Baptism' }]);
  });

  it('prefers chapters over moments when both exist', () => {
    expect(
      suggestedChapters({
        chapters: [{ title: 'Sermon', start: 60 }],
        moments: [{ label: 'Baptism', timestamp: 300 }],
      }).chapters
    ).toEqual([{ at: 60, label: 'Sermon' }]);
  });

  it('returns nothing, and reports nothing, for a video with neither', () => {
    expect(suggestedChapters({})).toEqual({ chapters: [], ignored: [] });
    expect(suggestedChapters(null)).toEqual({ chapters: [], ignored: [] });
    expect(suggestedChapters({ chapters: 'not an array' })).toEqual({ chapters: [], ignored: [] });
  });
});

describe('suggestedChapters: what it refuses to guess', () => {
  it('does not turn a missing or blank start into 0:00', () => {
    // Number('') and Number(null) are both 0, which would plant a chapter at
    // the top of the video that reads like a real suggestion.
    const { chapters, ignored } = suggestedChapters({
      chapters: [
        { title: 'Blank', start: '' },
        { title: 'Null', start: null },
        { title: 'Junk', start: 'later' },
      ],
    });
    expect(chapters).toEqual([]);
    expect(ignored.map((row) => row.reason)).toEqual([
      'No usable start time',
      'No usable start time',
      'No usable start time',
    ]);
  });

  it('reads a numeric string start, which is still unambiguous', () => {
    expect(suggestedChapters({ chapters: [{ title: 'Sermon', start: '90' }] }).chapters).toEqual([
      { at: 90, label: 'Sermon' },
    ]);
  });

  it('skips a negative start', () => {
    expect(suggestedChapters({ chapters: [{ title: 'Early', start: -5 }] }).chapters).toEqual([]);
  });

  it('skips an untitled suggestion and names the time it was at', () => {
    const { chapters, ignored } = suggestedChapters({ chapters: [{ title: '   ', start: 75 }] });
    expect(chapters).toEqual([]);
    expect(ignored).toEqual([{ index: 1, text: '1:15', reason: 'No title' }]);
  });

  it('floors a fractional start rather than storing it', () => {
    expect(suggestedChapters({ chapters: [{ title: 'Sermon', start: 60.8 }] }).chapters).toEqual([
      { at: 60, label: 'Sermon' },
    ]);
  });
});

describe('suggestedChapters: held to the same rules a typed line is', () => {
  it('collapses whitespace and truncates an over-long title', () => {
    const { chapters } = suggestedChapters({
      chapters: [{ title: `  Sermon   part  ${'x'.repeat(MAX_CHAPTER_LABEL_LENGTH)}`, start: 1 }],
    });
    expect(chapters[0].label).toHaveLength(MAX_CHAPTER_LABEL_LENGTH);
    expect(chapters[0].label.startsWith('Sermon part ')).toBe(true);
  });

  it('drops a duplicate timestamp, the way parseChapters does', () => {
    const { chapters, ignored } = suggestedChapters({
      chapters: [
        { title: 'Sermon', start: 60 },
        { title: 'Sermon again', start: 60 },
      ],
    });
    expect(chapters).toEqual([{ at: 60, label: 'Sermon' }]);
    expect(ignored[0].reason).toBe('Duplicate timestamp');
  });

  it('drops a suggestion past the end of the video when the duration is known', () => {
    const video = { chapters: [{ title: 'Impossible', start: 9999 }] };
    expect(suggestedChapters(video, { durationSeconds: 3600 }).chapters).toEqual([]);
    // Duration 0 means "still encoding", so the rule does not apply yet.
    expect(suggestedChapters(video).chapters).toHaveLength(1);
  });

  it('stops at the chapter limit and reports the overflow', () => {
    const many = Array.from({ length: MAX_CHAPTERS + 3 }, (_, i) => ({
      title: `Part ${i}`,
      start: i * 10,
    }));
    const { chapters, ignored } = suggestedChapters({ chapters: many });
    expect(chapters).toHaveLength(MAX_CHAPTERS);
    expect(ignored).toHaveLength(3);
  });

  it('sorts by timestamp whatever order bunny returned', () => {
    const { chapters } = suggestedChapters({
      chapters: [
        { title: 'Sermon', start: 1455 },
        { title: 'Worship', start: 0 },
      ],
    });
    expect(chapters.map((c) => c.label)).toEqual(['Worship', 'Sermon']);
  });
});

describe('sameChapters', () => {
  const list = [
    { at: 0, label: 'Worship' },
    { at: 60, label: 'Sermon' },
  ];

  it('is true for identical lists and empty ones', () => {
    expect(sameChapters(list, list.map((c) => ({ ...c })))).toBe(true);
    expect(sameChapters([], [])).toBe(true);
    expect(sameChapters(null, undefined)).toBe(true);
  });

  it('is false when a time, a label or the length differs', () => {
    expect(sameChapters(list, [{ at: 0, label: 'Worship' }, { at: 61, label: 'Sermon' }])).toBe(false);
    expect(sameChapters(list, [{ at: 0, label: 'worship' }, { at: 60, label: 'Sermon' }])).toBe(false);
    expect(sameChapters(list, list.slice(0, 1))).toBe(false);
  });
});

// --- the route ------------------------------------------------------------

let admin = 'admin@example.com';
let allowed = true;
let video = {};

const transcribeVideo = vi.fn(async () => ({ ok: true }));
const getVideo = vi.fn(async () => video);
const fetchCaptionVtt = vi.fn(async () => 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhello\n');
const setVideoTranscript = vi.fn(async () => ({ ok: true }));
const logAction = vi.fn(async () => {});

vi.mock('../guard', () => ({
  requireCapability: async (req, res) => {
    if (!admin) {
      res.status(403).json({ error: 'Not allowed' });
      return null;
    }
    return admin;
  },
}));
vi.mock('../ratelimit', () => ({ allowRequest: async () => allowed }));
vi.mock('../bunny', () => ({
  transcribeVideo: (...args) => transcribeVideo(...args),
  getVideo: (...args) => getVideo(...args),
  fetchCaptionVtt: (...args) => fetchCaptionVtt(...args),
}));
vi.mock('../captionsStore', () => ({
  setVideoTranscript: (...args) => setVideoTranscript(...args),
}));
vi.mock('../audit', () => ({ logAction: (...args) => logAction(...args) }));

const route = (await import('../../pages/api/admin/transcribe')).default;

const GUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

async function call(body, method = 'POST') {
  const out = { statusCode: 200, body: undefined };
  const res = {
    status(code) {
      out.statusCode = code;
      return res;
    },
    json(payload) {
      out.body = payload;
      res.headersSent = true;
      return res;
    },
    setHeader: () => res,
    end() {
      res.headersSent = true;
      return res;
    },
    headersSent: false,
  };
  await route({ method, body, query: {}, headers: {}, url: '/' }, res);
  return out;
}

beforeEach(() => {
  admin = 'admin@example.com';
  allowed = true;
  video = { guid: GUID, captions: [], chapters: [] };
  transcribeVideo.mockClear();
  getVideo.mockClear();
  setVideoTranscript.mockClear();
  logAction.mockClear();
});

describe('the paid branch', () => {
  it('needs the capability and respects the rate limit', async () => {
    admin = null;
    expect((await call({ guid: GUID })).statusCode).toBe(403);
    admin = 'admin@example.com';
    allowed = false;
    expect((await call({ guid: GUID })).statusCode).toBe(429);
    expect(transcribeVideo).not.toHaveBeenCalled();
  });

  it('leaves chapter generation off unless it was asked for in so many words', async () => {
    await call({ guid: GUID });
    expect(transcribeVideo.mock.calls[0][1].generateChapters).toBe(false);
    // Truthy is not enough — the same rule `force` follows.
    await call({ guid: GUID, chapters: 'yes' });
    expect(transcribeVideo.mock.calls[1][1].generateChapters).toBe(false);
  });

  it('asks for chapters when the admin ticked the box, and says so in the audit log', async () => {
    const res = await call({ guid: GUID, chapters: true });
    expect(transcribeVideo.mock.calls[0][1].generateChapters).toBe(true);
    expect(res.body.chapters).toBe(true);
    expect(logAction.mock.calls[0][2]).toContain('chapter suggestions');
  });
});

describe('reading suggestions back', () => {
  beforeEach(() => {
    video = {
      guid: GUID,
      length: 3600,
      chapters: [
        { title: 'Worship', start: 0 },
        { title: 'Sermon', start: 1455 },
      ],
    };
  });

  it('returns the parsed proposal', async () => {
    const res = await call({ guid: GUID, suggestions: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.chapters).toEqual([
      { at: 0, label: 'Worship' },
      { at: 1455, label: 'Sermon' },
    ]);
  });

  it('WRITES NOTHING — not the chapters, not the transcript, not the audit log', async () => {
    await call({ guid: GUID, suggestions: true });
    expect(setVideoTranscript).not.toHaveBeenCalled();
    expect(logAction).not.toHaveBeenCalled();
  });

  it('never spends money, even with the rate limit exhausted', async () => {
    allowed = false;
    const res = await call({ guid: GUID, suggestions: true });
    expect(res.statusCode).toBe(200);
    expect(transcribeVideo).not.toHaveBeenCalled();
  });

  it('still needs the capability', async () => {
    admin = null;
    const res = await call({ guid: GUID, suggestions: true });
    expect(res.statusCode).toBe(403);
    expect(getVideo).not.toHaveBeenCalled();
  });

  it('applies the video duration it just read', async () => {
    video = { guid: GUID, length: 60, chapters: [{ title: 'Impossible', start: 9999 }] };
    const res = await call({ guid: GUID, suggestions: true });
    expect(res.body.chapters).toEqual([]);
    expect(res.body.ignored[0].reason).toContain('Past the end');
  });

  it('answers with an empty proposal when bunny generated nothing', async () => {
    video = { guid: GUID };
    expect((await call({ guid: GUID, suggestions: true })).body).toEqual({
      ok: true,
      chapters: [],
      ignored: [],
    });
  });
});

describe('the other free branch', () => {
  it('ingest does not queue a paid job', async () => {
    video = { guid: GUID, captions: [{ srclang: 'en' }] };
    const res = await call({ guid: GUID, ingest: true });
    expect(res.statusCode).toBe(200);
    expect(transcribeVideo).not.toHaveBeenCalled();
    expect(setVideoTranscript).toHaveBeenCalled();
  });

  it('rejects a bad guid before anything else', async () => {
    expect((await call({ guid: 'nope' })).statusCode).toBe(400);
    expect(transcribeVideo).not.toHaveBeenCalled();
  });
});
