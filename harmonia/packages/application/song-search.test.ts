// @ts-nocheck
import { afterEach, expect, it, vi } from 'vitest';
import { SongSearchController } from './song-search';
import type { CatalogRecording } from './catalog-contracts';

const recording: CatalogRecording = {
  id: 'commons:42',
  provider: 'commons',
  title: 'Permitted recording',
  artist: 'Artist',
  duration: 180,
  thumbnail: null,
  pageUrl: 'https://commons.wikimedia.org/wiki/File:Song.ogg',
  audio: {
    url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Song.ogg',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: 'Artist',
    size: 100,
  },
};
afterEach(() => vi.useRealTimers());
it('preserves raw typed whitespace when debounced search starts and completes', async () => {
  vi.useFakeTimers();
  const search = vi.fn(async (_query: string) => [recording]);
  const controller = new SongSearchController({
    catalog: { search, acquire: vi.fn() },
    prepare: vi.fn(),
    cancelPreparation: vi.fn(),
    beforePrepare: async () => {},
  });
  controller.query('  Killer ');
  await vi.advanceTimersByTimeAsync(550);
  expect(search.mock.calls[0]?.[0]).toBe('Killer');
  expect(controller.snapshot().query).toBe('  Killer ');
  controller.query('  Killer Queen  ');
  await vi.advanceTimersByTimeAsync(550);
  expect(controller.snapshot().query).toBe('  Killer Queen  ');
  controller.dispose();
});
it('ignores case/spacing-only edits without cancelling or duplicating a pending search', async () => {
  vi.useFakeTimers();
  const search = vi.fn(async () => [recording]);
  const controller = new SongSearchController({
    catalog: { search, acquire: vi.fn() },
    prepare: vi.fn(),
    cancelPreparation: vi.fn(),
    beforePrepare: async () => {},
  });
  controller.query(' KILLER');
  await vi.advanceTimersByTimeAsync(400);
  controller.query(' killer  ');
  await vi.advanceTimersByTimeAsync(150);
  expect(search).toHaveBeenCalledOnce();
  expect(controller.snapshot().query).toBe(' killer  ');
  controller.query(' KILLER ');
  await vi.advanceTimersByTimeAsync(2000);
  expect(search).toHaveBeenCalledOnce();
  controller.dispose();
});
it('late rejected-audio cleanup cannot restart acquisition over a replacement song', async () => {
  let release!: (provider: 'yt-dlp') => void;
  const reject = vi.fn(
    () =>
      new Promise<'yt-dlp'>((resolve) => {
        release = resolve;
      }),
  );
  const acquire = vi.fn(async (_song: CatalogRecording, signal: AbortSignal) => {
    signal.throwIfAborted();
    return new File(['audio'], 'song.ogg');
  });
  const prepare = vi
    .fn()
    .mockRejectedValueOnce({ code: 'INVALID_AUDIO_INPUT' })
    .mockResolvedValue(undefined);
  const controller = new SongSearchController({
    catalog: { search: vi.fn(), acquire, reject },
    prepare,
    cancelPreparation: vi.fn(),
    beforePrepare: async () => {},
  });
  const pending = controller.select(recording);
  await vi.waitFor(() => expect(reject).toHaveBeenCalledOnce());
  await controller.select({ ...recording, id: 'replacement' });
  expect(controller.snapshot().status).toBe('ready');
  release('yt-dlp');
  await pending;
  expect(controller.snapshot().status).toBe('ready');
  expect(controller.snapshot().selected?.id).toBe('replacement');
  expect(acquire).toHaveBeenCalledTimes(2);
});
function fixture() {
  const acquire = vi.fn(async () => new File(['audio'], 'Song.ogg'));
  const analyze = vi.fn(async (_file: File) => {});
  const cancel = vi.fn();
  const controller = new SongSearchController({
    catalog: { search: vi.fn(async () => [recording]), acquire },
    prepare: analyze,
    cancelPreparation: cancel,
    beforePrepare: async () => {},
  });
  return { controller, acquire, analyze, cancel };
}
it('selection obtains a permitted whole input before preparing, without playing', async () => {
  const { controller, acquire, analyze } = fixture();
  await controller.search('Song', 'commons');
  await controller.select(recording);
  expect(acquire).toHaveBeenCalledOnce();
  expect(analyze).toHaveBeenCalledOnce();
  expect(controller.snapshot().status).toBe('ready');
  expect(controller.snapshot().selected?.id).toBe(recording.id);
});
it('YouTube metadata does not masquerade as analysis PCM', async () => {
  const { controller, acquire, analyze } = fixture();
  await controller.select({ ...recording, provider: 'youtube', audio: null });
  expect(controller.snapshot().status).toBe('input-required');
  expect(acquire).not.toHaveBeenCalled();
  expect(analyze).not.toHaveBeenCalled();
});
it('navigation cancellation pauses preparation without hiding an already complete timeline', async () => {
  const { controller, cancel } = fixture();
  await controller.select(recording);
  controller.cancel();
  expect(controller.snapshot().status).toBe('ready');
  expect(controller.snapshot().selected).toEqual(recording);
  expect(cancel).toHaveBeenCalled();
});
it('cancelled download cannot start analysis when its promise resolves late', async () => {
  const { controller, acquire, analyze } = fixture();
  let release!: (file: File) => void;
  acquire.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = controller.select(recording);
  await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
  controller.cancel();
  release(new File(['x'], 'old.ogg'));
  await pending;
  expect(analyze).not.toHaveBeenCalled();
  expect(controller.snapshot().status).toBe('idle');
});
it('failed source shutdown prevents network acquisition and analysis', async () => {
  const acquire = vi.fn();
  const controller = new SongSearchController({
    catalog: { search: vi.fn(), acquire },
    prepare: vi.fn(),
    cancelPreparation: vi.fn(),
    beforePrepare: async () => {
      throw new Error('Capture is still stopping');
    },
  });
  await controller.select(recording);
  expect(acquire).not.toHaveBeenCalled();
  expect(controller.snapshot().error).toContain('still stopping');
});

