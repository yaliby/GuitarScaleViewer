import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { analyzedCaptureIds } from '../harmonia/analyzedCaptures';
import { trace } from '../services/debugLog';
import {
  captureTrack,
  engineLabel,
  lookupTrackCapture,
  type CapturedTrack,
  type CaptureQuery,
  type CaptureStatus,
} from '../services/trackCapture';
import type { MediaSessionUiState } from './useMediaSession';

const AUTO_KEY = 'gsv.autoCapture';

export type TrackCaptureState = {
  status: CaptureStatus;
  progressPct: number | null;
  stage: string | null;
  track: CapturedTrack | null;
  error: string | null;
  query: string;
  autoEnabled: boolean;
  playing: boolean;
};

const INITIAL: TrackCaptureState = {
  status: 'idle',
  progressPct: null,
  stage: null,
  track: null,
  error: null,
  query: '',
  autoEnabled: true,
  playing: false,
};

type Subscriber = (state: TrackCaptureState) => void;

let snapshot: TrackCaptureState = { ...INITIAL };
const subscribers = new Set<Subscriber>();
let listenGeneration = 0;
let unlistenProgress: (() => void) | undefined;
let inflight: Promise<void> | null = null;
let lastLookupKey = '';
let lastAutoKey = '';
let autoTimer: ReturnType<typeof setTimeout> | null = null;
let audioEl: HTMLAudioElement | null = null;

function readAutoEnabled(): boolean {
  try {
    const raw = localStorage.getItem(AUTO_KEY);
    if (raw === '0' || raw === 'false') return false;
    if (raw === '1' || raw === 'true') return true;
  } catch {
    /* ignore */
  }
  return true;
}

function publish(patch: Partial<TrackCaptureState>): void {
  snapshot = { ...snapshot, ...patch };
  subscribers.forEach((fn) => fn(snapshot));
}

function mediaKey(media: MediaSessionUiState): string {
  return [
    media.trackUrl || '',
    media.sourceApp || '',
    media.title || '',
    media.artist || '',
    media.album || '',
  ].join('\0');
}

function queryFromMedia(media: MediaSessionUiState, pasted: string): CaptureQuery {
  return {
    query: pasted.trim() || null,
    title: media.title,
    artist: media.artist,
    album: media.album,
    sourceApp: media.sourceApp,
    trackUrl: media.trackUrl,
  };
}

function scheduleChordAnalysis(track: CapturedTrack): void {
  if (!isTauri() || analyzedCaptureIds().has(track.id)) return;
  void import('../harmonia/backgroundChords')
    .then((mod) => mod.enqueueChordAnalysis(track))
    .catch((error: unknown) => {
      trace(
        'harmonia',
        'chords.fail',
        'Could not start background chord extraction',
        { error: error instanceof Error ? error.message : String(error) },
        'fail',
      );
    });
}

function ensureAudio(): HTMLAudioElement {
  if (!audioEl) {
    audioEl = new Audio();
    audioEl.preload = 'metadata';
    audioEl.addEventListener('ended', () => publish({ playing: false }));
    audioEl.addEventListener('pause', () => {
      if (audioEl && !audioEl.ended) publish({ playing: false });
    });
    audioEl.addEventListener('play', () => publish({ playing: true }));
  }
  return audioEl;
}

function attachTrack(track: CapturedTrack | null): void {
  const player = ensureAudio();
  if (!track) {
    player.pause();
    player.removeAttribute('src');
    publish({ playing: false });
    return;
  }
  if (player.src !== track.audioUrl) {
    player.src = track.audioUrl;
  }
}

async function runCapture(query: CaptureQuery, reason: string): Promise<void> {
  if (inflight) return inflight;
  publish({
    status: 'capturing',
    progressPct: 1,
    stage: 'start',
    error: null,
  });
  trace('capture', 'start', `Capturing ${query.title || query.query || 'track'} (${reason})`, query);
  const job = (async () => {
    const result = await captureTrack(query);
    if (result.status === 'ready' && result.track) {
      attachTrack(result.track);
      publish({
        status: 'ready',
        progressPct: 100,
        stage: 'done',
        track: result.track,
        error: null,
      });
      trace(
        'capture',
        'ready',
        `${result.track.cached ? 'Cache hit' : 'Saved'} via ${engineLabel(result.track.engine)}`,
        { id: result.track.id, engine: result.track.engine, cached: result.track.cached },
        'ok',
      );
      scheduleChordAnalysis(result.track);
      return;
    }
    const message = result.message || result.reason || 'Capture failed';
    publish({
      status: 'error',
      progressPct: null,
      stage: null,
      error: message,
    });
    trace('capture', 'fail', message, { reason: result.reason }, 'fail');
  })().finally(() => {
    inflight = null;
  });
  inflight = job;
  return job;
}

