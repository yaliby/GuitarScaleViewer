import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { DetectedKeyState } from './useDetectedKey';
import type { MediaSessionUiState } from './useMediaSession';
import { lookupSongKey, normalizeLookupKey, type KeyLookupSource } from '../services/songKeyApi';
import { buildLookupInputs } from '../services/trackIdentity';
import { trace } from '../services/debugLog';

type CloudState = 'idle' | 'hit' | 'miss';
type ResolutionState =
  | 'no_session'
  | 'paused'
  | 'cloud_hit'
  | 'cloud_miss_local_detecting'
  | 'local_detecting'
  | 'ready'
  | 'ambiguous';

type CloudHit = {
  key: string;
  mode: 'major' | 'minor';
  displayName: string;
  verified: boolean;
  source: KeyLookupSource;
  sourceLabel: string;
};

type CloudControlWire = {
  track_identity: string | null;
  state: CloudState;
  key: string | null;
  mode: string | null;
  error: string | null;
};

function isActiveSession(media: MediaSessionUiState): boolean {
  return !['none', 'closed', 'media_session_unavailable'].includes(media.playbackStatus);
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
    trace('cloud', 'control.sync', `Told Rust library state=${control.state}`, {
      trackIdentity: control.track_identity,
      state: control.state,
      key: control.key,
      mode: control.mode,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    trace('cloud', 'control.sync_fail', `Could not tell Rust the library state — local detector may keep running`, {
      state: control.state,
      why: 'invoke_failed',
      error: message,
    }, 'fail');
    console.warn('cloud control sync failed', error);
  }
}

/**
 * Looks the playing track up in the bundled verified library. No network.
 * A miss leaves the local engine as the only remaining leg.
 */
export function useCloudKeyResolution(media: MediaSessionUiState, detectedKey: DetectedKeyState) {
  const [cloudState, setCloudState] = useState<CloudState>('idle');
  const [resolutionState, setResolutionState] = useState<ResolutionState>('no_session');
  const [cloudHit, setCloudHit] = useState<CloudHit | null>(null);
  const activeTrackRef = useRef<string | null>(null);

  const { trackIdentity, title, artist, hasSession, playing, paused } = useMemo(
    () => buildLookupInputs(media),
    [media],
  );

  useEffect(() => {
    if (!hasSession) {
      activeTrackRef.current = null;
      setCloudState('idle');
      setCloudHit(null);
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

    const changedTrack = activeTrackRef.current !== trackIdentity;
    if (changedTrack) {
      activeTrackRef.current = trackIdentity;
      setCloudHit(null);
    }

    if (paused) {
      setResolutionState('paused');
      return;
    }

    if (!playing) {
      return;
    }

    if (!trackIdentity || !title || !artist) {
      setCloudState('miss');
      setCloudHit(null);
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

    const result = lookupSongKey({ title, artist });
    if (!result.found) {
      setCloudState('miss');
      setCloudHit(null);
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

    const parsed = normalizeLookupKey(result.song);
    if (!parsed) {
      setCloudState('miss');
      setCloudHit(null);
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

    const hit: CloudHit = {
      key: parsed.key,
      mode: parsed.mode,
      displayName: `${parsed.key} ${parsed.mode}`,
      verified: true,
      source: result.song.source,
      sourceLabel: result.song.sourceLabel,
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
  }, [artist, hasSession, paused, playing, title, trackIdentity]);

  useEffect(() => {
    if (!isActiveSession(media)) {
      setResolutionState('no_session');
      return;
    }
    if (paused) {
      setResolutionState('paused');
      return;
    }
    if (cloudState === 'hit') {
      setResolutionState('cloud_hit');
      return;
    }
    if (cloudState === 'miss') {
      if (detectedKey.primaryKey && detectedKey.primaryScale) {
        setResolutionState(detectedKey.ambiguous ? 'ambiguous' : 'ready');
      } else {
        setResolutionState('cloud_miss_local_detecting');
      }
    }
  }, [
    cloudState,
    detectedKey.ambiguous,
    detectedKey.primaryKey,
    detectedKey.primaryScale,
    media.playbackStatus,
    paused,
  ]);

  const source = useMemo<'cloud_verified' | 'local_detected' | 'none'>(() => {
    if (cloudState === 'hit' && cloudHit?.verified) {
      return 'cloud_verified';
    }
    if (detectedKey.primaryKey && detectedKey.primaryScale) {
      return 'local_detected';
    }
    return 'none';
  }, [cloudState, cloudHit, detectedKey.primaryKey, detectedKey.primaryScale]);

  const sourceBadge = useMemo(() => {
    if (source === 'cloud_verified') {
      return 'Verified library key';
    }
    if (source === 'local_detected') {
      return 'Local audio detection';
    }
    return 'No key yet';
  }, [source]);

  return {
    cloudState,
    cloudError: null as string | null,
    cloudHit: activeTrackRef.current === trackIdentity ? cloudHit : null,
    resolutionState,
    source,
    sourceBadge,
    trackIdentity,
  };
}
