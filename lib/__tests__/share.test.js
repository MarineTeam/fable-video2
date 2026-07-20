import { describe, it, expect } from 'vitest';
import { clampHours, DEFAULT_HOURS, MAX_HOURS } from '../share';

describe('clampHours', () => {
  it('uses the default when missing or non-numeric', () => {
    expect(clampHours(undefined)).toBe(DEFAULT_HOURS);
    expect(clampHours('')).toBe(DEFAULT_HOURS);
    expect(clampHours('nope')).toBe(DEFAULT_HOURS);
  });

  it('floors negative values up to 1', () => {
    // 0 is falsy, so it hits the same default-value branch as missing input.
    expect(clampHours(0)).toBe(DEFAULT_HOURS);
    expect(clampHours(-5)).toBe(1);
  });

  it('caps above the max down to the max', () => {
    expect(clampHours(MAX_HOURS + 100)).toBe(MAX_HOURS);
  });

  it('passes through valid integer values', () => {
    expect(clampHours(24)).toBe(24);
    expect(clampHours('48')).toBe(48);
  });
});
