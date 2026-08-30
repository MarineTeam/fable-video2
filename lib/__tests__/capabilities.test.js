import { describe, it, expect } from 'vitest';
import {
  CAP,
  ALL_CAPABILITIES,
  CAPABILITY_INFO,
  isCapability,
  normalizeCapabilities,
  hasCapability,
  hasAnyCapability,
  effectiveCapabilities,
  canDelegate,
  undelegatableCapabilities,
  normalizeRoleName,
  roleIdFromName,
  isValidRoleId,
  MAX_ROLE_NAME_LENGTH,
} from '../capabilities';

describe('the capability catalog', () => {
  it('is closed: unknown strings are never capabilities', () => {
    expect(isCapability(CAP.ROLES_MANAGE)).toBe(true);
    expect(isCapability('videos.destroy-everything')).toBe(false);
    expect(isCapability('')).toBe(false);
    expect(isCapability(undefined)).toBe(false);
  });

  it('labels every capability it defines', () => {
    expect(CAPABILITY_INFO.map((i) => i.cap).sort()).toEqual([...ALL_CAPABILITIES].sort());
  });
});

describe('normalizeCapabilities', () => {
  it('drops unknown strings, dedupes and sorts', () => {
    expect(normalizeCapabilities(['videos.read', 'nope', 'audit.read', 'videos.read'])).toEqual([
      'audit.read',
      'videos.read',
    ]);
  });

  it('treats a non-array as no capabilities', () => {
    expect(normalizeCapabilities(null)).toEqual([]);
    expect(normalizeCapabilities('roles.manage')).toEqual([]);
  });
});

describe('effectiveCapabilities', () => {
  const rolesById = {
    editor: { id: 'editor', name: 'Editor', capabilities: [CAP.VIDEOS_READ, CAP.VIDEOS_MANAGE] },
    auditor: { id: 'auditor', name: 'Auditor', capabilities: [CAP.AUDIT_READ] },
    // A record hand-edited in Redis to claim something outside the catalog.
    forged: { id: 'forged', name: 'Forged', capabilities: ['videos.read', 'god.mode'] },
  };

  it('gives an owner the whole catalog without consulting any stored role', () => {
    expect(effectiveCapabilities({ owner: true, roleIds: [], rolesById: {} })).toEqual([
      ...ALL_CAPABILITIES,
    ]);
  });

  it('unions the capabilities of a non-owner’s roles', () => {
    expect(effectiveCapabilities({ owner: false, roleIds: ['editor', 'auditor'], rolesById })).toEqual([
      CAP.AUDIT_READ,
      CAP.VIDEOS_MANAGE,
      CAP.VIDEOS_READ,
    ]);
  });

  it('ignores capability strings outside the catalog, even when stored', () => {
    expect(effectiveCapabilities({ owner: false, roleIds: ['forged'], rolesById })).toEqual([
      CAP.VIDEOS_READ,
    ]);
  });

  it('contributes nothing for a role id with no surviving record', () => {
    expect(effectiveCapabilities({ owner: false, roleIds: ['deleted'], rolesById })).toEqual([]);
  });

  it('gives no capabilities to someone with no roles', () => {
    expect(effectiveCapabilities({ owner: false, roleIds: [], rolesById })).toEqual([]);
    expect(effectiveCapabilities({ owner: false })).toEqual([]);
  });
});

describe('the no-escalation rule', () => {
  const delegator = [CAP.ROLES_MANAGE, CAP.VIEWERS_READ];

  it('lets an actor hand out exactly what they hold', () => {
    expect(canDelegate(delegator, [CAP.VIEWERS_READ])).toBe(true);
    expect(canDelegate(delegator, delegator)).toBe(true);
    expect(canDelegate(delegator, [])).toBe(true);
  });

  // The negative control: holding roles.manage must NOT be a route to
  // capabilities the actor was never given.
  it('refuses to let a roles.manage holder grant a capability they lack', () => {
    expect(canDelegate(delegator, [CAP.SETTINGS_MANAGE])).toBe(false);
    expect(canDelegate(delegator, [CAP.VIEWERS_READ, CAP.VIDEOS_UPLOAD])).toBe(false);
    expect(undelegatableCapabilities(delegator, [CAP.VIEWERS_READ, CAP.VIDEOS_UPLOAD])).toEqual([
      CAP.VIDEOS_UPLOAD,
    ]);
  });

  it('is a no-op for an owner, who holds the whole catalog', () => {
    const owner = effectiveCapabilities({ owner: true });
    expect(canDelegate(owner, ALL_CAPABILITIES)).toBe(true);
    expect(undelegatableCapabilities(owner, ALL_CAPABILITIES)).toEqual([]);
  });

  it('gives someone with no capabilities nothing to delegate', () => {
    expect(canDelegate([], [CAP.AUDIT_READ])).toBe(false);
    expect(canDelegate(undefined, [CAP.AUDIT_READ])).toBe(false);
  });

  it('ignores uncatalogued strings rather than treating them as undelegatable', () => {
    expect(canDelegate(delegator, ['god.mode'])).toBe(true);
    expect(undelegatableCapabilities(delegator, ['god.mode'])).toEqual([]);
  });
});

describe('hasCapability / hasAnyCapability', () => {
  it('answers membership questions on a resolved set', () => {
    expect(hasCapability([CAP.AUDIT_READ], CAP.AUDIT_READ)).toBe(true);
    expect(hasCapability([CAP.AUDIT_READ], CAP.SETTINGS_MANAGE)).toBe(false);
    expect(hasCapability(null, CAP.AUDIT_READ)).toBe(false);
    expect(hasAnyCapability([CAP.AUDIT_READ])).toBe(true);
    expect(hasAnyCapability([])).toBe(false);
    expect(hasAnyCapability(null)).toBe(false);
  });
});

describe('role names and ids', () => {
  it('trims, collapses whitespace and caps length', () => {
    expect(normalizeRoleName('  Deck   Lead ')).toBe('Deck Lead');
    expect(normalizeRoleName('x'.repeat(200))).toHaveLength(MAX_ROLE_NAME_LENGTH);
    expect(normalizeRoleName('   ')).toBeNull();
  });

  it('slugs a name and appends a suffix so like-named roles never collide', () => {
    expect(roleIdFromName('Deck Lead', () => 'abc123')).toBe('deck-lead-abc123');
    expect(roleIdFromName('!!!', () => 'abc123')).toBe('role-abc123');
    expect(roleIdFromName('Deck Lead', () => 'aaa')).not.toBe(
      roleIdFromName('Deck Lead', () => 'bbb')
    );
  });

  it('validates ids strictly', () => {
    expect(isValidRoleId('deck-lead-abc123')).toBe(true);
    expect(isValidRoleId('-leading-dash')).toBe(false);
    expect(isValidRoleId('has space')).toBe(false);
    expect(isValidRoleId('Upper')).toBe(false);
    expect(isValidRoleId('')).toBe(false);
    expect(isValidRoleId('a'.repeat(60))).toBe(false);
  });
});
