import { redis, k } from './redis';

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

// Vercel's edge network sets this on every request (and strips any
// client-supplied header of the same name), so it can be trusted as-is.
export function requestCountry(req) {
  const raw = req.headers?.['x-vercel-ip-country'];
  return raw ? String(raw).toUpperCase() : null;
}

async function settingOn(key) {
  try {
    return (await redis().get(k(key))) === '1';
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

// Admins always resolve against ADMIN_GEO_WHITELIST regardless of which
// page/API they hit, so their access story never depends on GEO_WHITELIST.
export async function isGeoAllowed(req, { admin }) {
  const enforced = admin ? await adminGeoEnforcementOn() : await geoEnforcementOn();
  const whitelist = admin ? adminGeoWhitelist() : geoWhitelist();
  const country = requestCountry(req);
  return resolveGeoAccess({ enforced, whitelist, country });
}
