// @ts-nocheck
import { expect, it, vi } from 'vitest';
import { NativeWholeSongAudioProvider, PREPARATION_UNAVAILABLE } from './native-audio';
import type { CatalogRecording } from '../application/catalog-contracts';
const recording: CatalogRecording = {
  provider: 'youtube',
  id: 'abcdefghijk',
  title: 'Song',
  artist: 'Artist',
  thumbnail: null,
  pageUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
  duration: 10,
  audio: null,
};
const metadata = {
  provider: 'yt-dlp',
  videoId: recording.id,
  title: 'Song',
  duration: 10,
  mime: 'audio/webm',
  container: 'webm',
  cacheToken: 'a'.repeat(64),
  fingerprint: 'b'.repeat(64),
  byteLength: 3,
  cached: false,
  acquisitionMs: 15,
};
it('reads the exact bounded complete media through opaque native tokens', async () => {
  const call = vi.fn(async (command: string) =>
    command === 'audio_acquire' ? metadata : new Uint8Array([1, 2, 3]).buffer,
  );
  const audio = await new NativeWholeSongAudioProvider(call as never, () => true).acquire(
    recording,
    new AbortController().signal,
    vi.fn(),
  );
  expect(Array.from(new Uint8Array(await audio.file.arrayBuffer()))).toEqual([1, 2, 3]);
  expect(audio.file.name).toBe('abcdefghijk.webm');
  expect(call).toHaveBeenCalledWith('audio_read', {
    cacheToken: metadata.cacheToken,
    offset: 0,
    length: 3,
  });
});
it('rejects mismatched identities and exposes no provider URL or secret error', async () => {
  const call = vi.fn(async () => ({ ...metadata, videoId: 'wrong' }));
  await expect(
    new NativeWholeSongAudioProvider(call as never, () => true).acquire(
      recording,
      new AbortController().signal,
      vi.fn(),
    ),
  ).rejects.toThrow(PREPARATION_UNAVAILABLE);
  expect(call).toHaveBeenCalledWith('audio_reject', { cacheToken: metadata.cacheToken });
});
it('cancels pending acquisition without reading stale bytes', async () => {
  let resolve!: (v: unknown) => void;
  const call = vi.fn((command: string) =>
    command === 'audio_acquire'
      ? new Promise((r) => {
          resolve = r;
        })
      : Promise.resolve(),
  );
  const abort = new AbortController();
  const task = new NativeWholeSongAudioProvider(call as never, () => true).acquire(
    recording,
    abort.signal,
    vi.fn(),
  );
  abort.abort();
  resolve(metadata);
  await expect(task).rejects.toMatchObject({ name: 'AbortError' });
  expect(call.mock.calls.map((c) => c[0])).toEqual(['audio_acquire', 'audio_cancel']);
});
