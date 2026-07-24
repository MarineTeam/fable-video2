import { redis, k } from './redis';
import { normalizeEmail } from './auth';

function parseList(raw) {
  return String(raw || '')
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
}

// GEO_WHITELIST gates viewers; ADMIN_GEO_WHITELIST gates admins. Kept in
// separate env vars (not Redis) so an admin locked out by their own
// whitelist can always fix it by editing the env var in Vercel and
// redeploying, without needing the admin UI to be reachable.
export function geoWhitelist() {
  return parseList(process.env.GEO_WHITELIST);
}

export function adminGeoWhitelist() {
  return parseList(process.env.ADMIN_GEO_WHITELIST);
}

// ADMIN_GEO_BYPASS_EMAILS: admin accounts that always pass the admin geo
// check, independent of ADMIN_GEO_WHITELIST and its enforcement toggle. A
// standing safety net an admin arms (adds their email) before traveling —
// env var changes need a redeploy, so this isn't an in-the-moment fix.
export function adminGeoBypassEmails() {
  return String(process.env.ADMIN_GEO_BYPASS_EMAILS || '')
    .split(',')
    .map(normalizeEmail)
    .filter(Boolean);
}

// Vercel's edge network sets this on every request (and strips any
// client-supplied header of the same name), so it can be trusted as-is.
export function requestCountry(req) {
  const raw = req.headers?.['x-vercel-ip-country'];
  return raw ? String(raw).toUpperCase() : null;
}

async function settingOn(key) {
  try {
    // Upstash's REST client auto-deserializes: a stored '1'/'0' string comes
    // back as the number 1/0 (valid JSON), not the original string. Compare
    // as a string so either representation is recognized.
    return String(await redis().get(k(key))) === '1';
  } catch {
    return false;
  }
}

export function geoEnforcementOn() {
  return settingOn('settings:geoEnforcement');
}

export function adminGeoEnforcementOn() {
  return settingOn('settings:adminGeoEnforcement');
}

// Pure decision function: allowed unless enforcement is on AND the whitelist
// is non-empty AND the country isn't in it — inert until both are
// configured, same contract as push/mail. A missing country (e.g. no geo
// signal outside Vercel's edge) never blocks, since we can't distinguish
// "misconfigured" from "actually elsewhere".
export function resolveGeoAccess({ enforced, whitelist, country }) {
  if (!enforced) return true;
  if (!whitelist || whitelist.length === 0) return true;
  if (!country) return true;
  return whitelist.includes(country);
}

// Pure decision function, mirroring resolveGeoAccess above: only an admin
// whose (normalized) email is on the bypass list is bypassed — never a
// non-admin, and never an unlisted admin.
export function isBypassedAdmin({ admin, email, bypassList }) {
  return Boolean(admin) && (bypassList || []).includes(normalizeEmail(email));
}

// Admins always resolve against ADMIN_GEO_WHITELIST regardless of which
// page/API they hit, so their access story never depends on GEO_WHITELIST.
// A bypass-listed admin short-circuits before the whitelist/toggle are even
// read, so the bypass holds regardless of country, the enforcement toggle,
// or a Redis outage.
export async function isGeoAllowed(req, { admin, email }) {
  if (isBypassedAdmin({ admin, email, bypassList: adminGeoBypassEmails() })) return true;
  const enforced = admin ? await adminGeoEnforcementOn() : await geoEnforcementOn();
  const whitelist = admin ? adminGeoWhitelist() : geoWhitelist();
  const country = requestCountry(req);
  return resolveGeoAccess({ enforced, whitelist, country });
}
