import { invoke, isTauri } from '@tauri-apps/api/core';
import { trace } from '../services/debugLog';
import type { MediaSessionUiState } from './useMediaSession';

type MediaSessionWire = {
  title: string | null;
  artist: string | null;
  album: string | null;
  source_app: string | null;
  playback_status: string;
  position_ms: number | null;
  duration_ms: number | null;
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

export type MediaPlaybackAction = 'play' | 'pause' | 'toggle';

let queuedSeekMs: number | null = null;
let seekFlight: Promise<MediaSessionUiState | null> | null = null;

async function invokeTransport(
  command: 'control_media_playback' | 'seek_media',
  args: Record<string, unknown>,
  okEvent: string,
  okMessage: string,
): Promise<MediaSessionUiState | null> {
  if (!isTauri()) {
    return null;
  }
  try {
    const wire = await invoke<MediaSessionWire>(command, args);
    const next = wireToUi(wire);
    trace('media', okEvent, okMessage, {
      playbackStatus: next.playbackStatus,
      positionMs: next.positionMs,
    });
    return next;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    trace(
      'media',
      `${command}.fail`,
      `Could not ${okEvent.replace('.', ' ')} (${message})`,
      { why: 'invoke_failed', error: message, args },
      'fail',
    );
    return null;
  }
}

/** Pause, play or toggle the current OS media session (GSMTC on Windows, MPRIS on Linux). */
export function controlMediaPlayback(action: MediaPlaybackAction): Promise<MediaSessionUiState | null> {
  return invokeTransport(
    'control_media_playback',
    { action },
    `control.${action}`,
    action === 'pause' ? 'Asked the OS player to pause' : action === 'play' ? 'Asked the OS player to play' : 'Toggled the OS player',
  );
}

async function flushSeek(): Promise<MediaSessionUiState | null> {
  let last: MediaSessionUiState | null = null;
  try {
    while (queuedSeekMs != null) {
      const next = queuedSeekMs;
      queuedSeekMs = null;
      last = await invokeTransport(
        'seek_media',
        { positionMs: next },
        'control.seek',
        `Asked the OS player to seek to ${next}ms`,
      );
    }
  } finally {
    seekFlight = null;
    if (queuedSeekMs != null && isTauri()) {
      seekFlight = flushSeek();
      last = await seekFlight;
    }
  }
  return last;
}

/** Seek the current OS media session to an absolute position. */
export function seekMedia(positionMs: number): Promise<MediaSessionUiState | null> {
  const clamped = Math.max(0, Math.round(positionMs));
  if (!isTauri()) {
    return Promise.resolve(null);
  }
  queuedSeekMs = clamped;
  if (!seekFlight) {
    seekFlight = flushSeek();
  }
  return seekFlight;
}
