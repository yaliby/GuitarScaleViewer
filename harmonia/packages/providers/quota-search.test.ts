// @ts-nocheck
import { afterEach, expect, it, vi } from 'vitest';
import { QuotaAwareYouTubeSearch, normalizeSearchQuery } from './quota-search';
import { NativeSearchError } from './native-search';
import type { CatalogRecording } from '../application/catalog-contracts';
import { SongSearchController } from '../application/song-search';

const results: CatalogRecording[] = ['Official', 'Live', 'Acoustic'].map((suffix, index) => ({
  provider: 'youtube',
  id: `abcdefghij${index}`,
  title: `Boulevard of Broken Dreams ${suffix}`,
  artist: 'Green Day',
  duration: 240,
  thumbnail: null,
  pageUrl: `https://www.youtube.com/watch?v=abcdefghij${index}`,
  audio: null,
}));
const signal = () => new AbortController().signal;
afterEach(() => vi.useRealTimers());

it('normalizes spacing, Unicode and case without removing Hebrew letters', () => {
  expect(normalizeSearchQuery('  KILLER   Queen  ')).toBe('killer queen');
  expect(normalizeSearchQuery('  שיר   הנושא ')).toBe('שיר הנושא');
});

it('uses one provider call for a complete query, normalized repeats and matching prefixes', async () => {
  const search = vi.fn(async () => results);
  const service = new QuotaAwareYouTubeSearch({ search });
  expect(await service.search('bo', signal())).toEqual([]);
  await service.search('bou', signal());
  await service.search(' BOu ', signal());
  await service.search('boulevard', signal());
  await service.search('boulevard of broken dreams', signal());
  expect(search).toHaveBeenCalledTimes(1);
  expect(service.diagnostics()).toMatchObject({ calls: 1, cacheHits: 1, prefixHits: 2 });
});

it('shares in-flight queries and cancels transport only after its last subscriber leaves', async () => {
  let resolve!: (value: CatalogRecording[]) => void;
  const search = vi.fn(
    (_q: string, _signal: AbortSignal) =>
      new Promise<CatalogRecording[]>((r) => {
        resolve = r;
      }),
  );
  const service = new QuotaAwareYouTubeSearch({ search });
  const first = new AbortController(),
    second = new AbortController();
  const a = service.search('song', first.signal),
    b = service.search(' SONG ', second.signal);
  const rejected = expect(a).rejects.toMatchObject({ name: 'AbortError' });
  first.abort();
  await rejected;
  expect(search.mock.calls[0][1].aborted).toBe(false);
  resolve(results);
  expect(await b).toEqual(results);
  expect(search).toHaveBeenCalledOnce();
});

it('paces uncached requests, and cancellation before dispatch spends no call', async () => {
  vi.useFakeTimers();
  const search = vi.fn(async () => []);
  const service = new QuotaAwareYouTubeSearch({ search });
  await service.search('first', signal());
  const abort = new AbortController();
  const pending = service.search('second', abort.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  abort.abort();
  await rejected;
  const third = service.search('third', signal());
  await vi.advanceTimersByTimeAsync(1999);
  expect(search).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await third;
  expect(search).toHaveBeenCalledTimes(2);
});

it('restores a bounded local cache and never stores credentials or unrelated fields', async () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
  const search = vi.fn(async () => results.map((r) => ({ ...r, secret: 'must-not-persist' })));
  await new QuotaAwareYouTubeSearch({ search }, { storage }).search('boulevard', signal());
  const reopened = new QuotaAwareYouTubeSearch({ search }, { storage });
  expect(await reopened.search(' BOULEVARD ', signal())).toEqual(results);
  expect(search).toHaveBeenCalledOnce();
  expect([...data.values()].join()).not.toContain('must-not-persist');
});

it('rate-limit cooldown applies across queries while cached results still work', async () => {
  vi.useFakeTimers();
  const search = vi
    .fn()
    .mockResolvedValueOnce(results)
    .mockRejectedValue(new NativeSearchError('quota'));
  const service = new QuotaAwareYouTubeSearch({ search });
  await service.search('bou', signal());
  await vi.advanceTimersByTimeAsync(2000);
  await expect(service.search('queen', signal())).rejects.toMatchObject({ code: 'quota' });
  await expect(service.search('another artist', signal())).rejects.toMatchObject({ code: 'quota' });
  expect(await service.search('bou', signal())).toEqual(results);
  expect(search).toHaveBeenCalledTimes(2);
});

