import { afterEach, describe, expect, it, vi } from 'vitest';
import { lookupSongKey, normalizeLookupKey } from './songKeyApi';

/**
 * Hermetic degradation tests: no network is touched. They pin the behaviour the quality gate
 * asks for when the Worker deployment is down — fall back to the client-side catalogs, and
 * end on a clean miss rather than a stuck error.
 */

type FetchArgs = Parameters<typeof fetch>;

function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  const spy = vi.fn(async (...args: FetchArgs) => {
    const url = typeof args[0] === 'string' ? args[0] : String(args[0]);
    return handler(url);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** What the dead Cloudflare deployment actually returns today. */
function cloudflare1016(): Response {
  return json({ error: 'error code: 1016' }, 500);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('lookupSongKey', () => {
  it('misses immediately, without any request, when the metadata is empty', async () => {
    const spy = mockFetch(() => json({}));
    const result = await lookupSongKey({ title: '  ', artist: '' });
    expect(result).toEqual({ found: false, song: null, catalogsTried: true });
    expect(spy).not.toHaveBeenCalled();
  });

  // 503 is retryable, so this walks the full retry budget before reporting the miss. The miss
  // carries `incomplete`, which is what stops the caller caching "this song has no key" when
  // in truth nobody answered.
  it('returns a clean miss, not an error, when the Worker and every catalog fail', async () => {
    mockFetch((url) => (url.includes('workers.dev') ? cloudflare1016() : json({}, 503)));
    const result = await lookupSongKey({ title: 'Numb', artist: 'Linkin Park' });
    expect(result).toEqual({ found: false, song: null, catalogsTried: true, incomplete: true });
  }, 20_000);

  it('reports a miss the catalogs actually answered as complete, so it may be cached', async () => {
    mockFetch((url) => (url.includes('workers.dev') ? cloudflare1016() : json({ content: [], found: false })));
    const result = await lookupSongKey({ title: 'Nonsense Song', artist: 'Nobody At All' });
    expect(result).toEqual({ found: false, song: null, catalogsTried: true, incomplete: false });
  });

  it('survives a Worker that never answers at all', async () => {
    mockFetch((url) => {
      if (url.includes('workers.dev')) {
        throw new TypeError('fetch failed');
      }
      return json({}, 404);
    });
    const result = await lookupSongKey({ title: 'Numb', artist: 'Linkin Park' });
    expect(result.found).toBe(false);
  });

  it('falls back to the catalogs and reports the catalog as the source when the Worker is down', async () => {
    mockFetch((url) => {
      if (url.includes('workers.dev')) {
        return cloudflare1016();
      }
      if (url.includes('reccobeats.com') && url.includes('/v1/track/search')) {
        return json({
          content: [
            {
              id: 'recco-1',
              trackTitle: 'Numb',
              artists: [{ name: 'Linkin Park' }],
              popularity: 90,
              href: null,
            },
          ],
        });
      }
      if (url.includes('reccobeats.com') && url.includes('audio-features')) {
        return json({ key: 9, mode: 0 });
      }
      return json({}, 404);
    });

    const result = await lookupSongKey({ title: 'Numb', artist: 'Linkin Park' });
    expect(result.found).toBe(true);
    expect(result.song?.source).toBe('reccobeats');
    expect(result.song?.musical_key).toBe('A');
    expect(result.song?.mode).toBe('minor');
    expect(result.song?.verified).toBe(false);
  });

  it('prefers the verified database hit and never reaches the catalogs', async () => {
    const spy = mockFetch((url) => {
      if (url.includes('workers.dev')) {
        return json({
          found: true,
          song: {
            id: 'db-1',
            title: 'Numb',
            artist: 'Linkin Park',
            musical_key: 'F#',
            mode: 'minor',
            verified: true,
            source: 'verified_db',
          },
        });
      }
      throw new Error(`catalogs must not be queried, got ${url}`);
    });

    const result = await lookupSongKey({ title: 'Numb', artist: 'Linkin Park' });
    expect(result.found).toBe(true);
    expect(result.song?.source).toBe('verified_db');
    expect(result.song?.verified).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('stops at the Worker when it reports a miss it already checked the catalogs for', async () => {
    const spy = mockFetch((url) => {
      if (url.includes('workers.dev')) {
        return json({ found: false, catalogsTried: true });
      }
      throw new Error(`catalogs must not be re-queried, got ${url}`);
    });

    const result = await lookupSongKey({ title: 'Nonsense', artist: 'Nobody' });
    expect(result).toEqual({ found: false, song: null, catalogsTried: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('lookupSongKey abort handling', () => {
  it('rejects instead of reporting a miss when the caller aborts mid-flight', async () => {
    const ac = new AbortController();
    mockFetch(async (url) => {
      if (url.includes('workers.dev')) {
        ac.abort();
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      return json({}, 404);
    });

    await expect(lookupSongKey({ title: 'Numb', artist: 'Linkin Park' }, ac.signal)).rejects.toThrow();
  });

  it('does not query any catalog once the caller has aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const spy = mockFetch(() => json({}, 404));

    await expect(lookupSongKey({ title: 'Numb', artist: 'Linkin Park' }, ac.signal)).rejects.toThrow();
    expect(spy.mock.calls.filter(([url]) => String(url).includes('reccobeats'))).toHaveLength(0);
  });
});

describe('normalizeLookupKey', () => {
  it('keeps a flat key readable instead of upper-casing it into nonsense', () => {
    expect(normalizeLookupKey({ musical_key: 'Bb', mode: 'minor' })).toEqual({ key: 'Bb', mode: 'minor' });
  });

  it('reads a key that already carries its mode, and a Spotify-style pitch class', () => {
    expect(normalizeLookupKey({ musical_key: 'F# minor', mode: '' })).toEqual({ key: 'F#', mode: 'minor' });
    expect(normalizeLookupKey({ musical_key: '9', mode: '0' })).toEqual({ key: 'A', mode: 'minor' });
  });

  it('returns null for a value that is not a key at all', () => {
    expect(normalizeLookupKey({ musical_key: 'unknown', mode: 'major' })).toBeNull();
  });
});
