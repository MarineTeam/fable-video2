import { withMonitorApi } from '../../../lib/monitor';
import { requireCapability, resolveActor } from '../../../lib/guard';
import { allowRequest } from '../../../lib/ratelimit';
import { logAction } from '../../../lib/audit';
import { normalizeEmail, isValidEmail } from '../../../lib/auth';
import {
  CAP,
  CAPABILITY_INFO,
  normalizeCapabilities,
  normalizeRoleName,
  roleIdFromName,
  isValidRoleId,
  undelegatableCapabilities,
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
      const [rolesById, assignments] = await Promise.all([loadRoles(), loadRoleAssignments()]);
      return res.json({
        roles: sortedRoles(rolesById),
        assignments,
        catalog: CAPABILITY_INFO,
        actor: { email: actor.email, owner: actor.owner, capabilities: actor.capabilities },
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
      const result = await setRolesForEmail(email, requested, rolesById);
      if (!result.ok) return res.status(400).json({ error: result.error });
      await logAction(
        admin,
        'role.assign',
        `${email} -> ${result.roleIds.length ? result.roleIds.join(', ') : '(none)'}`
      );
      return res.json({ email, roleIds: result.roleIds });
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
