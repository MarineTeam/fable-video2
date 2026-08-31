import { describe, it, expect, beforeEach } from 'vitest';
import {
  isAdmin,
  adminEmails,
  normalizeEmail,
  isValidEmail,
  trustedEmail,
  emailVerificationEnforced,
} from '../auth';

describe('isAdmin', () => {
  beforeEach(() => {
    process.env.ADMIN_EMAILS = 'Admin@Example.com, second@example.com ,third@example.com';
  });

  it('matches exact admin emails', () => {
    expect(isAdmin('second@example.com')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isAdmin('ADMIN@example.COM')).toBe(true);
  });

  it('trims whitespace', () => {
    expect(isAdmin('  third@example.com  ')).toBe(true);
  });

  it('rejects non-admins', () => {
    expect(isAdmin('viewer@example.com')).toBe(false);
  });

  it('rejects empty / missing values', () => {
    expect(isAdmin('')).toBe(false);
    expect(isAdmin(null)).toBe(false);
    expect(isAdmin(undefined)).toBe(false);
  });

  it('handles an empty ADMIN_EMAILS', () => {
    process.env.ADMIN_EMAILS = '';
    expect(adminEmails()).toEqual([]);
    expect(isAdmin('admin@example.com')).toBe(false);
  });
});

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Foo@BAR.com ')).toBe('foo@bar.com');
  });
  it('stringifies falsy input to empty', () => {
    expect(normalizeEmail(null)).toBe('');
  });
});

describe('isValidEmail', () => {
  it('accepts a plausible email', () => {
    expect(isValidEmail('a@b.co')).toBe(true);
  });
  it('rejects garbage', () => {
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('a b@c.com')).toBe(false);
    expect(isValidEmail('')).toBe(false);
  });
});

describe('trustedEmail', () => {
  // `enforced` is passed explicitly rather than read from the env, so these
  // cases pin the decision logic itself and not the deployment's config.
  describe('with enforcement on', () => {
    const trusted = (user) => trustedEmail(user, true);

    it('returns the normalized email for a verified session', () => {
      expect(trusted({ email: 'A@Example.com ', email_verified: true })).toBe('a@example.com');
    });

    it('denies an explicitly unverified session', () => {
      expect(trusted({ email: 'a@b.co', email_verified: false })).toBe('');
    });

    // The claim being absent is the case that matters most: a tenant that
    // never emits it must deny, not sail through.
    it('denies when the claim is absent or undefined', () => {
      expect(trusted({ email: 'a@b.co' })).toBe('');
      expect(trusted({ email: 'a@b.co', email_verified: undefined })).toBe('');
      expect(trusted({ email: 'a@b.co', email_verified: null })).toBe('');
    });

    // A truthy non-boolean must not pass — this is why the check is `!== true`
    // rather than a plain falsiness test.
    it('denies truthy non-boolean claims', () => {
      expect(trusted({ email: 'a@b.co', email_verified: 'true' })).toBe('');
      expect(trusted({ email: 'a@b.co', email_verified: 1 })).toBe('');
      expect(trusted({ email: 'a@b.co', email_verified: 'false' })).toBe('');
    });

    it('denies a missing user object', () => {
      expect(trusted(null)).toBe('');
      expect(trusted(undefined)).toBe('');
    });

    it('denies a verified session with no usable email', () => {
      expect(trusted({ email_verified: true })).toBe('');
      expect(trusted({ email: '   ', email_verified: true })).toBe('');
    });
  });

  describe('with enforcement off', () => {
    const trusted = (user) => trustedEmail(user, false);

    it('preserves the pre-campaign behaviour exactly', () => {
      expect(trusted({ email: 'A@Example.com', email_verified: false })).toBe('a@example.com');
      expect(trusted({ email: 'a@b.co' })).toBe('a@b.co');
    });

    it('still denies a missing user', () => {
      expect(trusted(null)).toBe('');
    });
  });

  describe('emailVerificationEnforced', () => {
    it('is off unless REQUIRE_EMAIL_VERIFIED is exactly "1"', () => {
      delete process.env.REQUIRE_EMAIL_VERIFIED;
      expect(emailVerificationEnforced()).toBe(false);
      process.env.REQUIRE_EMAIL_VERIFIED = 'true';
      expect(emailVerificationEnforced()).toBe(false);
      process.env.REQUIRE_EMAIL_VERIFIED = '1';
      expect(emailVerificationEnforced()).toBe(true);
      delete process.env.REQUIRE_EMAIL_VERIFIED;
    });

    it('defaults trustedEmail to the env setting when not passed', () => {
      delete process.env.REQUIRE_EMAIL_VERIFIED;
      expect(trustedEmail({ email: 'a@b.co' })).toBe('a@b.co');
      process.env.REQUIRE_EMAIL_VERIFIED = '1';
      expect(trustedEmail({ email: 'a@b.co' })).toBe('');
      delete process.env.REQUIRE_EMAIL_VERIFIED;
    });
  });
});
