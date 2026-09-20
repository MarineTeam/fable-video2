// Collecting a finished transcription without the admin's second click.
//
// This runs on a request an admin made for something else, so the rule that
// matters most is that it can never make that request fail — and just behind
// it, that a marker is only cleared when the work is genuinely done or
// genuinely hopeless. Clearing early loses a transcript already paid for,
// with nothing left to say it is missing.
//
// One difference from the sibling repo, and the reason this file is not a
// copy: setVideoTranscript here REPORTS failure ({ ok: false }) rather than
// throwing, so an unsuccessful write has to be read. Treating it as collected
// would clear the marker on a transcript that was never stored.
import { beforeEach, describe, expect, it, vi } from 'vitest';

let pending = {};
let videos = {};
let vttByKey = {};
let stored = {};
let getVideoThrows = false;
let storeOk = true;

vi.mock('../bunny', () => ({
  getVideo: async (guid) => {
    if (getVideoThrows) throw new Error('bunny down');
    return videos[guid] || {};
  },
  fetchCaptionVtt: async (guid, lang) => vttByKey[`${guid}:${lang}`] || '',
}));
vi.mock('../captionsStore', () => ({
  getTranscribePending: async () => pending,
  clearTranscribePending: async (guids) => {
    for (const guid of Array.isArray(guids) ? guids : [guids]) delete pending[guid];
  },
  setVideoTranscript: async (guid, cues) => {
    if (!storeOk) return { ok: false, error: 'redis down' };
    stored[guid] = cues;
    return { ok: true };
  },
}));

const { collectFinishedTranscripts } = await import('../transcriptCollect');

const OLD = Date.now() - 10 * 60 * 1000;
const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhello there\n';

beforeEach(() => {
  pending = {};
  videos = {};
  vttByKey = {};
  stored = {};
  getVideoThrows = false;
  storeOk = true;
});

describe('collecting', () => {
  beforeEach(() => {
    pending = { 'vid-1': OLD };
    videos['vid-1'] = { guid: 'vid-1', captions: [{ srclang: 'en' }] };
    vttByKey['vid-1:en'] = vtt;
  });

  it('stores the transcript and clears the marker', async () => {
    const result = await collectFinishedTranscripts();
    expect(stored['vid-1']).toHaveLength(1);
    expect(pending['vid-1']).toBeUndefined();
    expect(result.collected).toEqual([{ guid: 'vid-1', language: 'en', cues: 1 }]);
  });

  it('prefers English when bunny produced several, like the manual fetch', async () => {
    videos['vid-1'].captions = [{ srclang: 'de' }, { srclang: 'en' }];
    vttByKey['vid-1:de'] = vtt;
    const result = await collectFinishedTranscripts();
    expect(result.collected[0].language).toBe('en');
  });
});

describe('leaving a marker alone', () => {
  it('keeps waiting when bunny has produced no captions yet', async () => {
    pending = { 'vid-1': OLD };
    videos['vid-1'] = { guid: 'vid-1', captions: [] };
    await collectFinishedTranscripts();
    expect(pending['vid-1']).toBe(OLD);
  });

  it('keeps waiting when the STORE reports a failed write', async () => {
    // The case this repo has and the sibling does not. A cleared marker here
    // would mean a paid-for transcription silently never appears.
    pending = { 'vid-1': OLD };
    videos['vid-1'] = { guid: 'vid-1', captions: [{ srclang: 'en' }] };
    vttByKey['vid-1:en'] = vtt;
    storeOk = false;
    const result = await collectFinishedTranscripts();
    expect(pending['vid-1']).toBe(OLD);
    expect(result.collected).toEqual([]);
  });

  it('keeps waiting when bunny fails, so a blip is retried', async () => {
    pending = { 'vid-1': OLD };
    getVideoThrows = true;
    await collectFinishedTranscripts();
    expect(pending['vid-1']).toBe(OLD);
  });
});

describe('never breaking the request it rides on', () => {
  it('does not throw when bunny is down', async () => {
    pending = { 'vid-1': OLD };
    getVideoThrows = true;
    await expect(collectFinishedTranscripts()).resolves.toBeTruthy();
  });

  it('does nothing at all when nothing is pending', async () => {
    expect(await collectFinishedTranscripts()).toEqual({ collected: [], expired: [] });
  });
});

describe('giving up', () => {
  it('drops a marker past the deadline without fetching it', async () => {
    pending = { ancient: Date.now() - 48 * 60 * 60 * 1000 };
    const result = await collectFinishedTranscripts();
    expect(result.expired).toEqual(['ancient']);
    expect(pending.ancient).toBeUndefined();
    expect(stored.ancient).toBeUndefined();
  });
});