it('caches empty results, expires old metadata, and caps persisted entries at 100', async () => {
  vi.useFakeTimers();
  let saved = '';
  const storage = {
    getItem: () => saved,
    setItem: (_key: string, value: string) => {
      saved = value;
    },
  };
  const search = vi.fn(async () => []);
  const service = new QuotaAwareYouTubeSearch({ search }, { storage });
  await service.search('empty result', signal());
  await service.search(' EMPTY   result ', signal());
  expect(search).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 101; i++) {
    vi.setSystemTime(Date.now() + 2000);
    await service.search(`query ${i}`, signal());
  }
  expect(JSON.parse(saved).entries).toHaveLength(100);
  const calls = search.mock.calls.length;
  vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
  await service.search('query 100', signal());
  expect(search).toHaveBeenCalledTimes(calls + 1);
  expect(JSON.parse(saved).entries).toHaveLength(1);
});

it('a weak prefix match requests fresh results and discards hostile cached fields', async () => {
  vi.useFakeTimers();
  const search = vi.fn(async () => results.slice(0, 1));
  const service = new QuotaAwareYouTubeSearch({ search });
  await service.search('bou', signal());
  vi.setSystemTime(Date.now() + 2000);
  await service.search('boulevard', signal());
  expect(search).toHaveBeenCalledTimes(2);
  const storage = {
    getItem: () =>
      JSON.stringify({
        version: 1,
        entries: [
          {
            query: 'attack',
            at: Date.now(),
            results: [
              {
                ...results[0],
                pageUrl: 'javascript:bad()',
                thumbnail: 'https://hostile.invalid/tracker',
              },
            ],
          },
        ],
      }),
    setItem: vi.fn(),
  };
  const cached = await new QuotaAwareYouTubeSearch({ search }, { storage }).search(
    'attack',
    signal(),
  );
  expect(cached[0].pageUrl).toBe(results[0].pageUrl);
  expect(cached[0].thumbnail).toBeNull();
});

it('last-subscriber cancellation reaches upstream and prevents immediate retry loops', async () => {
  const search = vi.fn(
    (_query: string, signal: AbortSignal) =>
      new Promise<CatalogRecording[]>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')));
      }),
  );
  const service = new QuotaAwareYouTubeSearch({ search });
  const abort = new AbortController();
  const request = service.search('old query', abort.signal);
  const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });
  abort.abort();
  await rejected;
  expect(search.mock.calls[0][1].aborted).toBe(true);
  await expect(service.search(' OLD query ', signal())).rejects.toMatchObject({ code: 'busy' });
  expect(search).toHaveBeenCalledOnce();
});

it('bounds a slow complete search to four dispatches even with no reusable prefix results', async () => {
  vi.useFakeTimers();
  const queries: string[] = [];
  const upstream = {
    search: vi.fn(async (query: string) => {
      queries.push(query);
      return [];
    }),
  };
  const service = new QuotaAwareYouTubeSearch(upstream);
  const controller = new SongSearchController({
    catalog: {
      search: (query, _provider, signal) => service.search(query, signal),
      acquire: vi.fn(),
    },
    prepare: vi.fn(),
    beforePrepare: async () => {},
    cancelPreparation: vi.fn(),
  });
  const text = 'killer queen';
  for (let index = 1; index <= text.length; index++) {
    controller.query(text.slice(0, index));
    await vi.advanceTimersByTimeAsync(600);
  }
  await vi.runAllTimersAsync();
  expect(queries).toHaveLength(4);
  expect(queries.at(-1)).toBe(text);
  controller.query(' KILLER   QUEEN ');
  await vi.runAllTimersAsync();
  expect(queries).toHaveLength(4);
  console.info(
    '[quota regression]',
    JSON.stringify({
      transport: 'mock',
      characters: text.length,
      searchListCalls: queries.length,
      repeatedQueryExtraCalls: 0,
    }),
  );
  controller.dispose();
});
