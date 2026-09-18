import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { DetectedKeyState } from './useDetectedKey';
import type { MediaSessionUiState } from './useMediaSession';
import {
  lookupSongKey,
  normalizeLookupKey,
  submitSongKeySuggestion,
  type KeyLookupSource,
  type LookupSongResult,
} from '../services/songKeyApi';
import { buildLookupInputs } from '../services/trackIdentity';
import { trace } from '../services/debugLog';

type CloudState = 'idle' | 'lookup_pending' | 'hit' | 'miss' | 'error';
type ResolutionState =
  | 'no_session'
  | 'paused'
  | 'cloud_lookup'
  | 'cloud_hit'
  | 'catalog_hit'
  | 'cloud_miss_local_detecting'
  | 'local_detecting'
  | 'ready'
  | 'ambiguous'
  | 'error';

type CloudHit = {
  key: string;
  mode: 'major' | 'minor';
  displayName: string;
  verified: boolean;
  source: KeyLookupSource;
  sourceLabel: string;
};

type CacheEntry =
  | {
      state: 'hit';
      expiresAt: number;
      key: string;
      mode: 'major' | 'minor';
      verified: boolean;
      source: KeyLookupSource;
      sourceLabel: string;
    }
  | { state: 'miss'; expiresAt: number };

type CloudControlWire = {
  track_identity: string | null;
  state: CloudState;
  key: string | null;
  mode: string | null;
  error: string | null;
};

type SuggestionStatus = 'idle' | 'submitting' | 'success' | 'error';

/**
 * A throttled or unreachable catalog is not an answer about the track. The lookup is retried
 * in place while the same track is still on, because the effect only re-runs when the track
 * changes — without this, one 429 leaves the song keyless for as long as it plays.
 */
const TRANSIENT_RETRY_DELAYS_MS = [3_000, 8_000];

