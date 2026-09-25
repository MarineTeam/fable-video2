import { auth0 } from './auth0';
import { isAdmin, trustedEmail } from './auth';
import { redis, k } from './redis';
import { isGeoAllowed } from './geo';
import { resolveCapabilities } from './roles';
import { hasCapability, hasAnyCapability } from './capabilities';
import { groupGatingEnabled, loadGroups } from './groups';
import { scopeForEmail } from './staffScopeStore';
import { capabilitiesUnderScope, contentOfScope } from './staffScopeRules';

export async function getSessionEmail(req, res) {
  const session = await auth0.getSession(req, res);
  // trustedEmail, not normalizeEmail: an unverified session yields '' and every
  // caller already treats '' as not-signed-in. This one line covers every API
  // route, since both guards go through it.
  return trustedEmail(session?.user);
}

// Who the caller is, resolved once. `owner` is membership in ADMIN_EMAILS and
// is decided from the env alone — no Redis read — so no stored data and no
// Redis outage can demote a bootstrap admin. Everyone else's capabilities come
// from their assigned roles and fail CLOSED to none (lib/roles.js).
// `staff` = holds the admin area at all: an owner, or anyone with >= 1
// capability.
//
// A staff member may be limited to certain groups (lib/staffScopeRules.js):
// `staffScope` is then their group ids and `contentScope` what those groups
// grant, and the portal-wide capabilities are stripped. A scope that cannot
// be read leaves them with NO capabilities — never an unscoped set.
export async function resolveActor(email) {
  const owner = isAdmin(email);
  let capabilities = await resolveCapabilities(email, { owner });
  let staffScope = null;
  let contentScope = null;
  if (!owner && hasAnyCapability(capabilities)) {
    try {
      staffScope = await scopeForEmail(email);
      if (staffScope) {
        capabilities = capabilitiesUnderScope(capabilities, staffScope);
        contentScope = contentOfScope(staffScope, await loadGroups());
      }
    } catch {
      capabilities = [];
      staffScope = null;
      contentScope = null;
    }
  }
  return { email, owner, capabilities, staff: owner || hasAnyCapability(capabilities), staffScope, contentScope };
}

// For /api/admin/*: responds 403 and returns null unless the caller holds
// `cap`. Owners hold the whole catalog by definition. Returns the caller's
// normalized email, so call sites keep passing it straight to logAction.
//
// A caller with no session gets the same 403 as a signed-in caller without the
// capability — the route never becomes an oracle for "does this capability
// exist / am I close".
export async function requireCapability(req, res, cap) {
  const actor = await requireActor(req, res, cap);
  return actor ? actor.email : null;
}

// requireCapability's twin for routes that also need WHO is asking — the
// capability list, or a group-scoped caller's scope — without resolving it a
// second time. Same refusals, same order; returns the actor, not the email.
export async function requireActor(req, res, cap) {
  const email = await getSessionEmail(req, res);
  if (!email) {
    res.status(403).json({ error: 'Forbidden' });
    return null;
  }
  const actor = await resolveActor(email);
  if (!actor.owner && !hasCapability(actor.capabilities, cap)) {
    res.status(403).json({ error: 'Forbidden' });
    return null;
  }
  // Everyone reaching an admin route resolves against ADMIN_GEO_WHITELIST, not
  // the viewer one, so a staff member's access story never depends on which
  // list they also happen to be on.
  if (!(await isGeoAllowed(req, { admin: true, email }))) {
    res.status(403).json({ error: 'Not available in your region' });
    return null;
  }
  return actor;
}

// Approval decision shared by requireViewer and the page GSSPs, so the three
// copies of "is this person allowed to see the library" cannot drift apart.
// Ordering is deliberate: env check (free) -> viewers SET (one read) -> roles
// (two reads) only when the answer is still unknown or gating needs to know
// whether this is staff. An ordinary approved viewer with gating off costs
// exactly the one read it always did.
export async function viewerAccessFor(email) {
  const owner = isAdmin(email);
  let approved = owner;
  if (!approved) {
    try {
      approved = (await redis().sismember(k('viewers'), email)) === 1;
    } catch {
      // An authorization check must never be widened by an infrastructure
      // error (architecture contract I9).
      approved = false;
    }
  }
  let capabilities = [];
  let staff = owner;
  if (!owner && (!approved || groupGatingEnabled())) {
    capabilities = await resolveCapabilities(email, { owner: false });
    staff = hasAnyCapability(capabilities);
    // Someone an owner trusted with an admin capability can watch the library
    // too — strictly less privilege than what they were already granted.
    if (!approved) approved = staff;
  }
  return { approved, owner, staff, capabilities };
}

// For viewer APIs: admin, staff, or approved viewer. Stamps last-seen as a
// side effect.
export async function requireViewer(req, res) {
  const email = await getSessionEmail(req, res);
  if (!email) {
    res.status(401).json({ error: 'Not signed in' });
    return null;
  }
  const { approved, owner, staff } = await viewerAccessFor(email);
  if (!approved) {
    res.status(403).json({ error: 'Not approved' });
    return null;
  }
  if (!(await isGeoAllowed(req, { admin: owner || staff, email }))) {
    res.status(403).json({ error: 'Not available in your region' });
    return null;
  }
  redis()
    .hset(k('viewer:lastseen'), { [email]: new Date().toISOString() })
    .catch(() => {});
  return { email, admin: owner, staff };
}
