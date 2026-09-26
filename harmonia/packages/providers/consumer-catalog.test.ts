// @ts-nocheck
import { afterEach, expect, it, vi } from 'vitest';
import { ConsumerCatalog } from './consumer-catalog';
import type { CatalogRecording } from '../application/catalog-contracts';
import { NativeSearchError } from './native-search';
afterEach(() => vi.useRealTimers());

it('preserves safe quota explanations rather than blaming the computer', async () => {
  const service = new ConsumerCatalog(
    {
      search: async () => {
        throw new NativeSearchError('quota');
      },
    },
    { search: async () => [], acquire: vi.fn() },
  );
  const page = await service.search('song', 'youtube', new AbortController().signal);
  expect(page.notice).toContain('search limit');
  expect(page.notice).not.toContain('on this computer');
});

it('does not discard playable catalog results after only two seconds', async () => {
  vi.useFakeTimers();
  let sourceSignal!: AbortSignal;
  let finish!: (value: CatalogRecording[]) => void;
  const service = new ConsumerCatalog(
    { search: async () => [video] },
    {
      search: (_q, _provider, signal) =>
        new Promise((resolve) => {
          sourceSignal = signal;
          finish = resolve;
        }),
      acquire: vi.fn(),
    },
  );
  const pending = service.search('song', 'youtube', new AbortController().signal);
  await vi.advanceTimersByTimeAsync(2500);
  expect(sourceSignal.aborted).toBe(false);
  finish([permitted]);
  expect((await pending).results).toContain(permitted);
});

it('explains when search finds only watch-only videos, not playable recordings', async () => {
  const service = new ConsumerCatalog(
    { search: async () => [video] },
    { search: async () => [], acquire: vi.fn() },
  );
  const page = await service.search('song', 'youtube', new AbortController().signal);
  expect(page.notice).toContain('YouTube results are watch-only');
});

const video: CatalogRecording = {
  id: 'abcdefghijk',
  provider: 'youtube',
  title: 'Song',
  artist: 'Channel',
  duration: 150,
  thumbnail: 'https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg',
  pageUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
  audio: null,
};
const permitted = {
  ...video,
  provider: 'commons',
  id: '123',
  title: 'Another performance',
} as CatalogRecording;
it('publishes YouTube immediately while supplementary recordings are still loading', async () => {
  let finish!: (value: CatalogRecording[]) => void;
  const update = vi.fn();
  const service = new ConsumerCatalog(
    { search: async () => [video] },
    {
      search: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      acquire: vi.fn(),
    },
  );
  const pending = service.search('bou', 'youtube', new AbortController().signal, update);
  await vi.waitFor(() => expect(update).toHaveBeenCalledWith([video]));
  finish([permitted]);
  expect((await pending).results).toEqual([video, permitted]);
});
it('queries real search adapter for every distinct query and keeps recording identities separate', async () => {
  const youtube = { search: vi.fn(async (_query: string, _signal: AbortSignal) => [video]) };
  const catalog = { search: vi.fn(async () => [permitted]), acquire: vi.fn() };
  const service = new ConsumerCatalog(youtube, catalog);
  const signal = new AbortController().signal;
  expect((await service.search('bou', 'youtube', signal)).results).toEqual([video, permitted]);
  await service.search('boulevard', 'youtube', signal);
  expect(youtube.search.mock.calls.map((call) => call[0])).toEqual(['bou', 'boulevard']);
  expect(catalog.search).toHaveBeenCalledWith('boulevard', 'commons', expect.any(AbortSignal));
  expect(video.audio).toBeNull();
});
it('missing YouTube configuration is truthful and never silently relabels other recordings', async () => {
  const service = new ConsumerCatalog(
    {
      search: vi.fn(async () => {
        throw new Error('Search is not configured');
      }),
    },
    { search: vi.fn(async () => [permitted]), acquire: vi.fn() },
  );
  const page = await service.search('song', 'youtube', new AbortController().signal);
  expect(page.notice).toContain('YouTube');
  expect(page.results[0].provider).toBe('commons');
});
it('cancellation rejects even when a provider ignores cancellation', async () => {
  const abort = new AbortController();
  const service = new ConsumerCatalog(
    {
      search: vi.fn(async () => {
        abort.abort();
        return [video];
      }),
    },
    { search: vi.fn(async () => [permitted]), acquire: vi.fn() },
  );
  await expect(service.search('song', 'youtube', abort.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
});
