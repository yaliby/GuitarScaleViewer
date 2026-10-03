// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mediaNeedsDataUrl } from './mediaUrl';

describe('mediaNeedsDataUrl', () => {
  it('is true for the webviews of Linux and macOS, which are WebKit', () => {
    expect(
      mediaNeedsDataUrl('Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15'),
    ).toBe(true);
    expect(mediaNeedsDataUrl('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)')).toBe(true);
  });

  it('is false for Chromium, which plays blob: URLs straight (WebView2 on Windows, Brave, Chrome)', () => {
    expect(
      mediaNeedsDataUrl('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'),
    ).toBe(false);
  });

  it('is false where there is no browser, and under jsdom', () => {
    expect(mediaNeedsDataUrl('')).toBe(false);
    expect(mediaNeedsDataUrl('Mozilla/5.0 (linux) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/22.1.0')).toBe(false);
  });
});
