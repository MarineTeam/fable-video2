import { withMonitorApi } from '../../../lib/monitor';
import { requireCapability } from '../../../lib/guard';
import { allowRequest } from '../../../lib/ratelimit';
import { logAction } from '../../../lib/audit';
import { normalizeEmail, isValidEmail } from '../../../lib/auth';
import { CAP } from '../../../lib/capabilities';
import { redis, k } from '../../../lib/redis';
import {
  loadGroups,
  loadGroupMemberships,
  sortedGroups,
  saveGroup,
  deleteGroup,
  setGroupsForEmail,
  setMembersOfGroup,
  membersOfGroup,
  normalizeGroupName,
  groupIdFromName,
  isValidGroupId,
  groupGatingEnabled,
  groupDefaultAccess,
  MAX_GROUPS,
} from '../../../lib/groups';

// Group administration: the registry, membership in both directions, and each
// group's content scope. Whether that scope has any effect on what members can
// see is a separate, deployment-level decision (GROUP_CONTENT_GATING) — this
// route reports it via `gating` so the UI can say plainly whether scopes are
// live or just recorded.
async function handler(req, res) {
  const admin = await requireCapability(req, res, CAP.GROUPS_MANAGE);
  if (!admin) return;
  if (req.method !== 'GET' && !(await allowRequest('groups', admin, 20, 60))) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  if (req.method === 'GET') {
    try {
      const [groupsById, memberships, defaultAccess] = await Promise.all([
        loadGroups(),
        loadGroupMemberships(),
        groupDefaultAccess(),
      ]);
      const groups = sortedGroups(groupsById).map((g) => ({
        ...g,
        members: membersOfGroup(memberships, g.id),
      }));
      return res.json({
        groups,
        memberships,
        gating: { enabled: groupGatingEnabled(), defaultAccess },
      });
    } catch {
      return res.status(500).json({ error: 'Could not load groups' });
    }
  }

  if (req.method === 'POST') {
    const name = normalizeGroupName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Bad group name' });
    try {
      const existing = await loadGroups();
      if (Object.keys(existing).length >= MAX_GROUPS) {
        return res.status(400).json({ error: `At most ${MAX_GROUPS} groups` });
      }
      const result = await saveGroup({ id: groupIdFromName(name), name });
      if (!result.ok) return res.status(400).json({ error: result.error });
      await logAction(admin, 'group.create', name);
      return res.json({ group: { ...result.group, members: [] } });
    } catch {
      return res.status(500).json({ error: 'Could not create the group' });
    }
  }

  if (req.method === 'PUT') {
    const id = String(req.body?.id || '');
    if (!isValidGroupId(id)) return res.status(400).json({ error: 'Bad group id' });
    const name = normalizeGroupName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Bad group name' });
    try {
      const groupsById = await loadGroups();
      const current = groupsById[id];
      if (!current) return res.status(404).json({ error: 'No such group' });
      const result = await saveGroup({
        ...current,
        name,
        collectionIds: Array.isArray(req.body?.collectionIds)
          ? req.body.collectionIds.map(String)
          : current.collectionIds,
        videoIds: Array.isArray(req.body?.videoIds)
          ? req.body.videoIds.map(String)
          : current.videoIds,
      });
      if (!result.ok) return res.status(400).json({ error: result.error });
      await logAction(
        admin,
        'group.update',
        `${name} · ${result.group.collectionIds.length} collections, ${result.group.videoIds.length} videos`
      );
      return res.json({ group: result.group });
    } catch {
      return res.status(500).json({ error: 'Could not update the group' });
    }
  }

  if (req.method === 'PATCH') {
    // Two membership shapes: per-group (the Groups tab) and per-user (the
    // Viewers tab). Both land in the same email -> [groupId] hash.
    const action = String(req.body?.action || '');
    try {
      if (action === 'set-members') {
        const groupId = String(req.body?.groupId || '');
        if (!isValidGroupId(groupId)) return res.status(400).json({ error: 'Bad group id' });
        const groupsById = await loadGroups();
        if (!groupsById[groupId]) return res.status(404).json({ error: 'No such group' });
        const emails = Array.isArray(req.body?.emails) ? req.body.emails.map(String) : [];
        const result = await setMembersOfGroup(groupId, emails);
        await logAction(
          admin,
          'group.members',
          `${groupsById[groupId].name} · ${result.members.length} members`
        );
        return res.json(result);
      }
      if (action === 'set-groups') {
        const email = normalizeEmail(req.body?.email);
        if (!email || !isValidEmail(email)) return res.status(400).json({ error: 'Bad email' });
        const groupsById = await loadGroups();
        const requested = Array.isArray(req.body?.groupIds) ? req.body.groupIds.map(String) : [];
        const result = await setGroupsForEmail(email, requested, groupsById);
        if (!result.ok) return res.status(400).json({ error: result.error });
        await logAction(
          admin,
          'group.assign',
          `${email} -> ${result.groupIds.length ? result.groupIds.join(', ') : '(none)'}`
        );
        return res.json({ email, groupIds: result.groupIds });
      }
      if (action === 'set-default-access') {
        // What a viewer in NO group sees while gating is on. Live-editable so
        // it never needs a redeploy, exactly like the geo enforcement toggles.
        const value = req.body?.defaultAccess === 'closed' ? 'closed' : 'open';
        await redis().set(k('settings:groupDefaultAccess'), value);
        await logAction(admin, 'group.defaultAccess', value);
        return res.json({ defaultAccess: value });
      }
      return res.status(400).json({ error: 'Bad action' });
    } catch {
      return res.status(500).json({ error: 'Could not update membership' });
    }
  }

  if (req.method === 'DELETE') {
    const id = String(req.query.id || req.body?.id || '');
    if (!isValidGroupId(id)) return res.status(400).json({ error: 'Bad group id' });
    try {
      const groupsById = await loadGroups();
      const current = groupsById[id];
      if (!current) return res.json({ ok: true });
      await deleteGroup(id);
      await logAction(admin, 'group.delete', current.name);
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'Could not delete the group' });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}

export default withMonitorApi(handler);
