// Palette presets + validation + CSS-variable mapping. The admin-picked theme
// is stored in Redis, served by /api/theme, applied as CSS variables, and
// cached in localStorage so the _document no-flash script can restore it
// before first paint.

export const COLOR_KEYS = ['bg', 'panel', 'text', 'muted', 'accent', 'accent2'];

export const PRESETS = [
  { id: 'ocean',  name: 'Ocean',  colors: { bg: '#0b1120', panel: '#121a2e', text: '#e7ecf6', muted: '#93a0bd', accent: '#6366f1', accent2: '#22d3ee' } },
  { id: 'abyss',  name: 'Abyss',  colors: { bg: '#060a14', panel: '#0d1424', text: '#dbe4f3', muted: '#7e8ba8', accent: '#3b82f6', accent2: '#06b6d4' } },
  { id: 'reef',   name: 'Reef',   colors: { bg: '#071412', panel: '#0e1f1c', text: '#e2f2ed', muted: '#86a69e', accent: '#10b981', accent2: '#2dd4bf' } },
  { id: 'coral',  name: 'Coral',  colors: { bg: '#140b10', panel: '#221219', text: '#f4e7ec', muted: '#b18f9c', accent: '#f43f5e', accent2: '#fb923c' } },
  { id: 'dusk',   name: 'Dusk',   colors: { bg: '#100b1c', panel: '#1a1230', text: '#ece6f7', muted: '#a195bf', accent: '#8b5cf6', accent2: '#ec4899' } },
  { id: 'gold',   name: 'Gold',   colors: { bg: '#14100a', panel: '#201a10', text: '#f5efe2', muted: '#b3a68a', accent: '#f59e0b', accent2: '#fbbf24' } },
  { id: 'mono',   name: 'Mono',   colors: { bg: '#0d1117', panel: '#161b22', text: '#e6edf3', muted: '#8d96a0', accent: '#64748b', accent2: '#94a3b8' } },
];

export const DEFAULT_THEME = PRESETS[0];

export const THEME_STORAGE_KEY = 'pvp:theme';

const HEX = /^#[0-9a-fA-F]{6}$/;

// Returns a sanitized {name, colors} or null if anything is invalid.
export function validateTheme(input) {
  if (!input || typeof input !== 'object' || typeof input.colors !== 'object' || !input.colors) {
    return null;
  }
  const colors = {};
  for (const key of COLOR_KEYS) {
    const value = String(input.colors[key] ?? '').trim();
    if (!HEX.test(value)) return null;
    colors[key] = value.toLowerCase();
  }
  const name = typeof input.name === 'string' && input.name.trim()
    ? input.name.trim().slice(0, 32)
    : 'custom';
  return { name, colors };
}

export function themeCssVars(theme) {
  const t = theme && theme.colors ? theme : DEFAULT_THEME;
  return {
    '--bg': t.colors.bg,
    '--panel': t.colors.panel,
    '--text': t.colors.text,
    '--muted': t.colors.muted,
    '--accent': t.colors.accent,
    '--accent2': t.colors.accent2,
  };
}

export function applyTheme(theme) {
  if (typeof document === 'undefined') return;
  const vars = themeCssVars(theme);
  for (const [name, value] of Object.entries(vars)) {
    document.documentElement.style.setProperty(name, value);
  }
}
