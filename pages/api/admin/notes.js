import { withMonitorApi } from '../../../lib/monitor';
import { requireActor } from '../../../lib/guard';
import { guidInScope } from '../../../lib/staffScope';
import { CAP } from '../../../lib/capabilities';
import { logAction } from '../../../lib/audit';
import { normalizeNotes } from '../../../lib/notes';
import { setVideoNotes } from '../../../lib/notesStore';

// Sets a video's notes. videos.manage — the same capability as renaming it.
// Reading is not here: notes ship with the video list in /api/admin/videos so
// the tab needs one fetch, the reasoning admin/schedule.js documents.
//
// The guard runs before req.method is inspected, so an unauthorised caller
// cannot learn the route's expected verb from a 405.
async function handler(req, res) {
  const actor = await requireActor(req, res, CAP.VIDEOS_MANAGE);
  if (!actor) return;
  const admin = actor.email;

  if (req.method === 'POST') {
    const guid = String(req.body?.guid || '');
    if (!/^[0-9a-f-]{10,64}$/i.test(guid)) return res.status(400).json({ error: 'Bad video id' });
    // A group-scoped caller edits only videos their groups grant.
    if (!(await guidInScope(actor, guid))) return res.status(404).json({ error: 'Video not found' });
    const notes = normalizeNotes(req.body?.notes);
    try {
      await setVideoNotes(guid, notes);
      await logAction(
        admin,
        'video.notes',
        notes ? `${guid}: ${notes.length} chars` : `${guid}: cleared`
      );
      return res.json({ ok: true, notes });
    } catch {
      return res.status(500).json({ error: 'Could not save the notes' });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}

export default withMonitorApi(handler);
