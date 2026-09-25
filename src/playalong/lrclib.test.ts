import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveLrclib } from './lrclib';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveLrclib', () => {
  it('uses ChordSync\'s exact LRCLIB get, then search', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/get')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            trackName: 'Numb',
            artistName: 'Linkin Park',
            syncedLyrics: '[00:21.85]I\'m tired of being what you want me to be',
            plainLyrics: 'I\'m tired of being what you want me to be',
          }),
        };
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const payload = await resolveLrclib('Numb (Official Video)', 'Linkin Park');
    expect(payload.status).toBe('lyrics');
    expect(payload.lyrics?.synced[0]?.text).toContain('tired');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('track_name=Numb');
  });
});
