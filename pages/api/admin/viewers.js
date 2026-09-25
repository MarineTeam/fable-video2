import { withMonitorApi } from "../../../lib/monitor";
import { requireActor } from '../../../lib/guard';
import { isScoped, mayRemovePerson, personInScope, placementGroups } from '../../../lib/staffScopeRules';
import { CAP } from '../../../lib/capabilities';
import { redis, k } from '../../../lib/redis';
import { normalizeEmail, isValidEmail } from '../../../lib/auth';
import { logAction } from '../../../lib/audit';
import { getAllViewerTags, distinctTags, clearViewerTags } from '../../../lib/viewerTags';
import { clearRolesForEmail } from '../../../lib/roles';
import { clearGroupsForEmail, loadGroupMemberships, loadGroups, setGroupsForEmail } from '../../../lib/groups';
import { rolesForEmail } from '../../../lib/roles';
import { revokeFeedToken } from '../../../lib/podcastStore';

async function handler(req, res) {
  const actor = await requireActor(req, res, req.method === 'GET' ? CAP.VIEWERS_READ : CAP.VIEWERS_MANAGE);
  if (!actor) return;
  const admin = actor.email;
  const r = redis();
  // Group-scoped staff (lib/staffScopeRules.js) see and manage only the
  // people in their own groups, and approve new people only into one of them.
  const scoped = isScoped(actor);
  let groupsById = {};
  let memberships = {};
  if (scoped) {
    try {
      [groupsById, memberships] = await Promise.all([loadGroups(), loadGroupMemberships()]);
    } catch {
      return res.status(500).json({ error: 'Could not load viewers' });
    }
  }
  const inScope = (email) => personInScope(actor, memberships[email], groupsById);

  if (req.method === 'GET') {
    try {
      const [emails, lastSeen, tagsByEmail] = await Promise.all([
        r.smembers(k('viewers')),
        r.hgetall(k('viewer:lastseen')).catch(() => ({})),
        getAllViewerTags(),
      ]);
      const viewers = (emails || [])
        .filter((email) => inScope(email))
        .map((email) => ({
          email,
          lastSeen: (lastSeen || {})[email] || null,
          tags: tagsByEmail[email] || [],
        }))
        .sort((a, b) => a.email.localeCompare(b.email));
      return res.json({ viewers, tags: distinctTags(tagsByEmail) });
    } catch {
      return res.status(500).json({ error: 'Could not load viewers' });
    }
  }

  if (req.method === 'POST') {
    // Accepts a single email, an array, or a pasted blob separated by
    // commas/whitespace/semicolons. Validated + deduped.
    let input = req.body?.emails ?? req.body?.email ?? '';
    if (typeof input === 'string') input = input.split(/[\s,;]+/);
    if (!Array.isArray(input)) return res.status(400).json({ error: 'Bad input' });
    const seen = new Set();
    const valid = [];
    const invalid = [];
    for (const raw of input.slice(0, 500)) {
      const email = normalizeEmail(raw);
      if (!email) continue;
      if (!isValidEmail(email)) {
        invalid.push(email);
        continue;
      }
      if (!seen.has(email)) {
        seen.add(email);
        valid.push(email);
      }
    }
    if (!valid.length) return res.status(400).json({ error: 'No valid emails', invalid });
    if (scoped) {
      // New people go into one of the caller's groups, and the membership is
      // written BEFORE the approval: a failure between the two leaves a
      // membership row for someone not yet approved (harmless), never an
      // approved viewer in no group (the whole library, while default access
      // is open). People who are already viewers are left as they are.
      const placeIn = placementGroups(actor, req.body?.groupIds, groupsById);
      if (!placeIn) return res.status(400).json({ error: 'Choose which of your groups to add them to' });
      try {
        const existing = new Set((await r.smembers(k('viewers'))) || []);
        const fresh = valid.filter((email) => !existing.has(email));
        for (const email of fresh) await setGroupsForEmail(email, placeIn, groupsById);
        const added = fresh.length ? await r.sadd(k('viewers'), ...fresh) : 0;
        if (fresh.length) {
          await logAction(admin, 'viewer.add', `${fresh.slice(0, 10).join(', ')} -> ${placeIn.join(', ')}`);
        }
        return res.json({ added, submitted: valid.length, invalid });
      } catch {
        return res.status(500).json({ error: 'Could not add viewers' });
      }
    }
    try {
      const added = await r.sadd(k('viewers'), ...valid);
      await logAction(admin, 'viewer.add', valid.slice(0, 10).join(', ') + (valid.length > 10 ? ` (+${valid.length - 10} more)` : ''));
      return res.json({ added, submitted: valid.length, invalid });
    } catch {
      return res.status(500).json({ error: 'Could not add viewers' });
    }
  }

  if (req.method === 'DELETE') {
    const email = normalizeEmail(req.body?.email || req.query.email);
    if (!email) return res.status(400).json({ error: 'Bad email' });
    if (scoped) {
      // Removing someone from the portal affects every group they are in,
      // and removing a staff member takes their roles too — neither is a
      // scoped act unless all of it is inside the scope.
      if (!inScope(email)) return res.status(404).json({ error: 'Not a viewer' });
      let roles = [];
      try {
        roles = await rolesForEmail(email);
      } catch {
        return res.status(500).json({ error: 'Could not remove viewer' });
      }
      if (!mayRemovePerson(actor, memberships[email], groupsById) || roles.length) {
        return res.status(403).json({
          error: 'They are also in a group outside yours, or hold a role — take them out of your group instead',
        });
      }
    }
    try {
      await r.srem(k('viewers'), email);
      await r.hdel(k('viewer:lastseen'), email).catch(() => {});
      await clearViewerTags(email);
      // Removing a viewer removes their grants, so no orphaned role
      // assignment or group membership can outlive the account and come back
      // to life if the same address is re-added later. NOT their progress,
      // saved list or votes — those stay under their email (FEATURES.md,
      // known gaps).
      await clearRolesForEmail(email);
      await clearGroupsForEmail(email);
      // A feed token is a bearer credential that survives outside the session,
      // so it must die with the account rather than outlive it.
      await revokeFeedToken(email);
      await logAction(admin, 'viewer.remove', email);
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'Could not remove viewer' });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}

export default withMonitorApi(handler);
