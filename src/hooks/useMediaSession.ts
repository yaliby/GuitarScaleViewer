import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** Payload from Rust (`serde` default: snake_case keys). */
type MediaSessionWire = {
  title: string | null;
  artist: string | null;
  album: string | null;
  source_app: string | null;
  playback_status: string;
  position_ms: number | null;
  duration_ms: number | null;
};

export type MediaSessionUiState = {
  title: string | null;
  artist: string | null;
  album: string | null;
  sourceApp: string | null;
  playbackStatus: string;
  positionMs: number | null;
  durationMs: number | null;
};

const BROWSER_FALLBACK: MediaSessionUiState = {
  title: null,
  artist: null,
  album: null,
  sourceApp: null,
  playbackStatus: 'media_session_unavailable',
  positionMs: null,
  durationMs: null,
};

function wireToUi(w: MediaSessionWire): MediaSessionUiState {
  return {
    title: w.title,
    artist: w.artist,
    album: w.album,
    sourceApp: w.source_app,
    playbackStatus: w.playback_status,
    positionMs: w.position_ms,
    durationMs: w.duration_ms,
  };
}

/**
 * Subscribes to Tauri `media-session-update` (no React-side polling).
 * Windows uses GSMTC; Linux uses MPRIS. Phase 2 may extend this path with
 * key lookup / audio analysis → scale UI.
 */
export function useMediaSession(): MediaSessionUiState {
  const [state, setState] = useState<MediaSessionUiState>(() =>
    isTauri() ? { ...BROWSER_FALLBACK, playbackStatus: 'none' } : BROWSER_FALLBACK,
  );

  useEffect(() => {
    if (!isTauri()) {
      setState(BROWSER_FALLBACK);
      return;
    }

    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const initial = await invoke<MediaSessionWire>('get_current_media');
        if (!cancelled) {
          setState(wireToUi(initial));
        }

        unlisten = await listen<MediaSessionWire>('media-session-update', (event) => {
          if (!cancelled) {
            setState(wireToUi(event.payload));
          }
        });
      } catch {
        if (!cancelled) {
          setState(BROWSER_FALLBACK);
        }
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return state;
}
