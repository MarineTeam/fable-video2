import { describe, it, expect, beforeEach } from 'vitest';
import {
  geoWhitelist,
  adminGeoWhitelist,
  adminGeoBypassEmails,
  requestCountry,
  resolveGeoAccess,
  isBypassedAdmin,
} from '../geo';

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

describe('adminGeoBypassEmails', () => {
  beforeEach(() => {
    delete process.env.ADMIN_GEO_BYPASS_EMAILS;
  });

  it('parses, trims, and normalizes a comma-separated list', () => {
    process.env.ADMIN_GEO_BYPASS_EMAILS = ' Admin@Example.com , second@example.com';
    expect(adminGeoBypassEmails()).toEqual(['admin@example.com', 'second@example.com']);
  });

  it('is an empty array when unset', () => {
    expect(adminGeoBypassEmails()).toEqual([]);
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

describe('isBypassedAdmin', () => {
  const bypassList = ['admin@example.com'];

  it('bypasses an admin whose email is on the list', () => {
    expect(isBypassedAdmin({ admin: true, email: 'Admin@Example.com', bypassList })).toBe(true);
  });

  it('does not bypass an admin whose email is not on the list', () => {
    expect(isBypassedAdmin({ admin: true, email: 'other@example.com', bypassList })).toBe(false);
  });

  it('never bypasses a non-admin, even if their email is on the list', () => {
    expect(isBypassedAdmin({ admin: false, email: 'admin@example.com', bypassList })).toBe(false);
  });

  it('is false when the bypass list is empty', () => {
    expect(isBypassedAdmin({ admin: true, email: 'admin@example.com', bypassList: [] })).toBe(false);
  });
});