it('queries current search results after 550ms without Enter and ignores stale responses', async () => {
  vi.useFakeTimers();
  const queries: {
    query: string;
    signal: AbortSignal;
    resolve: (value: CatalogRecording[]) => void;
    update?: (value: CatalogRecording[]) => void;
  }[] = [];
  const search = vi.fn(
    (
      query: string,
      _provider: string,
      signal: AbortSignal,
      update?: (value: CatalogRecording[]) => void,
    ) =>
      new Promise<CatalogRecording[]>((resolve) => {
        queries.push({ query, signal, resolve, update });
      }),
  );
  const controller = new SongSearchController({
    catalog: { search, acquire: vi.fn() },
    prepare: vi.fn(),
    beforePrepare: vi.fn(),
    cancelPreparation: vi.fn(),
  });
  controller.query('b');
  await vi.advanceTimersByTimeAsync(400);
  expect(search).not.toHaveBeenCalled();
  controller.query('bo');
  await vi.advanceTimersByTimeAsync(200);
  controller.query('bou');
  await vi.advanceTimersByTimeAsync(549);
  expect(search).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(queries[0].query).toBe('bou');
  queries[0].update?.([{ ...recording, title: 'Immediate YouTube result' }]);
  expect(controller.snapshot().results[0].title).toBe('Immediate YouTube result');
  controller.query('boulevard');
  expect(queries[0].signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(550);
  queries[1].resolve([{ ...recording, title: 'Newest result' }]);
  await vi.advanceTimersByTimeAsync(0);
  queries[0].update?.([{ ...recording, title: 'Obsolete partial result' }]);
  queries[0].resolve([{ ...recording, title: 'Obsolete result' }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.snapshot().results[0].title).toBe('Newest result');
  controller.query('');
  await vi.advanceTimersByTimeAsync(400);
  expect(search).toHaveBeenCalledTimes(2);
  expect(controller.snapshot().results).toEqual([]);
  controller.dispose();
});

it('requests automatic playback only after complete preparation and remains ready if autoplay is denied', async () => {
  let finish!: () => void;
  const prepare = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const playPrepared = vi.fn(async () => {
    throw new Error('Autoplay denied');
  });
  const controller = new SongSearchController({
    catalog: { search: vi.fn(), acquire: vi.fn(async () => new File(['x'], 'song.wav')) },
    prepare,
    playPrepared,
    beforePrepare: vi.fn(),
    cancelPreparation: vi.fn(),
  });
  const pending = controller.select(recording);
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
  expect(playPrepared).not.toHaveBeenCalled();
  expect(controller.snapshot().status).toBe('analyzing');
  finish();
  await pending;
  expect(playPrepared).toHaveBeenCalledOnce();
  expect(controller.snapshot().status).toBe('ready');
  expect(controller.snapshot().playbackNotice).toContain('Play');
});

it('cancelled preparation cannot later autoplay or replace the ready page', async () => {
  let finish!: () => void;
  const prepare = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const playPrepared = vi.fn();
  const controller = new SongSearchController({
    catalog: { search: vi.fn(), acquire: vi.fn() },
    prepare,
    playPrepared,
    beforePrepare: vi.fn(),
    cancelPreparation: vi.fn(),
  });
  const pending = controller.local(new File(['x'], 'song.wav'));
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
  controller.cancel();
  finish();
  await pending;
  expect(playPrepared).not.toHaveBeenCalled();
  expect(controller.snapshot().status).toBe('idle');
});
