import { describe, it, expect } from 'vitest';
import { splitPrivateListEmails } from '../privateList';

describe('splitPrivateListEmails', () => {
  it('returns every requested email when none are already on the list', () => {
    expect(splitPrivateListEmails(['a@x.com', 'b@x.com'], [])).toEqual(['a@x.com', 'b@x.com']);
  });

  it('leaves emails already on the list out of the result', () => {
    const active = [{ email: 'a@x.com' }];
    expect(splitPrivateListEmails(['a@x.com', 'b@x.com'], active)).toEqual(['b@x.com']);
  });

  it('dedupes the requested list against itself', () => {
    expect(splitPrivateListEmails(['a@x.com', 'A@X.com', 'a@x.com'], [])).toEqual(['a@x.com']);
  });

  it('normalizes case and whitespace before comparing against active shares', () => {
    const active = [{ email: 'bob@example.com' }];
    expect(splitPrivateListEmails(['  Bob@Example.com  '], active)).toEqual([]);
  });

  it('drops empty/blank entries', () => {
    expect(splitPrivateListEmails(['', '  ', 'a@x.com'], [])).toEqual(['a@x.com']);
  });

  it('returns nothing new when the whole request is already active', () => {
    const active = [{ email: 'a@x.com' }, { email: 'b@x.com' }];
    expect(splitPrivateListEmails(['a@x.com', 'b@x.com'], active)).toEqual([]);
  });
});
