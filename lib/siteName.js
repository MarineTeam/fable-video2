// The portal's display name, adjustable live from /admin → Settings.
//
// This module is PURE and imports nothing — the app shell, the share shell and
// _app all reference it during render, so anything pulled in here lands in the
// browser bundle. Redis access lives in lib/siteNameStore.js, the same split as
// capabilities.js / roles.js and schedule.js / scheduleStore.js.
//
// The name is resolved SERVER-SIDE and passed through page props rather than
// fetched by the client the way the palette is. The palette can be applied
// after paint because it only sets CSS variables; a name is rendered text, so
// a client-side fetch would either flash the default first or disagree with the
// server-rendered HTML and trip a hydration mismatch. One Redis read per page
// render — folded into an existing Promise.all wherever a page already has one.

export const DEFAULT_SITE_NAME = 'Marine Video Portal';
export const MAX_SITE_NAME_LENGTH = 40;

// Trims, collapses internal whitespace, caps length. Returns null for anything
// unusable so callers can fall back to the default rather than render a blank
// header — an empty name is never stored.
export function normalizeSiteName(raw) {
  const name = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, MAX_SITE_NAME_LENGTH);
  return name || null;
}

// What to actually render: the configured name, or the default. Every display
// site goes through this so an unreadable or unset value can never show up as
// an empty brand.
export function siteNameOrDefault(raw) {
  return normalizeSiteName(raw) || DEFAULT_SITE_NAME;
}

// PWA manifests carry a short_name used on home screens where space is tight.
// Derived rather than separately configurable: one field to edit, and a
// two-field version would drift the moment someone changed only one.
export const MAX_SHORT_NAME_LENGTH = 12;

export function shortSiteName(raw) {
  const name = siteNameOrDefault(raw);
  if (name.length <= MAX_SHORT_NAME_LENGTH) return name;
  // Prefer a clean word boundary over a hard cut mid-word.
  const words = name.split(' ');
  let out = '';
  for (const word of words) {
    const next = out ? `${out} ${word}` : word;
    if (next.length > MAX_SHORT_NAME_LENGTH) break;
    out = next;
  }
  return out || name.slice(0, MAX_SHORT_NAME_LENGTH);
}
