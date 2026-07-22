import { describe, it, expect, beforeEach } from 'vitest';
import { geoWhitelist, adminGeoWhitelist, requestCountry, resolveGeoAccess } from '../geo';

describe('geoWhitelist / adminGeoWhitelist', () => {
  beforeEach(() => {
    delete process.env.GEO_WHITELIST;
    delete process.env.ADMIN_GEO_WHITELIST;
  });

  it('parses, trims, and uppercases a comma-separated list', () => {
    process.env.GEO_WHITELIST = ' us, ca ,gb';
    expect(geoWhitelist()).toEqual(['US', 'CA', 'GB']);
  });

  it('is independent from the admin whitelist', () => {
    process.env.GEO_WHITELIST = 'US';
    process.env.ADMIN_GEO_WHITELIST = 'CA,GB';
    expect(geoWhitelist()).toEqual(['US']);
    expect(adminGeoWhitelist()).toEqual(['CA', 'GB']);
  });

  it('is an empty array when unset', () => {
    expect(geoWhitelist()).toEqual([]);
    expect(adminGeoWhitelist()).toEqual([]);
  });
});

describe('requestCountry', () => {
  it('reads and uppercases the Vercel geo header', () => {
    expect(requestCountry({ headers: { 'x-vercel-ip-country': 'us' } })).toBe('US');
  });

  it('is null when the header is absent', () => {
    expect(requestCountry({ headers: {} })).toBeNull();
  });
});

describe('resolveGeoAccess', () => {
  it('allows everything when enforcement is off', () => {
    expect(resolveGeoAccess({ enforced: false, whitelist: ['US'], country: 'CA' })).toBe(true);
  });

  it('is inert when the whitelist is empty, even if enforced', () => {
    expect(resolveGeoAccess({ enforced: true, whitelist: [], country: 'CA' })).toBe(true);
  });

  it('allows when the country cannot be determined', () => {
    expect(resolveGeoAccess({ enforced: true, whitelist: ['US'], country: null })).toBe(true);
  });

  it('allows a whitelisted country', () => {
    expect(resolveGeoAccess({ enforced: true, whitelist: ['US', 'CA'], country: 'CA' })).toBe(true);
  });

  it('blocks a non-whitelisted country when enforced', () => {
    expect(resolveGeoAccess({ enforced: true, whitelist: ['US'], country: 'CA' })).toBe(false);
  });
});
