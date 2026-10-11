import { withMonitorApi } from '../../../lib/monitor';
import { requireActor } from '../../../lib/guard';
import { SCOPED_REFUSAL } from '../../../lib/staffScope';
import {
  effectiveScopeGroups,
  isScoped,
  leavesNoGroup,
  membershipChangeProblem,
  personInScope,
} from '../../../lib/staffScopeRules';
import { allowRequest } from '../../../lib/ratelimit';
import { logAction } from '../../../lib/audit';
import { normalizeEmail, isValidEmail } from '../../../lib/auth';
import { CAP, hasCapability } from '../../../lib/capabilities';
import { redis, k } from '../../../lib/redis';
import { pruneGroupFromSchedules } from '../../../lib/scheduleStore';
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
//
// MEMBERSHIP IS PEOPLE DATA, so it needs CAP.VIEWERS_READ on top of the
// groups.manage this route is gated on. Until this check existed, a delegated
// groups.manage holder received every group's member addresses AND the whole
// email -> [groupId] map from GET — the approved viewer list by another name,
// from a capability whose label only promises groups. The same applies to the
// membership actions on PATCH: their per-address answer ('not an approved
// viewer') is that list again, one address at a time.
//
// Writing membership needs nothing beyond groups.manage, deliberately: that
// holder can already change what every member of a group sees by editing the
// group's scope or deleting it. What membership adds is visibility of PEOPLE,
// and that is exactly what the viewers.read requirement covers. Managing the
// group registry and its scopes is unaffected — a groups-only manager keeps
// every power they had except naming and changing who is in a group.
async function handler(req, res) {
  const actor = await requireActor(req, res, CAP.GROUPS_MANAGE);
  if (!actor) return;
  const admin = actor.email;
  if (req.method !== 'GET' && !(await allowRequest('groups', admin, 20, 60))) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  // Decided once, used by GET and by the membership actions below. Owners
  // hold the whole catalog by definition and are checked the same way
  // requireCapability checks them — reading only `capabilities` would lock an
  // owner out of the member list they are entitled to.
  const maySeePeople = actor.owner || hasCapability(actor.capabilities, CAP.VIEWERS_READ);
  // Group-scoped staff (lib/staffScopeRules.js) change who is in their own
  // groups and nothing else here: a scope IS what its groups grant, so
  // creating, re-scoping or deleting a group — or the default-access switch —
  // would widen it.
  const scoped = isScoped(actor);
  const action = String(req.body?.action || '');
  if (scoped && (['POST', 'PUT', 'DELETE'].includes(req.method) || action === 'set-default-access')) {
    return res.status(403).json({ error: SCOPED_REFUSAL });
  }

  if (req.method === 'GET') {
    try {
      const [groupsById, memberships, defaultAccess] = await Promise.all([
        loadGroups(),
        loadGroupMemberships(),
        groupDefaultAccess(),
      ]);
      const mine = scoped ? new Set(effectiveScopeGroups(actor.staffScope, groupsById)) : null;
      // A scoped caller's view: their groups, and their people's membership
      // in those groups only.
      const visibleMemberships = mine
        ? Object.fromEntries(
            Object.entries(memberships)
              .map(([email, ids]) => [email, ids.filter((id) => mine.has(id))])
              .filter(([, ids]) => ids.length)
          )
        : memberships;
      const groups = sortedGroups(groupsById).filter((g) => !mine || mine.has(g.id)).map((g) => {
        const members = membersOfGroup(memberships, g.id);
        // A COUNT is not people data; the addresses are. A groups-only
        // manager still sees how big a group is, which is what the scope
        // editor actually needs.
        return maySeePeople
          ? { ...g, members, memberCount: members.length }
          : { ...g, memberCount: members.length };
      });
      return res.json({
        groups,
        ...(maySeePeople ? { memberships: visibleMemberships } : {}),
        canEditMembers: maySeePeople,
        canEditGroups: !scoped,
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
    // Both membership shapes name people; the default-access toggle does not.
    if ((action === 'set-members' || action === 'set-groups') && !maySeePeople) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    try {
      if (action === 'set-members') {
        const groupId = String(req.body?.groupId || '');
        if (!isValidGroupId(groupId)) return res.status(400).json({ error: 'Bad group id' });
        const groupsById = await loadGroups();
        if (!groupsById[groupId]) return res.status(404).json({ error: 'No such group' });
        let emails = Array.isArray(req.body?.emails) ? req.body.emails.map(String) : [];
        // A scoped caller: only their own group; newcomers must already be
        // their people (anyone else is reported like a stranger); and nobody
        // is taken out of their last group — they are kept, and reported.
        let hidden = [];
        const refused = [];
        if (scoped) {
          if (!effectiveScopeGroups(actor.staffScope, groupsById).includes(groupId)) {
            return res.status(404).json({ error: 'No such group' });
          }
          const memberships = await loadGroupMemberships();
          const current = membersOfGroup(memberships, groupId);
          const wanted = [...new Set(emails.map((e) => normalizeEmail(e)).filter(Boolean))];
          hidden = wanted.filter((e) => !current.includes(e) && !personInScope(actor, memberships[e], groupsById));
          emails = wanted.filter((e) => !hidden.includes(e));
          for (const email of current) {
            if (emails.includes(email)) continue;
            const after = (memberships[email] || []).filter((id) => id !== groupId);
            if (leavesNoGroup(after, groupsById)) {
              refused.push(email);
              emails.push(email);
            }
          }
        }
        // Only approved viewers may be put in a group — the rule
        // lib/viewerTags.js has always applied to tagging, and membership is
        // the same claim about the same person. A read failure passes null,
        // which means 'could not check' and leaves today's behaviour rather
        // than emptying a group because Redis blinked.
        let approved = null;
        try {
          approved = new Set((await redis().smembers(k('viewers'))) || []);
        } catch {
          approved = null;
        }
        const planned = await setMembersOfGroup(groupId, emails, { approved });
        const result = scoped
          ? { ...planned, unknown: [...new Set([...planned.unknown, ...hidden])].sort(), refused }
          : planned;
        await logAction(
          admin,
          'group.members',
          `${groupsById[groupId].name} · ${result.members.length} members` +
            (result.unknown.length ? ` (${result.unknown.length} not approved)` : '')
        );
        return res.json(result);
      }
      if (action === 'set-groups') {
        const email = normalizeEmail(req.body?.email);
        if (!email || !isValidEmail(email)) return res.status(400).json({ error: 'Bad email' });
        const groupsById = await loadGroups();
        const requested = Array.isArray(req.body?.groupIds) ? req.body.groupIds.map(String) : [];
        if (scoped) {
          const memberships = await loadGroupMemberships();
          const before = memberships[email] || [];
          if (!personInScope(actor, before, groupsById)) {
            return res.status(404).json({ error: 'Not a viewer' });
          }
          const problem = membershipChangeProblem(actor, before, requested, groupsById);
          if (problem) return res.status(403).json({ error: problem });
        }
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
      // Its publish windows go with it (lib/scheduleStore.js). Best-effort
      // after the delete itself: a window naming a deleted group matches no
      // viewer, and is refused if an admin tries to save it again.
      await pruneGroupFromSchedules(id).catch(() => 0);
      await logAction(admin, 'group.delete', current.name);
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'Could not delete the group' });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}

export default withMonitorApi(handler);
