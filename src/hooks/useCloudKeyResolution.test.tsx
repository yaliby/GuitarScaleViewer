// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { useCloudKeyResolution } from './useCloudKeyResolution';
import type { DetectedKeyState } from './useDetectedKey';
import type { MediaSessionUiState } from './useMediaSession';
import { setVerifiedEntriesForTest } from '../services/verifiedKeyDictionary';

function media(partial: Partial<MediaSessionUiState>): MediaSessionUiState {
  return {
    title: 'Numb',
    artist: 'Linkin Park',
    album: null,
    sourceApp: 'spotify',
    playbackStatus: 'playing',
    positionMs: 1_000,
    durationMs: 185_000,
    ...partial,
  };
}

const NO_LOCAL_DETECTION: DetectedKeyState = {
  primaryKey: null,
  primaryScale: null,
  displayName: null,
  confidence: 0,
  stability: 0,
  alternatives: [],
  source: 'audio_analysis',
  captureMode: 'unavailable',
  targetApp: null,
  enoughAudio: false,
  bufferSeconds: 0,
  windowCount: 0,
  ambiguous: true,
  reason: null,
  state: 'unavailable',
  readyToApply: false,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setVerifiedEntriesForTest();
});

beforeEach(() => {
  setVerifiedEntriesForTest([]);
});

describe('useCloudKeyResolution', () => {
  it('does not reopen a lookup when only the playback position ticks', async () => {
    setVerifiedEntriesForTest([{ title: 'Numb', artist: 'Linkin Park', key: 'F#', mode: 'minor' }]);
    const { result, rerender } = renderHook(({ m }) => useCloudKeyResolution(m, NO_LOCAL_DETECTION), {
      initialProps: { m: media({ positionMs: 1_000 }) },
    });

    await waitFor(() => expect(result.current.cloudState).toBe('hit'));
    expect(result.current.cloudHit?.key).toBe('F#');

    for (const positionMs of [2_500, 4_000, 5_500]) {
      rerender({ m: media({ positionMs }) });
    }
    expect(result.current.cloudState).toBe('hit');
    expect(result.current.cloudHit?.key).toBe('F#');
  });

  it('keeps a flat verified key readable instead of applying "BB" to the board', async () => {
    setVerifiedEntriesForTest([{ title: 'Numb', artist: 'Linkin Park', key: 'Bb', mode: 'minor' }]);
    const { result } = renderHook(() => useCloudKeyResolution(media({}), NO_LOCAL_DETECTION));

    await waitFor(() => expect(result.current.cloudState).toBe('hit'));
    expect(result.current.cloudHit?.key).toBe('Bb');
    expect(result.current.cloudHit?.displayName).toBe('Bb minor');
  });

  it('treats a key it cannot read as a miss rather than showing it', async () => {
    setVerifiedEntriesForTest([{ title: 'Numb', artist: 'Linkin Park', key: 'unknown', mode: 'major' }]);
    const { result } = renderHook(() => useCloudKeyResolution(media({}), NO_LOCAL_DETECTION));

    await waitFor(() => expect(result.current.cloudState).toBe('miss'));
    expect(result.current.cloudHit).toBeNull();
  });

  it('does not apply a lookup that was cancelled by a pause', async () => {
    setVerifiedEntriesForTest([{ title: 'Numb', artist: 'Linkin Park', key: 'F#', mode: 'minor' }]);
    const { result, rerender } = renderHook(({ m }) => useCloudKeyResolution(m, NO_LOCAL_DETECTION), {
      initialProps: { m: media({ playbackStatus: 'paused' }) },
    });
    await waitFor(() => expect(result.current.resolutionState).toBe('paused'));
    expect(result.current.cloudHit).toBeNull();

    rerender({ m: media({ playbackStatus: 'playing' }) });
    await waitFor(() => expect(result.current.cloudState).toBe('hit'));
    expect(result.current.cloudHit?.key).toBe('F#');
  });

  it('never opens a network socket for a library miss', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const { result } = renderHook(() => useCloudKeyResolution(media({}), NO_LOCAL_DETECTION));
    await waitFor(() => expect(result.current.cloudState).toBe('miss'));
    expect(result.current.cloudHit).toBeNull();
    const urls = spy.mock.calls.map((call) => String(call[0]));
    expect(urls.every((url) => url.includes('/chordsync/memory'))).toBe(true);
  });
});
