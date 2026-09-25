import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetectedKeyState } from './useDetectedKey';
import type { MediaSessionUiState } from './useMediaSession';

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
  listen: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  lookupSongKey: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriMocks.invoke,
  isTauri: tauriMocks.isTauri,
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: tauriMocks.listen }));

// The library lookup is local. `normalizeLookupKey` is kept real so a readable
// bundled key still reaches the neck.
vi.mock('../services/songKeyApi', async () => {
  const actual = await vi.importActual<typeof import('../services/songKeyApi')>(
    '../services/songKeyApi',
  );
  return { ...actual, ...apiMocks };
});

import { useCloudKeyResolution } from './useCloudKeyResolution';
import { useDetectedKey } from './useDetectedKey';
import { useMediaSession } from './useMediaSession';

const DETECTED: DetectedKeyState = {
  primaryKey: 'D',
  primaryScale: 'major',
  displayName: 'D major',
  confidence: 0.8,
  stability: 0.8,
  alternatives: [],
  source: 'audio_analysis',
  captureMode: 'process_loopback',
  targetApp: 'Spotify',
  enoughAudio: true,
  bufferSeconds: 12,
  windowCount: 4,
  ambiguous: false,
  reason: null,
  state: 'likely_key',
  readyToApply: true,
};

const PLAYING: MediaSessionUiState = {
  title: 'Blue in Green',
  artist: 'Miles Davis',
  album: 'Kind of Blue',
  sourceApp: 'Spotify',
  playbackStatus: 'playing',
  positionMs: 10_000,
  durationMs: 329_000,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function libraryHit(key: string, mode: 'major' | 'minor') {
  return {
    found: true as const,
    song: {
      id: 'song-1',
      title: PLAYING.title!,
      artist: PLAYING.artist!,
      musical_key: key,
      mode,
      verified: true as const,
      source: 'verified_library' as const,
      sourceLabel: 'Verified library',
    },
  };
}

beforeEach(() => {
  tauriMocks.isTauri.mockReturnValue(false);
  tauriMocks.invoke.mockReset();
  tauriMocks.listen.mockReset();
  apiMocks.lookupSongKey.mockReset();
});

describe('useCloudKeyResolution', () => {
  it('does not restart a lookup for a position-only media update', async () => {
    apiMocks.lookupSongKey.mockReturnValue({ found: false, song: null });
    const { rerender } = renderHook(
      ({ media }) => useCloudKeyResolution(media, DETECTED),
      { initialProps: { media: PLAYING } },
    );

    await waitFor(() => expect(apiMocks.lookupSongKey).toHaveBeenCalledTimes(1));
    rerender({ media: { ...PLAYING, positionMs: 11_000 } });
    rerender({ media: { ...PLAYING, positionMs: 12_000 } });

    await act(async () => undefined);
    expect(apiMocks.lookupSongKey).toHaveBeenCalledTimes(1);
  });

  it('preserves B-flat from a valid library result', async () => {
    apiMocks.lookupSongKey.mockReturnValue(libraryHit('Bb', 'major'));
    const { result } = renderHook(() => useCloudKeyResolution(PLAYING, DETECTED));

    await waitFor(() => expect(result.current.cloudState).toBe('hit'));
    expect(result.current.cloudHit).toMatchObject({ key: 'Bb', mode: 'major' });
  });

  it('does not apply a library hit while playback is paused', async () => {
    apiMocks.lookupSongKey.mockReturnValue(libraryHit('C', 'major'));
    const { result } = renderHook(() =>
      useCloudKeyResolution({ ...PLAYING, playbackStatus: 'paused' }, DETECTED),
    );

    await waitFor(() => expect(result.current.resolutionState).toBe('paused'));
    expect(result.current.cloudHit).toBeNull();
    expect(apiMocks.lookupSongKey).not.toHaveBeenCalled();
  });

  it('clears the previous library hit when the track changes while paused', async () => {
    apiMocks.lookupSongKey.mockReturnValue(libraryHit('Bb', 'major'));
    const { result, rerender } = renderHook(
      ({ media }) => useCloudKeyResolution(media, DETECTED),
      { initialProps: { media: PLAYING } },
    );
    await waitFor(() => expect(result.current.cloudState).toBe('hit'));

    rerender({
      media: {
        ...PLAYING,
        title: 'So What',
        playbackStatus: 'paused',
        positionMs: 0,
      },
    });

    await waitFor(() => expect(result.current.resolutionState).toBe('paused'));
    expect(result.current.cloudHit).toBeNull();
  });

  it('keeps the paused resolution state when a local result arrives', async () => {
    apiMocks.lookupSongKey.mockReturnValue({ found: false, song: null });
    const warming: DetectedKeyState = {
      ...DETECTED,
      primaryKey: null,
      primaryScale: null,
      displayName: null,
    };
    const { result, rerender } = renderHook(
      ({ media, detected }) => useCloudKeyResolution(media, detected),
      { initialProps: { media: { ...PLAYING, playbackStatus: 'paused' }, detected: warming } },
    );
    await waitFor(() => expect(result.current.resolutionState).toBe('paused'));

    rerender({ media: { ...PLAYING, playbackStatus: 'paused' }, detected: DETECTED });

    expect(result.current.resolutionState).toBe('paused');
  });

  it('clears the library hit after the media session closes', async () => {
    apiMocks.lookupSongKey.mockReturnValue(libraryHit('C', 'major'));
    const { result, rerender } = renderHook(
      ({ media }) => useCloudKeyResolution(media, DETECTED),
      { initialProps: { media: PLAYING } },
    );
    await waitFor(() => expect(result.current.cloudState).toBe('hit'));

    rerender({ media: { ...PLAYING, playbackStatus: 'closed' } });

    await waitFor(() => expect(result.current.resolutionState).toBe('no_session'));
    expect(result.current.cloudHit).toBeNull();
  });
});

describe('native hook listener cleanup', () => {
  it('unsubscribes a media listener that finishes registering after unmount', async () => {
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.invoke.mockResolvedValue({
      title: null,
      artist: null,
      album: null,
      source_app: null,
      playback_status: 'none',
      position_ms: null,
      duration_ms: null,
    });
    const subscription = deferred<() => void>();
    const unlisten = vi.fn();
    tauriMocks.listen.mockReturnValue(subscription.promise);
    const { unmount } = renderHook(() => useMediaSession());
    await waitFor(() => expect(tauriMocks.listen).toHaveBeenCalledTimes(1));

    unmount();
    subscription.resolve(unlisten);

    await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });

  it('shares one media-session listener across subscribers', async () => {
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.invoke.mockResolvedValue({
      title: 'Shared track',
      artist: 'Shared artist',
      album: null,
      source_app: 'Test player',
      playback_status: 'playing',
      position_ms: 1000,
      duration_ms: 120_000,
    });
    const unlisten = vi.fn();
    tauriMocks.listen.mockResolvedValue(unlisten);
    const first = renderHook(() => useMediaSession());
    const second = renderHook(() => useMediaSession());
    await waitFor(() => expect(tauriMocks.listen).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(first.result.current.title).toBe('Shared track'));
    expect(second.result.current.title).toBe('Shared track');
    first.unmount();
    expect(unlisten).not.toHaveBeenCalled();
    second.unmount();
    await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });

  it('unsubscribes detected-key listeners that finish registering after unmount', async () => {
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.invoke.mockResolvedValue(DETECTED);
    const firstSubscription = deferred<() => void>();
    const unlisten = vi.fn();
    tauriMocks.listen.mockReturnValueOnce(firstSubscription.promise);
    const { unmount } = renderHook(() => useDetectedKey());
    await waitFor(() => expect(tauriMocks.listen).toHaveBeenCalledTimes(1));

    unmount();
    firstSubscription.resolve(unlisten);

    await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });
});
