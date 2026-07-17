import { describe, it, expect } from 'vitest';
import { PRESETS, DEFAULT_THEME, validateTheme, themeCssVars, COLOR_KEYS } from '../theme';

describe('presets', () => {
  it('ships 7 presets and every preset validates', () => {
    expect(PRESETS).toHaveLength(7);
    for (const preset of PRESETS) {
      expect(validateTheme(preset)).not.toBeNull();
    }
  });
});

describe('validateTheme', () => {
  it('rejects non-objects and missing colors', () => {
    expect(validateTheme(null)).toBeNull();
    expect(validateTheme('ocean')).toBeNull();
    expect(validateTheme({})).toBeNull();
  });

  it('rejects bad hex values', () => {
    const bad = { name: 'x', colors: { ...DEFAULT_THEME.colors, accent: 'red' } };
    expect(validateTheme(bad)).toBeNull();
    const short = { name: 'x', colors: { ...DEFAULT_THEME.colors, bg: '#fff' } };
    expect(validateTheme(short)).toBeNull();
  });

  it('lowercases colors and caps the name', () => {
    const theme = validateTheme({
      name: 'A'.repeat(100),
      colors: { ...DEFAULT_THEME.colors, accent: '#ABCDEF' },
    });
    expect(theme.colors.accent).toBe('#abcdef');
    expect(theme.name.length).toBe(32);
  });

  it('defaults a missing name to custom', () => {
    expect(validateTheme({ colors: DEFAULT_THEME.colors }).name).toBe('custom');
  });
});

describe('themeCssVars', () => {
  it('maps every color key to a CSS variable', () => {
    const vars = themeCssVars(DEFAULT_THEME);
    expect(Object.keys(vars)).toHaveLength(COLOR_KEYS.length);
    expect(vars['--bg']).toBe(DEFAULT_THEME.colors.bg);
    expect(vars['--accent2']).toBe(DEFAULT_THEME.colors.accent2);
  });

  it('falls back to the default theme', () => {
    expect(themeCssVars(null)['--bg']).toBe(DEFAULT_THEME.colors.bg);
  });
});
