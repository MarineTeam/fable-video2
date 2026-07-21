import { describe, it, expect } from 'vitest';
import { decideBundleAction } from '../bundle';

describe('decideBundleAction', () => {
  it('extends whenever a bundle already exists, regardless of counts', () => {
    expect(
      decideBundleAction({ alreadyBundled: true, existingActiveCount: 0, newCount: 1 })
    ).toBe('extend');
  });

  it('leaves a genuine first share alone (no bundle)', () => {
    expect(
      decideBundleAction({ alreadyBundled: false, existingActiveCount: 0, newCount: 1 })
    ).toBe('none');
  });

  it('creates a bundle the moment total active shares crosses 2', () => {
    expect(
      decideBundleAction({ alreadyBundled: false, existingActiveCount: 1, newCount: 1 })
    ).toBe('create');
    expect(
      decideBundleAction({ alreadyBundled: false, existingActiveCount: 0, newCount: 2 })
    ).toBe('create');
  });

  it('never returns create for zero total', () => {
    expect(
      decideBundleAction({ alreadyBundled: false, existingActiveCount: 0, newCount: 0 })
    ).toBe('none');
  });
});
