// lib/videoCleanup.js forgetVideo, and BOTH delete paths using it.
//
// Before forgetVideo, the single delete kept its own list of per-video rows
// to clear and the bulk delete had none — a bulk delete left every video's
// schedule, chapters, notes, transcript, public flag and score behind.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cleared = [];
let failing = null;
const clearer = (name) => async (id) => {
  cleared.push(`${name}:${id}`);
  if (failing === name) throw new Error('redis down');
};
vi.mock('../scheduleStore', () => ({ clearVideoWindow: clearer('window') }));
vi.mock('../chaptersStore', () => ({ clearVideoChapters: clearer('chapters') }));
vi.mock('../notesStore', () => ({ clearVideoNotes: clearer('notes') }));
vi.mock('../captionsStore', () => ({ clearVideoTranscript: clearer('transcript') }));
vi.mock('../publicVideosStore', () => ({ clearVideoPublic: clearer('public') }));
vi.mock('../ratingsStore', () => ({ clearVideoRatingCounts: clearer('rating') }));
vi.mock('../commentsStore', () => ({ clearComments: clearer('comments') }));
// 'default' is how a watermark override is removed, so the mode is recorded
// too: any other mode would SET an override on the deleted video.
vi.mock('../watermark', () => ({
  setVideoMode: async (id, mode) => {
    cleared.push(`watermark:${id}:${mode}`);
  },
}));
vi.mock('../privateList', () => ({ clearPrivateList: clearer('privatelist') }));

const { forgetVideo } = await import('../videoCleanup');
const EVERYTHING = ['window', 'chapters', 'notes', 'transcript', 'public', 'rating', 'comments', 'privatelist'];
const expected = (id) =>
  [...EVERYTHING.map((n) => `${n}:${id}`), `watermark:${id}:default`].sort();

beforeEach(() => {
  cleared.length = 0;
  failing = null;
});

describe('forgetVideo', () => {
  it('clears every kind of per-video data', async () => {
    await forgetVideo('vid-1');
    expect(cleared.sort()).toEqual(expected('vid-1'));
  });

  it('carries on when one store fails', async () => {
    failing = 'notes';
    await expect(forgetVideo('vid-1')).resolves.toBeUndefined();
    expect(cleared).toHaveLength(EVERYTHING.length + 1);
  });

  it('does nothing without an id', async () => {
    await forgetVideo('  ');
    expect(cleared).toEqual([]);
  });
});
