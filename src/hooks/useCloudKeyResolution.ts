import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { DetectedKeyState } from './useDetectedKey';
import type { MediaSessionUiState } from './useMediaSession';
import { lookupSongKey, submitSongKeySuggestion } from '../services/songKeyApi';
import { buildTrackIdentity } from '../services/trackIdentity';

type CloudState = 'idle' | 'lookup_pending' | 'hit' | 'miss' | 'error';
type ResolutionState =
  | 'no_session'
  | 'paused'
  | 'cloud_lookup'
  | 'cloud_hit'
  | 'cloud_miss_local_detecting'
  | 'local_detecting'
  | 'ready'
  | 'ambiguous'
  | 'error';

type CloudHit = {
  key: string;
  mode: 'major' | 'minor';
  displayName: string;
};

type CacheEntry =
  | { state: 'hit'; expiresAt: number; key: string; mode: 'major' | 'minor' }
  | { state: 'miss'; expiresAt: number };

type CloudControlWire = {
  track_identity: string | null;
  state: CloudState;
  key: string | null;
  mode: string | null;
  error: string | null;
};

type SuggestionStatus = 'idle' | 'submitting' | 'success' | 'error';

function isActiveSession(media: MediaSessionUiState): boolean {
  return media.playbackStatus !== 'none' && media.playbackStatus !== 'media_session_unavailable';
}

function isPlaying(media: MediaSessionUiState): boolean {
  return media.playbackStatus === 'playing';
}

function isPausedOrStopped(media: MediaSessionUiState): boolean {
  return ['paused', 'stopped', 'closed', 'opened', 'changing'].includes(media.playbackStatus);
}

async function syncCloudControl(control: CloudControlWire): Promise<void> {
  if (!isTauri()) {
    return;
  }
  try {
    await invoke<boolean>('set_cloud_resolution', { control });
  } catch (error) {
    console.warn('cloud control sync failed', error);
  }
}

