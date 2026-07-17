import { describe, it, expect, beforeEach } from 'vitest';
import { isAdmin, adminEmails, normalizeEmail, isValidEmail } from '../auth';

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
