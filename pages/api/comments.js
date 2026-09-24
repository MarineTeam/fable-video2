import { withMonitorApi } from '../../lib/monitor';
import { auth0 } from '../../lib/auth0';
import { requireViewer, resolveActor } from '../../lib/guard';
import { CAP, hasCapability } from '../../lib/capabilities';
import { oneTrimmed } from '../../lib/params';
import { allowRequest } from '../../lib/ratelimit';
import { logAction } from '../../lib/audit';
import { contentScopeFor, isVideoVisible } from '../../lib/groups';
import { isVideoInWindowFor } from '../../lib/scheduleStore';
import { getVideo } from '../../lib/bunny';
import { cleanCommentText, commentView, displayName } from '../../lib/comments';
import { addComment, deleteComment, getComment, listComments } from '../../lib/commentsStore';

// Comments under a video.
//
//   GET    ?guid=...             -> { comments: [...] }, oldest first
//   POST   { guid, text }        -> { comment } — added as the caller
//   DELETE ?guid=...&id=...      -> removes one comment
//
// GATED LIKE WATCHING, in the watch page's order: approved viewer + geo
// (requireViewer), the video must exist, group content gating
// (contentScopeFor/isVideoVisible), and — for reading and writing, staff
// exempt — the publish window. Every refusal is the same 404, so the route
// cannot be used to learn which ids exist. Deleting your own comment skips the
// window check only: a viewer can always take back what they said.
//
// IDENTITY COMES FROM THE SESSION. No request field names a person; "is this
// mine?" is decided by the stored email. Other viewers see a display name only
// (lib/comments.js); the email is shown solely to a caller who can already read
// the viewer list (viewers.read), per architecture contract I3g.
//
// MODERATION: live at once; the author may delete, and so may an owner or a
// comments.manage holder. Removing someone else's comment is audited.
const GUID = /^[0-9a-f-]{10,64}$/i;

async function handler(req, res) {
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const viewer = await requireViewer(req, res);
  if (!viewer) return;

  const guid = req.method === 'POST' ? oneTrimmed(req.body?.guid) : oneTrimmed(req.query.guid);
  if (!guid || !GUID.test(guid)) return res.status(400).json({ error: 'Bad video id' });

  const admin = Boolean(viewer.admin || viewer.staff);
  let video;
  try {
    video = await getVideo(guid);
  } catch {
    return res.status(404).json({ error: 'Not found' });
  }
  if (!video?.guid) return res.status(404).json({ error: 'Not found' });
  const scope = await contentScopeFor(viewer.email, { staff: admin });
  if (!isVideoVisible(scope, video)) return res.status(404).json({ error: 'Not found' });

  const actor = await resolveActor(viewer.email);
  const holds = (cap) => actor.owner || hasCapability(actor.capabilities, cap);
  const canModerate = holds(CAP.COMMENTS_MANAGE);
  const viewOptions = { email: viewer.email, canModerate, canSeeEmails: holds(CAP.VIEWERS_READ) };
  const inWindow = async () => admin || (await isVideoInWindowFor(video.guid, viewer.email));

  if (req.method === 'GET') {
    if (!(await inWindow())) return res.status(404).json({ error: 'Not found' });
    try {
      const comments = await listComments(video.guid);
      return res.json({ comments: comments.map((c) => commentView(c, viewOptions)) });
    } catch {
      return res.status(502).json({ error: 'Could not load comments' });
    }
  }

  // Writes: rate limited per person (seconds as a NUMBER — this repo's
  // allowRequest builds `${n} s`).
  if (!(await allowRequest('comment', viewer.email, 30, 3600))) {
    return res.status(429).json({ error: 'Too many comments — try again later' });
  }

  if (req.method === 'POST') {
    if (!(await inWindow())) return res.status(404).json({ error: 'Not found' });
    const cleaned = cleanCommentText(req.body?.text);
    if (!cleaned.ok) return res.status(400).json({ error: cleaned.error });

    let profileName = '';
    try {
      profileName = (await auth0.getSession(req, res))?.user?.name || '';
    } catch {
      // The name falls back to the email's local part; the comment still posts.
    }
    try {
      const result = await addComment(video.guid, {
        email: viewer.email,
        name: displayName(profileName, viewer.email),
        text: cleaned.text,
      });
      if (!result.ok) return res.status(409).json({ error: 'This video has reached its comment limit' });
      return res.json({ comment: commentView(result.comment, viewOptions) });
    } catch {
      return res.status(502).json({ error: 'Could not save your comment' });
    }
  }

  // DELETE
  let comment;
  try {
    comment = await getComment(video.guid, oneTrimmed(req.query.id));
  } catch {
    return res.status(502).json({ error: 'Could not delete the comment' });
  }
  if (!comment) return res.status(404).json({ error: 'Not found' });
  const mine = comment.email === viewer.email;
  if (!mine && !canModerate) {
    return res.status(403).json({ error: 'You can only delete your own comments' });
  }
  try {
    await deleteComment(video.guid, comment.id);
  } catch {
    return res.status(502).json({ error: 'Could not delete the comment' });
  }
  if (!mine) {
    await logAction(viewer.email, 'comment.delete', `${video.guid}: a comment by ${comment.name}`).catch(() => {});
  }
  return res.json({ ok: true });
}

export default withMonitorApi(handler);
