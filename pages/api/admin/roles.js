import { withMonitorApi } from '../../../lib/monitor';
import { requireCapability, resolveActor, viewerAccessFor } from '../../../lib/guard';
import { allowRequest } from '../../../lib/ratelimit';
import { logAction } from '../../../lib/audit';
import { normalizeEmail, isValidEmail, isAdmin } from '../../../lib/auth';
import { groupGatingEnabled, loadGroups, sortedGroups } from '../../../lib/groups';
import { loadStaffScopes, setScopeForEmail } from '../../../lib/staffScopeStore';
import { MAX_SCOPE_GROUPS, normalizeScope } from '../../../lib/staffScopeRules';
import {
  CAP,
  CAPABILITY_INFO,
  normalizeCapabilities,
  normalizeRoleName,
  roleIdFromName,
  isValidRoleId,
  undelegatableCapabilities,
  assignmentNeedsViewerManage,
} from '../../../lib/capabilities';
import {
  loadRoles,
  loadRoleAssignments,
  sortedRoles,
  saveRole,
  deleteRole,
  setRolesForEmail,
  MAX_ROLES,
} from '../../../lib/roles';

// Role administration. Every mutating branch enforces the no-escalation rule
// from lib/capabilities.js: the actor may only create, edit, delete or assign
// a role whose capabilities they already hold themselves. Owners
// (ADMIN_EMAILS) hold the whole catalog, so the rule is invisible to them and
// a hard ceiling for a delegated roles.manage holder — the escalation surface
// that made in-app admin management a "candidate, not planned" item.
async function handler(req, res) {
  const admin = await requireCapability(req, res, CAP.ROLES_MANAGE);
  if (!admin) return;
  if (req.method !== 'GET' && !(await allowRequest('roles', admin, 20, 60))) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  // The actor's own effective set is the ceiling for everything below.
  const actor = await resolveActor(admin);

  if (req.method === 'GET') {
    try {
      const [rolesById, assignments, scopes, groupsById] = await Promise.all([
        loadRoles(),
        loadRoleAssignments(),
        loadStaffScopes().catch(() => ({})),
        loadGroups().catch(() => ({})),
      ]);
      return res.json({
        roles: sortedRoles(rolesById),
        assignments,
        catalog: CAPABILITY_INFO,
        actor: { email: actor.email, owner: actor.owner, capabilities: actor.capabilities },
        // Group limits (lib/staffScopeRules.js): email -> group ids, the groups
        // one can name, and whether they can be set at all — a limit means
        // "sees what these groups see", which needs GROUP_CONTENT_GATING on.
        scopes,
        scopeGroups: sortedGroups(groupsById).map((g) => ({ id: g.id, name: g.name })),
        scopesAvailable: groupGatingEnabled(),
      });
    } catch {
      return res.status(500).json({ error: 'Could not load roles' });
    }
  }

  if (req.method === 'POST') {
    const name = normalizeRoleName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Bad role name' });
    const capabilities = normalizeCapabilities(req.body?.capabilities);
    const refused = undelegatableCapabilities(actor.capabilities, capabilities);
    if (refused.length) {
      return res.status(403).json({ error: 'You cannot grant capabilities you do not hold', refused });
    }
    try {
      const existing = await loadRoles();
      if (Object.keys(existing).length >= MAX_ROLES) {
        return res.status(400).json({ error: `At most ${MAX_ROLES} roles` });
      }
      const result = await saveRole({ id: roleIdFromName(name), name, capabilities });
      if (!result.ok) return res.status(400).json({ error: result.error });
      await logAction(admin, 'role.create', `${name} [${capabilities.join(', ')}]`);
      return res.json({ role: result.role });
    } catch {
      return res.status(500).json({ error: 'Could not create the role' });
    }
  }

  if (req.method === 'PUT') {
    const id = String(req.body?.id || '');
    if (!isValidRoleId(id)) return res.status(400).json({ error: 'Bad role id' });
    const name = normalizeRoleName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Bad role name' });
    const capabilities = normalizeCapabilities(req.body?.capabilities);
    try {
      const rolesById = await loadRoles();
      const current = rolesById[id];
      if (!current) return res.status(404).json({ error: 'No such role' });
      // Both sides are checked: the new set so the actor cannot grant upward,
      // and the CURRENT set so they cannot tamper with a role more powerful
      // than themselves at all.
      const refused = [
        ...new Set([
          ...undelegatableCapabilities(actor.capabilities, current.capabilities),
          ...undelegatableCapabilities(actor.capabilities, capabilities),
        ]),
      ].sort();
      if (refused.length) {
        return res.status(403).json({ error: 'That role is outside your own capabilities', refused });
      }
      const result = await saveRole({ ...current, name, capabilities });
      if (!result.ok) return res.status(400).json({ error: result.error });
      await logAction(admin, 'role.update', `${name} [${capabilities.join(', ')}]`);
      return res.json({ role: result.role });
    } catch {
      return res.status(500).json({ error: 'Could not update the role' });
    }
  }

  if (req.method === 'PATCH') {
    // Assignment: replace one user's whole role list.
    const email = normalizeEmail(req.body?.email);
    if (!email || !isValidEmail(email)) return res.status(400).json({ error: 'Bad email' });
    const requested = Array.isArray(req.body?.roleIds) ? req.body.roleIds.map(String) : [];
    // The group limit: undefined leaves it as it is, null lifts it, an array
    // of group ids sets it. Owners are never limited — they are the recovery
    // path — and a limit can only be SET while group gating is on, since
    // without it groups limit nobody's library.
    const scopeChange = req.body?.scope === undefined ? undefined : normalizeScope(req.body.scope);
    if (scopeChange !== undefined && isAdmin(email)) {
      return res.status(400).json({ error: "An owner (ADMIN_EMAILS) can't be limited to groups" });
    }
    if (Array.isArray(scopeChange) && !groupGatingEnabled()) {
      return res.status(400).json({ error: 'Turn on group content gating (GROUP_CONTENT_GATING=1) to limit staff to groups' });
    }
    if (Array.isArray(req.body?.scope) && req.body.scope.length > MAX_SCOPE_GROUPS) {
      return res.status(400).json({ error: `At most ${MAX_SCOPE_GROUPS} groups in a limit` });
    }
    try {
      const [rolesById, assignments] = await Promise.all([loadRoles(), loadRoleAssignments()]);
      const capsOf = (ids) =>
        normalizeCapabilities((ids || []).flatMap((rid) => rolesById[rid]?.capabilities || []));
      // The union of what is being added and what is being taken away: an
      // actor may not strip a role they could not have granted either.
      const touched = normalizeCapabilities([
        ...capsOf(assignments[email] || []),
        ...capsOf(requested),
      ]);
      const refused = undelegatableCapabilities(actor.capabilities, touched);
      if (refused.length) {
        return res.status(403).json({ error: 'That assignment is outside your own capabilities', refused });
      }
      // Assigning a role also grants library access (see
      // assignmentNeedsViewerManage) — a widening the subset rule above cannot
      // see. Only resolve the target's current access when the answer could
      // matter, so the common cases cost no extra reads.
      const granted = capsOf(requested);
      if (granted.length && !actor.owner) {
        let targetApproved = false;
        try {
          targetApproved = (await viewerAccessFor(email)).approved;
        } catch {
          targetApproved = false; // access decision — fail closed
        }
        if (
          assignmentNeedsViewerManage({
            owner: actor.owner,
            actorCaps: actor.capabilities,
            grantedCaps: granted,
            targetApproved,
          })
        ) {
          return res.status(403).json({
            error: 'Granting a role to someone who cannot already view the library needs the viewers.manage capability',
            refused: [CAP.VIEWERS_MANAGE],
          });
        }
      }
      if (Array.isArray(scopeChange)) {
        const groupsById = await loadGroups();
        const bad = scopeChange.filter((id) => !groupsById[id]);
        if (bad.length) return res.status(400).json({ error: `No such group: ${bad.join(', ')}` });
      }
      // Write order is the fail-safe one: a limit being SET is saved before the
      // roles, a limit being LIFTED after them, so a failure between the two
      // writes leaves the person with less than was asked for, never more.
      if (Array.isArray(scopeChange)) await setScopeForEmail(email, scopeChange);
      const result = await setRolesForEmail(email, requested, rolesById);
      if (!result.ok) return res.status(400).json({ error: result.error });
      // A limit with no roles limits nothing and would silently re-apply to
      // roles given later, so it goes with the last role.
      if (scopeChange === null || !result.roleIds.length) await setScopeForEmail(email, null);
      await logAction(
        admin,
        'role.assign',
        `${email} -> ${result.roleIds.length ? result.roleIds.join(', ') : '(none)'}` +
          (Array.isArray(scopeChange) && result.roleIds.length
            ? ` (limited to ${scopeChange.join(', ') || 'no groups'})`
            : scopeChange === null
              ? ' (whole portal)'
              : '')
      );
      return res.json({ email, roleIds: result.roleIds, scope: result.roleIds.length ? scopeChange : null });
    } catch {
      return res.status(500).json({ error: 'Could not update the assignment' });
    }
  }

  if (req.method === 'DELETE') {
    const id = String(req.query.id || req.body?.id || '');
    if (!isValidRoleId(id)) return res.status(400).json({ error: 'Bad role id' });
    try {
      const rolesById = await loadRoles();
      const current = rolesById[id];
      if (!current) return res.json({ ok: true });
      const refused = undelegatableCapabilities(actor.capabilities, current.capabilities);
      if (refused.length) {
        return res.status(403).json({ error: 'That role is outside your own capabilities', refused });
      }
      await deleteRole(id);
      await logAction(admin, 'role.delete', current.name);
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'Could not delete the role' });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}

export default withMonitorApi(handler);