function wasIncomplete(result: LookupSongResult): boolean {
  return !result.found && result.incomplete === true;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function lookupWithTransientRetries(
  input: { title: string; artist: string },
  signal: AbortSignal,
): Promise<LookupSongResult> {
  let result = await lookupSongKey(input, signal);
  for (const ms of TRANSIENT_RETRY_DELAYS_MS) {
    if (!wasIncomplete(result)) {
      return result;
    }
    trace('cloud', 'lookup.retry', `Catalogs never answered — retrying in ${ms}ms`, {
      ...input,
      inMs: ms,
      why: 'incomplete',
    }, 'decide');
    await delay(ms, signal);
    result = await lookupSongKey(input, signal);
  }
  return result;
}

let loggedNotTauriControl = false;

async function syncCloudControl(control: CloudControlWire): Promise<void> {
  if (!isTauri()) {
    if (!loggedNotTauriControl) {
      loggedNotTauriControl = true;
      trace('cloud', 'control.skip', 'Not running inside Tauri — Rust will not pause the local detector', {
        state: control.state,
        why: 'not_tauri',
      }, 'skip');
    }
    return;
  }
  try {
    await invoke<boolean>('set_cloud_resolution', { control });
    trace('cloud', 'control.sync', `Told Rust cloud state=${control.state}`, {
      trackIdentity: control.track_identity,
      state: control.state,
      key: control.key,
      mode: control.mode,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    trace('cloud', 'control.sync_fail', `Could not tell Rust the cloud state — local detector may keep running`, {
      state: control.state,
      why: 'invoke_failed',
      error: message,
    }, 'fail');
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

  const { trackIdentity, title, artist, hasSession, playing, paused } = useMemo(
    () => buildLookupInputs(media),
    [media],
  );

  useEffect(() => {
    const now = Date.now();
    for (const [k, v] of cacheRef.current.entries()) {
      if (v.expiresAt <= now) {
        cacheRef.current.delete(k);
      }
    }
  }, [trackIdentity]);

  useEffect(() => {
    if (!hasSession) {
      trace('cloud', 'session.none', 'No media session from the OS — lookup and local detection stay idle', {
        why: 'no_session',
      }, 'skip');
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
      trace('cloud', 'session.paused', 'Playback is paused/stopped — holding the last key, not starting a new lookup', {
        trackIdentity,
        title,
        artist,
        why: 'paused',
      }, 'skip');
      setResolutionState('paused');
      return;
    }

    if (!playing) {
      trace('cloud', 'session.not_playing', `Playback status is not 'playing' — waiting`, {
        trackIdentity,
        why: 'not_playing',
      }, 'skip');
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
      trace('cloud', 'track.changed', 'Track identity changed — aborting any in-flight lookup so it cannot cache a miss for the previous song', {
        trackIdentity,
        title,
        artist,
        why: 'identity_changed',
      }, 'decide');
    }

    if (!trackIdentity || !title || !artist) {
      trace('cloud', 'lookup.skip', 'Session is playing but title or artist is empty — local detector only', {
        trackIdentity,
        title,
        artist,
        why: 'missing_metadata',
      }, 'skip');
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
          verified: cached.verified,
          source: cached.source,
          sourceLabel: cached.sourceLabel,
        };
        setCloudState('hit');
        setCloudHit(hit);
        setResolutionState(cached.verified ? 'cloud_hit' : 'catalog_hit');
        void syncCloudControl({
          track_identity: trackIdentity,
          state: 'hit',
          key: hit.key,
          mode: hit.mode,
          error: null,
        });
        trace('cloud', 'cache.hit', `Using cached ${cached.key} ${cached.mode} (${cached.verified ? 'verified' : cached.sourceLabel})`, {
          trackIdentity,
          key: cached.key,
          mode: cached.mode,
          verified: cached.verified,
          source: cached.source,
          why: 'memory_cache',
        }, 'ok');
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
        trace('cloud', 'cache.miss', 'Cached miss for this track — skipping catalogs, local detector runs', {
          trackIdentity,
          why: 'cached_miss',
        }, 'skip');
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
    trace('cloud', 'lookup.begin', `Starting cloud lookup for "${title}" — ${artist}`, {
      trackIdentity,
      title,
      artist,
      requestId,
    }, 'start');

    void (async () => {
      try {
        const result = await lookupWithTransientRetries({ title, artist }, ac.signal);
        // An aborted lookup can still resolve: the catalog leg swallows its own fetch errors.
        // Caching that as a miss would pin a wrong answer on the track for the next 5 minutes.
        if (ac.signal.aborted || requestRef.current !== requestId || activeTrackRef.current !== trackIdentity) {
          trace('cloud', 'lookup.stale', 'Ignoring a late lookup result — the track or request has already moved on', {
            trackIdentity,
            requestId,
            why: 'stale_or_aborted',
          }, 'skip');
          return;
        }
        if (result.found) {
          // Upper-casing the stored key would turn "Bb" into "BB" and leave the board stuck on
          // the previous root; normalise it, and treat an unreadable key as a miss.
          const parsed = normalizeLookupKey(result.song);
          if (!parsed) {
            trace('cloud', 'lookup.unparsable', 'Lookup returned a key that cannot be read — treating as a miss so the local detector can run', {
              trackIdentity,
              musical_key: result.song.musical_key,
              mode: result.song.mode,
              source: result.song.source,
              why: 'unparsable_key',
            }, 'fail');
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
            return;
          }
          const { key, mode } = parsed;
          cacheRef.current.set(trackIdentity, {
            state: 'hit',
            key,
            mode,
            verified: result.song.verified,
            source: result.song.source,
            sourceLabel: result.song.sourceLabel,
            expiresAt: Date.now() + 30 * 60_000,
          });
          const hit: CloudHit = {
            key,
            mode,
            displayName: `${key} ${mode}`,
            verified: result.song.verified,
            source: result.song.source,
            sourceLabel: result.song.sourceLabel,
          };
          setCloudState('hit');
          setCloudHit(hit);
          setCloudError(null);
          setResolutionState(result.song.verified ? 'cloud_hit' : 'catalog_hit');
          void syncCloudControl({
            track_identity: trackIdentity,
            state: 'hit',
            key,
            mode,
            error: null,
          });
          trace('cloud', 'lookup.hit', `Lookup hit: ${key} ${mode} from ${result.song.sourceLabel}${result.song.verified ? ' (verified)' : ''}`, {
            trackIdentity,
            key,
            mode,
            source: result.song.source,
            verified: result.song.verified,
            why: result.song.verified ? 'verified_db' : 'catalog',
          }, 'ok');
        } else {
          // Only a real "the catalogs know this song and it has no key" is worth caching.
          // Caching an unanswered lookup would pin the track as keyless for five minutes.
          if (!wasIncomplete(result)) {
            cacheRef.current.set(trackIdentity, {
              state: 'miss',
              expiresAt: Date.now() + 5 * 60_000,
            });
          } else {
            trace('cloud', 'lookup.incomplete', 'Catalogs still unreachable — not caching a miss, so the next play can retry', {
              trackIdentity,
              why: 'incomplete_not_cached',
            }, 'fail');
          }
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
          trace('cloud', 'lookup.miss', 'No catalog key — handing off to the local detector', {
            trackIdentity,
            why: 'complete_miss',
          }, 'skip');
        }
      } catch (error) {
        if (ac.signal.aborted) {
          return;
        }
        if (requestRef.current !== requestId || activeTrackRef.current !== trackIdentity) {
          trace('cloud', 'lookup.stale_error', 'Ignoring a late lookup error — the track or request has already moved on', {
            trackIdentity,
            why: 'stale_error',
          }, 'skip');
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
        trace('cloud', 'lookup.error', `Lookup threw (${message}) — falling back to local detection`, {
          trackIdentity,
          error: message,
          why: 'exception',
        }, 'fail');
        console.warn('key_resolution: cloud lookup error, fallback to local', message);
      }
    })();

    return () => {
      ac.abort();
    };
  }, [artist, hasSession, paused, playing, title, trackIdentity]);

  useEffect(() => {
    if (cloudState === 'hit') {
      setResolutionState(cloudHit?.verified ? 'cloud_hit' : 'catalog_hit');
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
  }, [cloudHit?.verified, cloudState, detectedKey.ambiguous, detectedKey.primaryKey, detectedKey.primaryScale]);

  const source = useMemo<'cloud_verified' | 'catalog' | 'local_detected' | 'none'>(() => {
    if (cloudState === 'hit' && cloudHit) {
      return cloudHit.verified ? 'cloud_verified' : 'catalog';
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
    if (source === 'catalog' && cloudHit) {
      return `Catalog key (${cloudHit.sourceLabel})`;
    }
    if (source === 'local_detected') {
      return 'Local audio detection';
    }
    return 'No key yet';
  }, [source, cloudHit]);

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
        trace('cloud', 'suggest.ok', 'User suggestion submitted', { title, artist, key, mode }, 'ok');
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

