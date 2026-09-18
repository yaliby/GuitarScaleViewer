import { describe, expect, it, vi } from 'vitest';
import { lookupKeyFromCatalogs } from './catalogKeyLookup';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const RECCO_HIT = {
  content: [
    {
      id: 'recco-1',
      trackTitle: 'Numb',
      popularity: 90,
      href: 'https://open.spotify.com/track/numb1',
      artists: [{ name: 'Linkin Park' }],
    },
  ],
};

/**
 * ReccoBeats throttles: a burst of 48 searches came back 25 × 200 and 23 × 429. Every one of
 * those 429s used to surface as "this track has no key", and the caller cached it as a miss.
 */
describe('catalog fetch retries', () => {
  it('retries a throttled search and uses the answer from the retry', async () => {
    let searches = 0;
    const { hit } = await lookupKeyFromCatalogs('Numb', 'Linkin Park', {
      timeoutMs: 1_000,
      fetch: async (input) => {
        const url = String(input);
        if (url.includes('/v1/track/search')) {
          searches += 1;
          return searches === 1 ? jsonResponse({ error: 'slow down' }, 429) : jsonResponse(RECCO_HIT);
        }
        if (url.includes('/v1/audio-features')) {
          return jsonResponse({ content: [{ key: 6, mode: 0 }] });
        }
        return jsonResponse({}, 404);
      },
    });
    expect(searches).toBe(2);
    expect(hit).toMatchObject({ key: 'F#', mode: 'minor' });
  });

  it('honours a Retry-After header instead of its own backoff', async () => {
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
        delays.push(ms ?? 0);
        return realSetTimeout(fn, 0, ...(rest as []));
      }) as typeof setTimeout);
    try {
      let searches = 0;
      await lookupKeyFromCatalogs('Numb', 'Linkin Park', {
        timeoutMs: 1_000,
        fetch: async (input) => {
          const url = String(input);
          if (url.includes('/v1/track/search')) {
            searches += 1;
            return searches === 1
              ? jsonResponse({ error: 'slow down' }, 429, { 'Retry-After': '2' })
              : jsonResponse(RECCO_HIT);
          }
          return jsonResponse({ content: [{ key: 6, mode: 0 }] });
        },
      });
      // Retry-After is used verbatim, so it is the one delay that carries no jitter.
      expect(delays).toContain(2_000);
    } finally {
      spy.mockRestore();
    }
  });

  it('gives up after a bounded number of attempts rather than hammering the provider', async () => {
    let searches = 0;
    await lookupKeyFromCatalogs('Numb', 'Linkin Park', {
      timeoutMs: 1_000,
      budgetMs: 60_000,
      fetch: async (input) => {
        // Only the throttled endpoint answers 429; the rest miss outright, so this measures
        // one endpoint's attempts rather than the whole provider chain's.
        if (!String(input).includes('/v1/track/search')) {
          return jsonResponse({ error: 'nope' }, 404);
        }
        searches += 1;
        return jsonResponse({ error: 'slow down' }, 429);
      },
    });
    expect(searches).toBe(4);
  }, 20_000);

  it('does not retry a definitive answer', async () => {
    let searches = 0;
    await lookupKeyFromCatalogs('Numb', 'Linkin Park', {
      timeoutMs: 1_000,
      fetch: async (input) => {
        if (String(input).includes('/v1/track/search')) {
          searches += 1;
          return jsonResponse({ error: 'nope' }, 404);
        }
        return jsonResponse({ found: false });
      },
    });
    expect(searches).toBe(1);
  });

  it('stops on a caller abort raised during the backoff', async () => {
    const controller = new AbortController();
    await expect(
      lookupKeyFromCatalogs('Numb', 'Linkin Park', {
        timeoutMs: 1_000,
        signal: controller.signal,
        fetch: async (input) => {
          if (String(input).includes('/v1/track/search')) {
            controller.abort();
          }
          return jsonResponse({ error: 'slow down' }, 429);
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('abandons retries that would outlive the budget', async () => {
    let searches = 0;
    const started = Date.now();
    await lookupKeyFromCatalogs('Numb', 'Linkin Park', {
      timeoutMs: 1_000,
      budgetMs: 100,
      fetch: async (input) => {
        if (String(input).includes('/v1/track/search')) {
          searches += 1;
        }
        return jsonResponse({ error: 'slow down' }, 429);
      },
    });
    expect(searches).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('transient failure reporting', () => {
  it('reports an exhausted provider as incomplete, not as a miss', async () => {
    const result = await lookupKeyFromCatalogs('Numb', 'Linkin Park', {
      timeoutMs: 200,
      budgetMs: 300,
      fetch: async () => jsonResponse({ error: 'slow down' }, 429),
    });
    expect(result.hit).toBeNull();
    expect(result.incomplete).toBe(true);
  });

  it('reports a genuine miss as complete, so the caller may cache it', async () => {
    const result = await lookupKeyFromCatalogs('Nonsense Song', 'Nobody At All', {
      timeoutMs: 200,
      fetch: async () => jsonResponse({ content: [], found: false }),
    });
    expect(result.hit).toBeNull();
    expect(result.incomplete).toBe(false);
  });

  it('is complete when one catalog answers and another is throttled', async () => {
    const result = await lookupKeyFromCatalogs('Nonsense Song', 'Nobody At All', {
      timeoutMs: 200,
      budgetMs: 3_000,
      fetch: async (input) => {
        // ReccoBeats answers "nothing found"; MusicIWant is rate-limited into silence.
        if (String(input).includes('reccobeats.com')) {
          return jsonResponse({ content: [] });
        }
        return jsonResponse({ error: 'slow down' }, 429);
      },
    });
    expect(result.hit).toBeNull();
    expect(result.incomplete).toBe(false);
  });

  it('is complete when a provider answers, whatever the later ones do', async () => {
    const result = await lookupKeyFromCatalogs('Numb', 'Linkin Park', {
      timeoutMs: 200,
      fetch: async (input) => {
        const url = String(input);
        if (url.includes('/v1/track/search')) {
          return jsonResponse(RECCO_HIT);
        }
        if (url.includes('/v1/audio-features')) {
          return jsonResponse({ content: [{ key: 6, mode: 0 }] });
        }
        return jsonResponse({ error: 'slow down' }, 429);
      },
    });
    expect(result.hit).toMatchObject({ key: 'F#', mode: 'minor' });
    expect(result.incomplete).toBe(false);
  });

  it('traces the chain and redacts API keys from logged URLs', async () => {
    const events: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    await lookupKeyFromCatalogs('Numb', 'Linkin Park', {
      timeoutMs: 1_000,
      getsongbpmApiKey: 'super-secret',
      fetch: async (input) => {
        const url = String(input);
        if (url.includes('getsongbpm.com')) {
          return jsonResponse({
            search: [{ song_title: 'Numb', artist: { name: 'Linkin Park' }, key_of: 'F#', mode: 'minor' }],
          });
        }
        return jsonResponse({ content: [], found: false }, 404);
      },
      onTrace: (event, _message, detail) => {
        events.push({ event, detail });
      },
    });
    expect(events.some((row) => row.event === 'chain.start')).toBe(true);
    expect(events.some((row) => row.event === 'chain.hit')).toBe(true);
    expect(events.some((row) => row.event === 'provider.hit' && row.detail?.provider === 'getsongbpm')).toBe(true);
    const loggedUrls = events.map((row) => row.detail?.url).filter((url): url is string => typeof url === 'string');
    expect(loggedUrls.some((url) => url.includes('getsongbpm.com'))).toBe(true);
    for (const url of loggedUrls) {
      expect(url).not.toContain('super-secret');
    }
  });
});
