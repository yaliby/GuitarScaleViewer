// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useCloudKeyResolution } from './useCloudKeyResolution';
import type { DetectedKeyState } from './useDetectedKey';
import type { MediaSessionUiState } from './useMediaSession';

/**
 * These cover the boundary between the media-session poller and the lookup chain — the place
 * where every leg passes its own unit tests and the feature still never resolves in the app.
 */

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function verifiedHit(musical_key: string, mode: string) {
  return {
    found: true,
    source: 'verified_db',
    song: { id: 'db-1', title: 'Numb', artist: 'Linkin Park', musical_key, mode, verified: true },
  };
}

/** Worker responses are handed out one deferred promise at a time, so a lookup can be held open. */
function deferredWorkerFetch() {
  const pending: Array<(res: Response) => void> = [];
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    if (!String(input).includes('workers.dev')) {
      return jsonResponse({}, 404);
    }
    return new Promise<Response>((resolve) => {
      pending.push(resolve);
    });
  });
  vi.stubGlobal('fetch', spy);
  return { spy, pending, workerCalls: () => spy.mock.calls.filter(([u]) => String(u).includes('workers.dev')).length };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useCloudKeyResolution', () => {
  it('does not restart the lookup when only the playback position ticks', async () => {
    const { pending, workerCalls } = deferredWorkerFetch();
    const { result, rerender } = renderHook(({ m }) => useCloudKeyResolution(m, NO_LOCAL_DETECTION), {
      initialProps: { m: media({ positionMs: 1_000 }) },
    });

    await waitFor(() => expect(workerCalls()).toBe(1));

    // What the backend poller does every 1.5s: same track, new position, new object identity.
    for (const positionMs of [2_500, 4_000, 5_500]) {
      rerender({ m: media({ positionMs }) });
    }
    expect(workerCalls()).toBe(1);

    pending[0]!(jsonResponse(verifiedHit('F#', 'minor')));
    await waitFor(() => expect(result.current.cloudState).toBe('hit'));
    expect(result.current.cloudHit?.key).toBe('F#');
    expect(workerCalls()).toBe(1);
  });

  it('keeps a flat verified key readable instead of applying "BB" to the board', async () => {
    const { pending } = deferredWorkerFetch();
    const { result } = renderHook(() => useCloudKeyResolution(media({}), NO_LOCAL_DETECTION));

    await waitFor(() => expect(pending).toHaveLength(1));
    pending[0]!(jsonResponse(verifiedHit('Bb', 'minor')));

    await waitFor(() => expect(result.current.cloudState).toBe('hit'));
    expect(result.current.cloudHit?.key).toBe('Bb');
    expect(result.current.cloudHit?.displayName).toBe('Bb minor');
  });

  it('treats a key it cannot read as a miss rather than showing it', async () => {
    const { pending } = deferredWorkerFetch();
    const { result } = renderHook(() => useCloudKeyResolution(media({}), NO_LOCAL_DETECTION));

    await waitFor(() => expect(pending).toHaveLength(1));
    pending[0]!(jsonResponse(verifiedHit('unknown', 'major')));

    await waitFor(() => expect(result.current.cloudState).toBe('miss'));
    expect(result.current.cloudHit).toBeNull();
  });

  it('does not cache a miss from a lookup that was cancelled by a pause', async () => {
    const { pending, workerCalls } = deferredWorkerFetch();
    const { result, rerender } = renderHook(({ m }) => useCloudKeyResolution(m, NO_LOCAL_DETECTION), {
      initialProps: { m: media({}) },
    });
    await waitFor(() => expect(workerCalls()).toBe(1));

    rerender({ m: media({ playbackStatus: 'paused' }) });
    await waitFor(() => expect(result.current.resolutionState).toBe('paused'));
    // The cancelled request still settles; the catalog leg reports its own failures as a miss.
    // Flush it before resuming, so a miss that leaked into the cache would be visible here.
    await act(async () => {
      pending[0]!(jsonResponse({ found: false, catalogsTried: true }));
      await Promise.resolve();
    });
    expect(result.current.cloudState).not.toBe('miss');

    rerender({ m: media({ positionMs: 7_000 }) });
    await waitFor(() => expect(workerCalls()).toBe(2));
    pending[1]!(jsonResponse(verifiedHit('F#', 'minor')));

    await waitFor(() => expect(result.current.cloudState).toBe('hit'));
    expect(result.current.cloudHit?.key).toBe('F#');
  });
});

/**
 * The failure this guards against is the one that makes the feature feel broken: a single 429
 * from a catalog used to come back as "no key for this song" and get cached for five minutes,
 * so the track played to the end with an empty board and no way to ask again.
 */
describe('useCloudKeyResolution transient failures', () => {
  const RECCO_SEARCH_HIT = {
    content: [
      {
        id: 'recco-1',
        trackTitle: 'Numb',
        artists: [{ name: 'Linkin Park' }],
        popularity: 90,
        href: null,
      },
    ],
  };

  /** Worker cannot reach the catalogs; the client's own catalog leg is throttled until `open`. */
  function throttledCatalogs(open: () => boolean) {
    const calls = { worker: 0, catalog: 0 };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('workers.dev')) {
          calls.worker += 1;
          return jsonResponse({ found: false, catalogsTried: false, song: null });
        }
        calls.catalog += 1;
        if (!open()) {
          return jsonResponse({ error: 'slow down' }, 429);
        }
        if (url.includes('/v1/track/search')) {
          return jsonResponse(RECCO_SEARCH_HIT);
        }
        if (url.includes('audio-features')) {
          return jsonResponse({ key: 10, mode: 0 });
        }
        return jsonResponse({}, 404);
      }),
    );
    return calls;
  }

  it('retries a throttled lookup and applies the key the retry returns', async () => {
    vi.useFakeTimers();
    try {
      let open = false;
      throttledCatalogs(() => open);
      const { result } = renderHook(() => useCloudKeyResolution(media({}), NO_LOCAL_DETECTION));

      // First round: every catalog answers 429, so there is no answer to cache.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_000);
      });
      expect(result.current.cloudState).not.toBe('hit');

      open = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      // No `waitFor` here: it polls on a real clock that these fake timers never advance.
      expect(result.current.cloudState).toBe('hit');
      expect(result.current.cloudHit?.key).toBe('Bb');
      expect(result.current.cloudHit?.mode).toBe('minor');
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it('does not cache an unanswered lookup, so the next attempt still asks', async () => {
    vi.useFakeTimers();
    try {
      const calls = throttledCatalogs(() => false);
      const { result, rerender } = renderHook(({ m }) => useCloudKeyResolution(m, NO_LOCAL_DETECTION), {
        initialProps: { m: media({}) },
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(result.current.cloudState).toBe('miss');
      const afterFirstRound = calls.worker;
      expect(afterFirstRound).toBeGreaterThan(1);

      // Pause and resume the same track: a cached miss would short-circuit this.
      rerender({ m: media({ playbackStatus: 'paused' }) });
      rerender({ m: media({ playbackStatus: 'playing' }) });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(calls.worker).toBeGreaterThan(afterFirstRound);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});
