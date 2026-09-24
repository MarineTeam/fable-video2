import { withMonitorApi } from "../../../lib/monitor";
import { requireCapability, resolveActor } from '../../../lib/guard';
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
  const admin = await requireCapability(req, res, CAP.VIDEOS_UPLOAD);
  if (!admin) return;
  if (!(await allowRequest('upload', admin, 20, 3600))) {
    return res.status(429).json({ error: 'Too many uploads, slow down' });
  }

  const title = String(req.body?.title || '').trim().slice(0, 200) || 'Untitled';
  const collectionId = typeof req.body?.collectionId === 'string' ? req.body.collectionId : '';

  // Groups this upload should be visible to. Everything that can refuse the
  // request is decided HERE, before the bunny.net video exists — a refusal
  // after createVideo would leave an orphan in the library.
  let groupIds = [];
  const requestedGroups = req.body?.groupIds;
  if (requestedGroups !== undefined && requestedGroups !== null) {
    // Granting a group is a groups.manage act, whatever form it arrives
    // through: videos.upload and groups.manage are separate capabilities.
    // requireCapability returns only the EMAIL in this repo, so the actor is
    // resolved here — and an owner holds everything, as in requireCapability.
    const actor = await resolveActor(admin);
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
