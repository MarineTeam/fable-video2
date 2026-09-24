import { clearVideoWindow } from './scheduleStore';
import { clearVideoChapters } from './chaptersStore';
import { clearVideoNotes } from './notesStore';
import { clearVideoTranscript } from './captionsStore';
import { clearVideoPublic } from './publicVideosStore';
import { clearVideoRatingCounts } from './ratingsStore';
import { clearComments } from './commentsStore';
import { setVideoMode } from './watermark';
import { clearPrivateList } from './privateList';

// Everything this portal stores ABOUT one video, forgotten when the video is
// deleted — so a recycled bunny.net guid never opens with another video's
// schedule, chapters, notes, transcript, public flag, score, conversation,
// watermark setting or private invite list,
// and nothing is left behind that no path will ever collect.
//
// ONE list, called by BOTH delete paths (pages/api/admin/videos.js and the
// bulk route, pages/api/admin/videos-bulk.js). Before this existed each path
// kept its own list and the bulk one had none: a bulk delete left every one
// of these rows behind. A per-video decoration added later is one line here.
//
// The saved order and group grants are pruned by the callers, because both
// are single records rewritten once per batch rather than once per video.
//
// Best-effort, every part independently: one store being unreachable must not
// stop the others, and the video itself is already gone.
export async function forgetVideo(guid) {
  const id = String(guid || '').trim();
  if (!id) return;
  await Promise.allSettled([
    clearVideoWindow(id),
    clearVideoChapters(id),
    clearVideoNotes(id),
    clearVideoTranscript(id),
    clearVideoPublic(id),
    clearVideoRatingCounts(id),
    clearComments(id),
    // 'default' is how a per-video watermark override is removed.
    setVideoMode(id, 'default'),
    clearPrivateList(id),
  ]);
}