function startProgressListener(): void {
  if (!isTauri() || unlistenProgress) return;
  const generation = ++listenGeneration;
  void listen<{ status?: string; progress?: number; stage?: string }>(
    'track-capture-progress',
    (event) => {
      if (generation !== listenGeneration) return;
      const progress = event.payload.progress;
      if (typeof progress !== 'number') return;
      publish({
        status: snapshot.status === 'ready' ? 'ready' : 'capturing',
        progressPct: progress,
        stage: event.payload.stage ?? snapshot.stage,
      });
    },
  ).then((unlisten) => {
    if (generation !== listenGeneration) {
      unlisten();
      return;
    }
    unlistenProgress = unlisten;
  });
}

function stopProgressListener(): void {
  listenGeneration += 1;
  unlistenProgress?.();
  unlistenProgress = undefined;
}

async function lookupFor(media: MediaSessionUiState, pasted: string): Promise<void> {
  const key = `${mediaKey(media)}\0${pasted.trim()}`;
  if (!media.title && !pasted.trim() && !media.trackUrl) {
    lastLookupKey = key;
    if (snapshot.track) {
      attachTrack(null);
      publish({ status: 'idle', track: null, error: null, progressPct: null });
    }
    return;
  }
  if (key === lastLookupKey) return;
  lastLookupKey = key;
  const result = await lookupTrackCapture(queryFromMedia(media, pasted));
  if (key !== lastLookupKey) return;
  if (result.status === 'ready' && result.track) {
    attachTrack(result.track);
    publish({
      status: 'ready',
      track: result.track,
      error: null,
      progressPct: 100,
      stage: 'cache',
    });
    lastAutoKey = key;
    scheduleChordAnalysis(result.track);
    return;
  }
  if (snapshot.track && snapshot.status === 'ready') {
    attachTrack(null);
  }
  publish({
    status: result.status === 'error' ? 'error' : 'idle',
    track: null,
    error: result.status === 'error' ? result.message || result.reason : null,
    progressPct: null,
    stage: null,
  });
}

export function canAutoCaptureMedia(media: MediaSessionUiState): boolean {
  // Saving uses the song identity, not the playback clock. Windows can expose a
  // titled Chrome session as paused; only lyric following needs a running clock.
  return (
    (media.playbackStatus === 'playing' ||
      media.playbackStatus === 'opened' ||
      media.playbackStatus === 'paused') &&
    Boolean(media.title || media.trackUrl)
  );
}

function maybeAutoCapture(media: MediaSessionUiState): void {
  if (!snapshot.autoEnabled || !isTauri() || !canAutoCaptureMedia(media)) {
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = null;
    return;
  }
  const key = mediaKey(media);
  if (key === lastAutoKey) return;
  if (snapshot.status === 'capturing') return;
  if (autoTimer) clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    autoTimer = null;
    if (!snapshot.autoEnabled || snapshot.status === 'capturing') return;
    lastAutoKey = key;
    void runCapture(queryFromMedia(media, ''), 'auto');
  }, 900);
}

export type TrackCaptureApi = TrackCaptureState & {
  setQuery: (value: string) => void;
  setAutoEnabled: (value: boolean) => void;
  captureNow: () => void;
  captureQuery: () => void;
  togglePlayback: () => void;
};

function subscribe(listener: Subscriber): () => void {
  subscribers.add(listener);
  listener(snapshot);
  if (subscribers.size === 1) {
    snapshot = { ...snapshot, autoEnabled: readAutoEnabled() };
    startProgressListener();
  }
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) {
      stopProgressListener();
    }
  };
}

/**
 * Shared capture store: Explore, Live Jam and the Library all see the same file.
 */
export function useTrackCapture(media: MediaSessionUiState): TrackCaptureApi {
  const [state, setState] = useState<TrackCaptureState>(snapshot);

  useEffect(() => subscribe(setState), []);

  useEffect(() => {
    void lookupFor(media, snapshot.query).then(() => maybeAutoCapture(media));
  }, [media.title, media.artist, media.album, media.sourceApp, media.trackUrl, media.playbackStatus]);

  return {
    ...state,
    setQuery: (value) => publish({ query: value }),
    setAutoEnabled: (value) => {
      try {
        localStorage.setItem(AUTO_KEY, value ? '1' : '0');
      } catch {
        /* ignore */
      }
      lastAutoKey = '';
      publish({ autoEnabled: value });
      if (value) maybeAutoCapture(media);
    },
    captureNow: () => {
      void runCapture(queryFromMedia(media, snapshot.query), 'now-playing');
    },
    captureQuery: () => {
      void runCapture(queryFromMedia(media, snapshot.query), 'query');
    },
    togglePlayback: () => {
      const player = ensureAudio();
      if (!snapshot.track) return;
      if (player.paused) {
        void player.play().catch((error: unknown) => {
          publish({
            error: error instanceof Error ? error.message : String(error),
          });
        });
      } else {
        player.pause();
      }
    },
  };
}

export function resetTrackCaptureForTests(): void {
  lastLookupKey = '';
  lastAutoKey = '';
  inflight = null;
  if (autoTimer) {
    clearTimeout(autoTimer);
    autoTimer = null;
  }
  if (audioEl) {
    audioEl.pause();
    audioEl.removeAttribute('src');
    audioEl = null;
  }
  snapshot = { ...INITIAL, autoEnabled: readAutoEnabled() };
  subscribers.forEach((fn) => fn(snapshot));
}
