import { getVideo, signedEmbedUrl } from './bunny';
import { isValidVideoGuid, resolvePublicAccess } from './publicVideos';
import { isVideoPublic } from './publicVideosStore';
import { getVideoWindow } from './scheduleStore';
import { getVideoChapters } from './chaptersStore';
import { getVideoNotes } from './notesStore';
import { getSiteName } from './siteNameStore';
import { isGeoAllowed } from './geo';

// THE PUBLIC DOOR. One video, no account, nothing else.
//
// This is a separate page on purpose rather than an "or public" branch inside
// pages/watch/[id].js, /api/videos or /api/collections. Those three are the
// invite-only gates, and every future change to them would otherwise have to
// re-reason about an anonymous case. Everything an anonymous visitor can reach
// is in this one file, so auditing it means reading this file.
//
// What this page deliberately does NOT do:
//   * no search, no collection list, no counts, no "other videos" — nothing
//     that reveals the library exists or how big it is;
//   * no progress tracking, no viewer activity, no push subscription — all of
//     those are keyed by email and there is no email here;
//   * no group evaluation — groups narrow *viewer* access and a visitor is not
//     a viewer;
//   * no watermark. The watermark stamps the viewer's own address as
//     identity-based deterrence; with no identity there is nothing truthful to
//     stamp, and a blank or invented overlay would be worse than none.
//
// What it still does:
//   * default deny — only a guid explicitly in the public set is served, and
//     the store fails CLOSED if that set cannot be read;
//   * the publish window still applies, so scheduling is not bypassed by
//     ticking "public";
//   * the VIEWER geo whitelist still applies. A public visitor is not a
//     viewer, but the whitelist exists to say where this content may be
//     watched, and that intent does not stop applying because the watcher is
//     anonymous. It is off by default, so this changes nothing unless the
//     operator turned it on;
//   * playback is a signed, time-limited embed token exactly as everywhere
//     else. "Public" means no login required. It does not mean an unsigned or
//     permanent URL.
//
// Every refusal returns the SAME notFound. A visitor cannot tell a private
// video from an unpublished one from a guid that never existed, so the route
// is not an oracle for what the library contains.
//
// Lives here rather than inline in the page so it can be tested directly:
// the page file is JSX, which the test runner cannot import. This IS the
// route's logic — the page calls exactly this — not a second copy of it.
export async function publicWatchProps({ req, res, params }) {
  const id = String(params.id || '');
  if (!isValidVideoGuid(id)) return { notFound: true };

  const [isPublic, window] = await Promise.all([isVideoPublic(id), getVideoWindow(id)]);
  const { allowed } = resolvePublicAccess({ isPublic, window });
  if (!allowed) return { notFound: true };

  // Anonymous, so the viewer whitelist rather than the admin one.
  if (!(await isGeoAllowed(req, { admin: false, email: '' }))) {
    return { props: { state: 'blocked', siteName: await getSiteName() } };
  }

  let video;
  try {
    video = await getVideo(id);
  } catch {
    return { notFound: true };
  }
  if (!video?.guid) return { notFound: true };

  const [chapters, notes, siteName] = await Promise.all([
    getVideoChapters(video.guid),
    getVideoNotes(video.guid),
    getSiteName(),
  ]);

  return {
    props: {
      state: 'ok',
      siteName,
      video: { guid: video.guid, title: video.title || 'Untitled', length: video.length || 0 },
      // Signed fresh on every request — never a permanent URL.
      embedUrl: signedEmbedUrl(video.guid),
      chapters,
      notes,
    },
  };
}
