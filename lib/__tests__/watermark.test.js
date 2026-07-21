import { describe, it, expect } from 'vitest';
import { resolveWatermark, clampWatermarkMode } from '../watermark';

describe('resolveWatermark', () => {
  it('exemption wins over every other setting', () => {
    expect(
      resolveWatermark({ exempt: true, shareMode: 'always', videoMode: 'always', globalDefault: true })
    ).toBe(false);
  });

  it("share's explicit choice beats the video and the global default", () => {
    expect(
      resolveWatermark({ exempt: false, shareMode: 'always', videoMode: 'never', globalDefault: false })
    ).toBe(true);
    expect(
      resolveWatermark({ exempt: false, shareMode: 'never', videoMode: 'always', globalDefault: true })
    ).toBe(false);
  });

  it("video's explicit choice beats the global default when the share is unset", () => {
    expect(
      resolveWatermark({ exempt: false, shareMode: 'default', videoMode: 'always', globalDefault: false })
    ).toBe(true);
    expect(
      resolveWatermark({ exempt: false, shareMode: 'default', videoMode: 'never', globalDefault: true })
    ).toBe(false);
  });

  it('falls back to the global default when nothing else is explicit', () => {
    expect(
      resolveWatermark({ exempt: false, shareMode: 'default', videoMode: 'default', globalDefault: true })
    ).toBe(true);
    expect(
      resolveWatermark({ exempt: false, shareMode: 'default', videoMode: 'default', globalDefault: false })
    ).toBe(false);
  });

  it('defaults to no watermark when called with no arguments', () => {
    expect(resolveWatermark({})).toBe(false);
  });
});

describe('clampWatermarkMode', () => {
  it('passes through valid modes', () => {
    expect(clampWatermarkMode('always')).toBe('always');
    expect(clampWatermarkMode('never')).toBe('never');
    expect(clampWatermarkMode('default')).toBe('default');
  });

  it('falls back to default for anything else', () => {
    expect(clampWatermarkMode('bogus')).toBe('default');
    expect(clampWatermarkMode(undefined)).toBe('default');
    expect(clampWatermarkMode(null)).toBe('default');
  });
});
