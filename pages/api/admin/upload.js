import { withMonitorApi } from "../../../lib/monitor";
import { requireActor } from '../../../lib/guard';
import { SCOPED_REFUSAL } from '../../../lib/staffScope';
import { effectiveScopeGroups, isScoped } from '../../../lib/staffScopeRules';
import { CAP, hasCapability } from '../../../lib/capabilities';
import { grantVideoToGroups, loadGroups, MAX_SCOPE_ENTRIES } from '../../../lib/groups';
import { planUploadGrants } from '../../../lib/uploadGrants';
import { allowRequest } from '../../../lib/ratelimit';
import { createVideo, tusAuth } from '../../../lib/bunny';
import { logAction } from '../../../lib/audit';

// Creates the Bunny video record and returns a server-signed TUS ticket.
// The browser then streams the file straight to bunny.net — no video bytes
// ever touch this server, and the API key stays here.
async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const actor = await requireActor(req, res, CAP.VIDEOS_UPLOAD);
  if (!actor) return;
  const admin = actor.email;
  const scoped = isScoped(actor);
  if (!(await allowRequest('upload', admin, 20, 3600))) {
    return res.status(429).json({ error: 'Too many uploads, slow down' });
  }

  const title = String(req.body?.title || '').trim().slice(0, 200) || 'Untitled';
  const collectionId = typeof req.body?.collectionId === 'string' ? req.body.collectionId : '';
  // A collection can be granted to groups outside a scoped caller's scope, so
  // choosing one would decide who else sees the video.
  if (scoped && collectionId) return res.status(403).json({ error: SCOPED_REFUSAL });

  // Groups this upload should be visible to. Everything that can refuse the
  // request is decided HERE, before the bunny.net video exists — a refusal
  // after createVideo would leave an orphan in the library.
  let groupIds = [];
  const requestedGroups = req.body?.groupIds;
  if (scoped) {
    // A group-scoped uploader's video goes to their own groups — the ones
    // they chose, or all of them — and never anyone else's. Granting their own
    // groups needs no groups.manage: it is the only way the video lands inside
    // their scope at all.
    let groupsById;
    try {
      groupsById = await loadGroups();
    } catch {
      return res.status(502).json({ error: 'Could not read groups — try again' });
    }
    const mine = effectiveScopeGroups(actor.staffScope, groupsById);
    const wanted = requestedGroups === undefined || requestedGroups === null ? mine : requestedGroups;
    if (Array.isArray(wanted) && wanted.some((id) => typeof id !== 'string' || !mine.includes(id))) {
      return res.status(403).json({ error: 'You can only grant an upload to your own groups' });
    }
    const plan = planUploadGrants(wanted, groupsById, { maxVideosPerGroup: MAX_SCOPE_ENTRIES });
    if (!plan.ok) return res.status(plan.status).json({ error: plan.error });
    if (!plan.groupIds.length) {
      return res.status(400).json({ error: 'Choose at least one of your groups for this video' });
    }
    groupIds = plan.groupIds;
  } else if (requestedGroups !== undefined && requestedGroups !== null) {
    // Granting a group is a groups.manage act, whatever form it arrives
    // through: videos.upload and groups.manage are separate capabilities.
    if (!actor.owner && !hasCapability(actor.capabilities, CAP.GROUPS_MANAGE)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    let groupsById;
    try {
      groupsById = await loadGroups();
    } catch {
      return res.status(502).json({ error: 'Could not read groups — try again' });
    }
    const plan = planUploadGrants(requestedGroups, groupsById, {
      maxVideosPerGroup: MAX_SCOPE_ENTRIES,
    });
    if (!plan.ok) return res.status(plan.status).json({ error: plan.error });
    groupIds = plan.groupIds;
  }

  let created;
  try {
    created = await createVideo(title, collectionId);
    if (!created?.guid) throw new Error('No guid returned');
  } catch {
    return res.status(502).json({ error: 'Could not create video' });
  }
  const { endpoint, headers } = tusAuth(created.guid);
  await logAction(admin, 'video.upload', `"${title}"`);

  // After the video exists, a grant failing must not fail the upload — the
  // browser is about to send the file. Reported per group instead.
  const groups = groupIds.length
    ? await grantVideoToGroups(created.guid, groupIds)
    : { granted: [], failed: [] };
  if (groups.granted.length) {
    await logAction(admin, 'group.grant', `"${title}" -> ${groups.granted.join(', ')}`);
  }
  res.json({ videoId: created.guid, endpoint, headers, groups });
}

export default withMonitorApi(handler);
