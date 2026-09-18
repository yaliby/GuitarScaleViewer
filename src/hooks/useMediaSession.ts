import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { trace } from '../services/debugLog';

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

function mediaIdentity(state: MediaSessionUiState): string {
  return [state.sourceApp, state.title, state.artist, state.album, state.playbackStatus].join('|');
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
  const lastIdentityRef = useRef<string | null>(null);

  const apply = (next: MediaSessionUiState) => {
    const identity = mediaIdentity(next);
    if (lastIdentityRef.current !== identity) {
      lastIdentityRef.current = identity;
      trace('media', 'session', `Now playing: ${[next.artist, next.title].filter(Boolean).join(' — ') || '(none)'} [${next.playbackStatus}]`, {
        title: next.title,
        artist: next.artist,
        album: next.album,
        sourceApp: next.sourceApp,
        playbackStatus: next.playbackStatus,
        durationMs: next.durationMs,
      }, next.playbackStatus === 'media_session_unavailable' ? 'fail' : 'info');
    }
    setState(next);
  };

  useEffect(() => {
    if (!isTauri()) {
      trace('media', 'unavailable', 'Not running inside Tauri — OS media session is unavailable', {
        why: 'not_tauri',
      }, 'skip');
      setState(BROWSER_FALLBACK);
      return;
    }

    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const initial = await invoke<MediaSessionWire>('get_current_media');
        if (!cancelled) {
          apply(wireToUi(initial));
        }

        const nextUnlisten = await listen<MediaSessionWire>('media-session-update', (event) => {
          if (!cancelled) {
            apply(wireToUi(event.payload));
          }
        });
        if (cancelled) {
          nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;
        trace('media', 'subscribed', 'Listening for media-session-update from Rust', undefined, 'ok');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        trace('media', 'subscribe_fail', `Could not read the OS media session (${message})`, {
          why: 'invoke_or_listen_failed',
          error: message,
        }, 'fail');
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
