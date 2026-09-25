import { withMonitorApi } from '../../../lib/monitor';
import { requireActor } from '../../../lib/guard';
import { guidInScope } from '../../../lib/staffScope';
import { isScoped, scheduleGroupsProblem } from '../../../lib/staffScopeRules';
import { CAP } from '../../../lib/capabilities';
import { logAction } from '../../../lib/audit';
import { normalizeEntry, normalizeWindow, validateGroupWindows, validateRepeat } from '../../../lib/schedule';
import { loadGroups } from '../../../lib/groups';
import { getVideoWindow, setVideoWindow } from '../../../lib/scheduleStore';
import { oneTrimmed } from '../../../lib/params';

// Sets a video's publish window — the default from/until, an optional weekly
// repeat, and optional per-group windows (lib/schedule.js). The whole entry is
// sent every time, so a save replaces it. videos.manage — the same capability as
// renaming or deleting a video. Reading windows is not here on purpose: they
// ship with the video list in /api/admin/videos, so the Videos tab needs one
// fetch rather than two.
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function describe(guid, window) {
  if (!window) return `${guid}: cleared`;
  let text = `${guid}: ${window.from || 'now'} → ${window.until || 'forever'}`;
  if (window.repeat) {
    const { days, start, end, timeZone } = window.repeat;
    text += `, weekly ${days.map((d) => DAY_NAMES[d]).join('/')} ${start}–${end} ${timeZone}`;
  }
  if (window.groups) text += `, group windows: ${Object.keys(window.groups).join(', ')}`;
  return text;
}

async function handler(req, res) {
  const actor = await requireActor(req, res, CAP.VIDEOS_MANAGE);
  if (!actor) return;
  const admin = actor.email;

  if (req.method === 'POST') {
    const guid = oneTrimmed(req.body?.guid) || '';
    if (!/^[0-9a-f-]{10,64}$/i.test(guid)) return res.status(400).json({ error: 'Bad video id' });
    // A group-scoped caller schedules only videos their groups grant.
    if (!(await guidInScope(actor, guid))) return res.status(404).json({ error: 'Video not found' });
    const base = normalizeWindow({ from: req.body?.from, until: req.body?.until });
    if (base?.invalid) {
      return res.status(400).json({ error: 'The end of the window must be after its start' });
    }
    const repeat = req.body?.repeat ?? null;
    const repeatError = validateRepeat(repeat);
    if (repeatError) return res.status(400).json({ error: repeatError });
    let groups = null;
    if (req.body?.groups != null) {
      let known;
      try {
        known = Object.keys(await loadGroups());
      } catch {
        return res.status(500).json({ error: 'Could not read the groups' });
      }
      const checked = validateGroupWindows(req.body.groups, known);
      if (checked.error) return res.status(400).json({ error: checked.error });
      groups = checked.groups;
    }
    const window = normalizeEntry({ from: base?.from, until: base?.until, repeat, groups });
    // ...and sets per-group windows only for their own groups; every other
    // group's window must come back exactly as stored.
    if (isScoped(actor)) {
      let stored;
      let groupsById;
      try {
        [stored, groupsById] = await Promise.all([getVideoWindow(guid), loadGroups()]);
      } catch {
        return res.status(500).json({ error: 'Could not read the schedule' });
      }
      const problem = scheduleGroupsProblem(actor, stored?.groups, window?.groups, groupsById);
      if (problem) return res.status(403).json({ error: problem });
    }
    try {
      await setVideoWindow(guid, window);
      await logAction(admin, 'video.schedule', describe(guid, window));
      return res.json({ ok: true, window });
    } catch {
      return res.status(500).json({ error: 'Could not save the schedule' });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}

export default withMonitorApi(handler);
