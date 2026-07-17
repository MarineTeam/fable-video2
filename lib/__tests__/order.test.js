import { describe, it, expect } from 'vitest';
import { applyOrder, pruneOrder } from '../order';

const v = (guid, dateUploaded) => ({ guid, dateUploaded });

describe('applyOrder', () => {
  it('follows the saved order for placed videos', () => {
    const videos = [v('a', '2026-01-01'), v('b', '2026-01-02'), v('c', '2026-01-03')];
    const result = applyOrder(videos, ['c', 'a', 'b']);
    expect(result.map((x) => x.guid)).toEqual(['c', 'a', 'b']);
  });

  it('floats unplaced videos to the top, newest first', () => {
    const videos = [
      v('old-placed', '2026-01-01'),
      v('new1', '2026-03-01'),
      v('new2', '2026-04-01'),
    ];
    const result = applyOrder(videos, ['old-placed']);
    expect(result.map((x) => x.guid)).toEqual(['new2', 'new1', 'old-placed']);
  });

  it('ignores order entries for deleted videos', () => {
    const videos = [v('a', '2026-01-01')];
    const result = applyOrder(videos, ['ghost', 'a']);
    expect(result.map((x) => x.guid)).toEqual(['a']);
  });

  it('handles missing/invalid inputs', () => {
    expect(applyOrder(null, null)).toEqual([]);
    expect(applyOrder([v('a', '2026-01-01')], null).map((x) => x.guid)).toEqual(['a']);
  });
});

describe('pruneOrder', () => {
  it('drops guids that no longer exist', () => {
    expect(pruneOrder(['a', 'b', 'c'], ['a', 'c'])).toEqual(['a', 'c']);
  });
  it('handles empty inputs', () => {
    expect(pruneOrder(null, [])).toEqual([]);
  });
});
