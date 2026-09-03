import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SITE_NAME,
  MAX_SITE_NAME_LENGTH,
  MAX_SHORT_NAME_LENGTH,
  normalizeSiteName,
  siteNameOrDefault,
  shortSiteName,
} from '../siteName';

describe('normalizeSiteName', () => {
  it('trims and collapses internal whitespace', () => {
    expect(normalizeSiteName('  Northern   Fleet  ')).toBe('Northern Fleet');
  });

  it('caps length', () => {
    expect(normalizeSiteName('x'.repeat(200))).toHaveLength(MAX_SITE_NAME_LENGTH);
  });

  // null is the "nothing stored" signal the store turns into a delete, so a
  // blank submission resets rather than persisting an empty header.
  it('returns null for anything unusable', () => {
    expect(normalizeSiteName('')).toBeNull();
    expect(normalizeSiteName('   ')).toBeNull();
    expect(normalizeSiteName(null)).toBeNull();
    expect(normalizeSiteName(undefined)).toBeNull();
  });
});

describe('siteNameOrDefault', () => {
  it('passes a usable name through', () => {
    expect(siteNameOrDefault('Northern Fleet')).toBe('Northern Fleet');
  });

  // Every display site goes through this, so an unset or unreadable value can
  // never render as an empty brand.
  it('falls back to the default for anything unusable', () => {
    expect(siteNameOrDefault(null)).toBe(DEFAULT_SITE_NAME);
    expect(siteNameOrDefault('')).toBe(DEFAULT_SITE_NAME);
    expect(siteNameOrDefault('   ')).toBe(DEFAULT_SITE_NAME);
    expect(siteNameOrDefault(undefined)).toBe(DEFAULT_SITE_NAME);
  });

  it('normalizes on the way through', () => {
    expect(siteNameOrDefault('  Northern   Fleet ')).toBe('Northern Fleet');
  });
});

describe('shortSiteName', () => {
  it('returns a short name unchanged', () => {
    expect(shortSiteName('Fleet TV')).toBe('Fleet TV');
  });

  it('trims a long name at a word boundary rather than mid-word', () => {
    expect(shortSiteName('Northern Fleet Video Portal')).toBe('Northern');
    expect(shortSiteName('Deck Crew Training')).toBe('Deck Crew');
  });

  it('hard-cuts a single word too long to break', () => {
    const out = shortSiteName('Supercalifragilistic');
    expect(out).toHaveLength(MAX_SHORT_NAME_LENGTH);
    expect(out).toBe('Supercalifra');
  });

  it('falls back to the default’s short form for unusable input', () => {
    expect(shortSiteName(null)).toBe(shortSiteName(DEFAULT_SITE_NAME));
  });

  it('never exceeds the cap', () => {
    for (const input of ['Northern Fleet Video Portal', 'x'.repeat(40), DEFAULT_SITE_NAME, 'A B C D E F G H']) {
      expect(shortSiteName(input).length).toBeLessThanOrEqual(MAX_SHORT_NAME_LENGTH);
    }
  });
});
