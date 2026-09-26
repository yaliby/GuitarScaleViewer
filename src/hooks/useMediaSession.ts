import { useEffect, useState } from 'react';
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
  track_url?: string | null;
  artwork_url?: string | null;
};

export type MediaSessionUiState = {
  title: string | null;
  artist: string | null;
  album: string | null;
  sourceApp: string | null;
  playbackStatus: string;
  positionMs: number | null;
  durationMs: number | null;
  trackUrl?: string | null;
  artworkUrl?: string | null;
};

const BROWSER_FALLBACK: MediaSessionUiState = {
  title: null,
  artist: null,
  album: null,
  sourceApp: null,
  playbackStatus: 'media_session_unavailable',
  positionMs: null,
  durationMs: null,
  trackUrl: null,
  artworkUrl: null,
};

const TAURI_EMPTY: MediaSessionUiState = {
  ...BROWSER_FALLBACK,
  playbackStatus: 'none',
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
    trackUrl: w.track_url ?? null,
    artworkUrl: w.artwork_url ?? null,
  };
}

function mediaIdentity(state: MediaSessionUiState): string {
  return [state.sourceApp, state.title, state.artist, state.album, state.playbackStatus].join('|');
}

type Subscriber = (state: MediaSessionUiState) => void;

let snapshot: MediaSessionUiState = { ...BROWSER_FALLBACK };
let lastIdentity: string | null = null;
const subscribers = new Set<Subscriber>();
let listenGeneration = 0;
let unlistenFn: (() => void) | undefined;
let connecting = false;

function publish(next: MediaSessionUiState): void {
  snapshot = next;
  const identity = mediaIdentity(next);
  if (lastIdentity !== identity) {
    lastIdentity = identity;
    trace(
      'media',
      'session',
      `Now playing: ${[next.artist, next.title].filter(Boolean).join(' — ') || '(none)'} [${next.playbackStatus}]`,
      {
        title: next.title,
        artist: next.artist,
        album: next.album,
        sourceApp: next.sourceApp,
        playbackStatus: next.playbackStatus,
        durationMs: next.durationMs,
      },
      next.playbackStatus === 'media_session_unavailable' ? 'fail' : 'info',
    );
  }
  subscribers.forEach((fn) => fn(next));
}

function stopListening(): void {
  listenGeneration += 1;
  connecting = false;
  unlistenFn?.();
  unlistenFn = undefined;
}

function startListening(): void {
  if (!isTauri()) {
    publish(BROWSER_FALLBACK);
    return;
  }
  if (connecting || unlistenFn) {
    return;
  }
  connecting = true;
  const generation = listenGeneration;
  void (async () => {
    try {
      const initial = await invoke<MediaSessionWire>('get_current_media');
      if (generation !== listenGeneration || subscribers.size === 0) {
        return;
      }
      publish(wireToUi(initial));

      const nextUnlisten = await listen<MediaSessionWire>('media-session-update', (event) => {
        if (generation !== listenGeneration) {
          return;
        }
        publish(wireToUi(event.payload));
      });
      if (generation !== listenGeneration || subscribers.size === 0) {
        nextUnlisten();
        connecting = false;
        return;
      }
      unlistenFn = nextUnlisten;
      connecting = false;
      trace('media', 'subscribed', 'Listening for media-session-update from Rust', undefined, 'ok');
    } catch (error) {
      connecting = false;
      const message = error instanceof Error ? error.message : String(error);
      trace(
        'media',
        'subscribe_fail',
        `Could not read the OS media session (${message})`,
        {
          why: 'invoke_or_listen_failed',
          error: message,
        },
        'fail',
      );
      if (generation === listenGeneration && subscribers.size > 0) {
        publish(BROWSER_FALLBACK);
      }
    }
  })();
}

function subscribe(listener: Subscriber): () => void {
  subscribers.add(listener);
  listener(snapshot);
  if (subscribers.size === 1) {
    if (isTauri() && snapshot.playbackStatus === 'media_session_unavailable') {
      publish(TAURI_EMPTY);
    }
    startListening();
  }
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) {
      stopListening();
      snapshot = { ...BROWSER_FALLBACK };
      lastIdentity = null;
    }
  };
}

/**
 * The OS now-playing session Live Jam and Play Along both read.
 * One Rust poller (`get_current_media` + `media-session-update`); one frontend subscription.
 */
export function useMediaSession(): MediaSessionUiState {
  const [state, setState] = useState<MediaSessionUiState>(() =>
    isTauri()
      ? snapshot.playbackStatus === 'media_session_unavailable'
        ? TAURI_EMPTY
        : snapshot
      : BROWSER_FALLBACK,
  );

  useEffect(() => {
    if (!isTauri()) {
      trace('media', 'unavailable', 'Not running inside Tauri — OS media session is unavailable', {
        why: 'not_tauri',
      }, 'skip');
      setState(BROWSER_FALLBACK);
      return;
    }
    return subscribe(setState);
  }, []);

  return state;
}