export function useCloudKeyResolution(media: MediaSessionUiState, detectedKey: DetectedKeyState) {
  const [cloudState, setCloudState] = useState<CloudState>('idle');
  const [resolutionState, setResolutionState] = useState<ResolutionState>('no_session');
  const [cloudHit, setCloudHit] = useState<CloudHit | null>(null);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [suggestionStatus, setSuggestionStatus] = useState<SuggestionStatus>('idle');
  const [suggestionMessage, setSuggestionMessage] = useState<string | null>(null);

  const cacheRef = useRef<Map<string, CacheEntry>>(new Map());
  const requestRef = useRef<number>(0);
  const abortRef = useRef<AbortController | null>(null);
  const activeTrackRef = useRef<string | null>(null);

  const trackIdentity = useMemo(() => buildTrackIdentity(media), [media]);

  useEffect(() => {
    const now = Date.now();
    for (const [k, v] of cacheRef.current.entries()) {
      if (v.expiresAt <= now) {
        cacheRef.current.delete(k);
      }
    }
  }, [trackIdentity]);

  useEffect(() => {
    const hasSession = isActiveSession(media);
    const playing = isPlaying(media);
    const paused = isPausedOrStopped(media);
    const title = media.title?.trim() ?? '';
    const artist = media.artist?.trim() ?? '';

    if (!hasSession) {
      activeTrackRef.current = null;
      abortRef.current?.abort();
      setCloudState('idle');
      setCloudHit(null);
      setCloudError(null);
      setResolutionState('no_session');
      void syncCloudControl({
        track_identity: null,
        state: 'idle',
        key: null,
        mode: null,
        error: null,
      });
      return;
    }

    if (paused) {
      setResolutionState('paused');
      return;
    }

    if (!playing) {
      return;
    }

    const changedTrack = activeTrackRef.current !== trackIdentity;
    if (changedTrack) {
      abortRef.current?.abort();
      activeTrackRef.current = trackIdentity;
      setCloudHit(null);
      setCloudError(null);
      setSuggestionStatus('idle');
      setSuggestionMessage(null);
      console.info('key_resolution: track identity changed', trackIdentity);
    }

    if (!trackIdentity || !title || !artist) {
      setCloudState('miss');
      setResolutionState('cloud_miss_local_detecting');
      void syncCloudControl({
        track_identity: trackIdentity,
        state: 'miss',
        key: null,
        mode: null,
        error: null,
      });
      return;
    }

    const cached = cacheRef.current.get(trackIdentity);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.state === 'hit') {
        const hit: CloudHit = {
          key: cached.key,
          mode: cached.mode,
          displayName: `${cached.key} ${cached.mode}`,
        };
        setCloudState('hit');
        setCloudHit(hit);
        setResolutionState('cloud_hit');
        void syncCloudControl({
          track_identity: trackIdentity,
          state: 'hit',
          key: hit.key,
          mode: hit.mode,
          error: null,
        });
        console.info('key_resolution: cloud cache hit', trackIdentity);
      } else {
        setCloudState('miss');
        setResolutionState('cloud_miss_local_detecting');
        void syncCloudControl({
          track_identity: trackIdentity,
          state: 'miss',
          key: null,
          mode: null,
          error: null,
        });
        console.info('key_resolution: cloud cache miss', trackIdentity);
      }
      return;
    }

    requestRef.current += 1;
    const requestId = requestRef.current;
    const ac = new AbortController();
    abortRef.current = ac;
    setCloudState('lookup_pending');
    setResolutionState('cloud_lookup');
    void syncCloudControl({
      track_identity: trackIdentity,
      state: 'lookup_pending',
      key: null,
      mode: null,
      error: null,
    });
    console.info('key_resolution: cloud lookup started', { trackIdentity, title, artist });

    void (async () => {
      try {
        const result = await lookupSongKey({ title, artist }, ac.signal);
        if (requestRef.current !== requestId || activeTrackRef.current !== trackIdentity) {
          console.info('key_resolution: stale cloud response ignored', { trackIdentity });
          return;
        }
        if (result.found) {
          const mode = result.song.mode.toLowerCase() === 'major' ? 'major' : 'minor';
          const key = result.song.musical_key.toUpperCase();
          cacheRef.current.set(trackIdentity, {
            state: 'hit',
            key,
            mode,
            expiresAt: Date.now() + 30 * 60_000,
          });
          const hit: CloudHit = { key, mode, displayName: `${key} ${mode}` };
          setCloudState('hit');
          setCloudHit(hit);
          setCloudError(null);
          setResolutionState('cloud_hit');
          void syncCloudControl({
            track_identity: trackIdentity,
            state: 'hit',
            key,
            mode,
            error: null,
          });
          console.info('key_resolution: cloud lookup hit', { trackIdentity, key, mode });
        } else {
          cacheRef.current.set(trackIdentity, {
            state: 'miss',
            expiresAt: Date.now() + 5 * 60_000,
          });
          setCloudState('miss');
          setCloudHit(null);
          setCloudError(null);
          setResolutionState('cloud_miss_local_detecting');
          void syncCloudControl({
            track_identity: trackIdentity,
            state: 'miss',
            key: null,
            mode: null,
            error: null,
          });
          console.info('key_resolution: cloud lookup miss', { trackIdentity });
        }
      } catch (error) {
        if (ac.signal.aborted) {
          return;
        }
        if (requestRef.current !== requestId || activeTrackRef.current !== trackIdentity) {
          console.info('key_resolution: stale cloud error ignored', { trackIdentity });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setCloudState('error');
        setCloudHit(null);
        setCloudError(message);
        setResolutionState('local_detecting');
        void syncCloudControl({
          track_identity: trackIdentity,
          state: 'error',
          key: null,
          mode: null,
          error: message,
        });
        console.warn('key_resolution: cloud lookup error, fallback to local', message);
      }
    })();

    return () => {
      ac.abort();
    };
  }, [media, trackIdentity]);

  useEffect(() => {
    if (cloudState === 'hit') {
      setResolutionState('cloud_hit');
      return;
    }
    if (cloudState === 'lookup_pending') {
      setResolutionState('cloud_lookup');
      return;
    }
    if (cloudState === 'miss' || cloudState === 'error') {
      if (detectedKey.primaryKey && detectedKey.primaryScale) {
        setResolutionState(detectedKey.ambiguous ? 'ambiguous' : 'ready');
      } else {
        setResolutionState(cloudState === 'miss' ? 'cloud_miss_local_detecting' : 'local_detecting');
      }
    }
  }, [cloudState, detectedKey.ambiguous, detectedKey.primaryKey, detectedKey.primaryScale]);

  const source = useMemo<'cloud_verified' | 'local_detected' | 'none'>(() => {
    if (cloudState === 'hit' && cloudHit) {
      return 'cloud_verified';
    }
    if (detectedKey.primaryKey && detectedKey.primaryScale) {
      return 'local_detected';
    }
    return 'none';
  }, [cloudState, cloudHit, detectedKey.primaryKey, detectedKey.primaryScale]);

  const sourceBadge = useMemo(() => {
    if (source === 'cloud_verified') {
      return 'Verified cloud key';
    }
    if (source === 'local_detected') {
      return 'Local audio detection';
    }
    return 'No key yet';
  }, [source]);

  const submitSuggestion = useCallback(
    async (key: string, mode: 'major' | 'minor') => {
      const title = media.title?.trim() ?? '';
      const artist = media.artist?.trim() ?? '';
      if (!title || !artist) {
        setSuggestionStatus('error');
        setSuggestionMessage('Cannot submit suggestion without title and artist.');
        return;
      }
      try {
        setSuggestionStatus('submitting');
        setSuggestionMessage(null);
        await submitSongKeySuggestion({ title, artist, key, mode, user: 'anonymous' });
        setSuggestionStatus('success');
        setSuggestionMessage('Suggestion submitted (pending review).');
        console.info('key_resolution: suggestion submitted', { title, artist, key, mode });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setSuggestionStatus('error');
        setSuggestionMessage(`Suggestion failed: ${message}`);
        console.warn('key_resolution: suggestion submit failed', message);
      }
    },
    [media.artist, media.title],
  );

  return {
    cloudState,
    cloudError,
    cloudHit,
    resolutionState,
    source,
    sourceBadge,
    trackIdentity,
    suggestionStatus,
    suggestionMessage,
    submitSuggestion,
  };
}

