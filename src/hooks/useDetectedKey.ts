import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { trace } from '../services/debugLog';

export type CaptureMode = 'process_loopback' | 'endpoint_loopback' | 'unavailable';
export type DetectionState =
  | 'warming_up'
  | 'listening'
  | 'likely_key'
  | 'ambiguous'
  | 'paused_hold'
  | 'unavailable';

export type KeyAlternative = {
  key: string;
  scale: string;
  displayName: string;
  confidence: number;
};

export type DetectedKeyState = {
  primaryKey: string | null;
  primaryScale: string | null;
  displayName: string | null;
  confidence: number;
  stability: number;
  alternatives: KeyAlternative[];
  source: string;
  captureMode: CaptureMode;
  targetApp: string | null;
  enoughAudio: boolean;
  bufferSeconds: number;
  windowCount: number;
  ambiguous: boolean;
  reason: string | null;
  state: DetectionState;
  readyToApply: boolean;
};

export type AbEngineResult = {
  backend: string;
  key: string | null;
  scale: string | null;
  displayName: string | null;
  share: number;
  windowCount: number;
  latencyMs: number;
  error: string | null;
};

export type DetectedKeyAbState = {
  current: AbEngineResult;
  libkeyfinder: AbEngineResult;
};

const FALLBACK: DetectedKeyState = {
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
  reason: 'not_running_in_tauri',
  state: 'unavailable',
  readyToApply: false,
};

function detectedIdentity(state: DetectedKeyState): string {
  return [
    state.primaryKey,
    state.primaryScale,
    state.state,
    state.reason,
    state.captureMode,
    state.ambiguous,
    state.enoughAudio,
    state.readyToApply,
    Math.round(state.confidence * 20) / 20,
  ].join('|');
}

export function useDetectedKey() {
  const [state, setState] = useState<DetectedKeyState>(FALLBACK);
  const [abState, setAbState] = useState<DetectedKeyAbState | null>(null);
  const lastIdentityRef = useRef<string | null>(null);

  const apply = (next: DetectedKeyState) => {
    const identity = detectedIdentity(next);
    if (lastIdentityRef.current !== identity) {
      lastIdentityRef.current = identity;
      const level = next.state === 'unavailable' ? 'fail' : next.ambiguous ? 'skip' : next.primaryKey ? 'ok' : 'info';
      trace(
        'detect',
        'payload',
        next.displayName
          ? `Local detector: ${next.displayName} (${next.state}, ${Math.round(next.confidence * 100)}%)${next.ambiguous ? ' ambiguous' : ''}`
          : `Local detector: ${next.state}${next.reason ? ` — ${next.reason}` : ''}`,
        {
          key: next.primaryKey,
          scale: next.primaryScale,
          state: next.state,
          reason: next.reason,
          captureMode: next.captureMode,
          targetApp: next.targetApp,
          confidence: next.confidence,
          stability: next.stability,
          windowCount: next.windowCount,
          bufferSeconds: next.bufferSeconds,
          enoughAudio: next.enoughAudio,
          ambiguous: next.ambiguous,
          readyToApply: next.readyToApply,
        },
        level,
      );
    }
    setState(next);
  };

  useEffect(() => {
    if (!isTauri()) {
      trace('detect', 'unavailable', 'Not running inside Tauri — local audio detection is off', {
        why: 'not_tauri',
      }, 'skip');
      setState(FALLBACK);
      setAbState(null);
      return;
    }

    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let unlistenAb: (() => void) | undefined;

    void (async () => {
      try {
        const initial = await invoke<DetectedKeyState>('get_detected_key');
        if (!cancelled) {
          apply(initial);
        }

        unlisten = await listen<DetectedKeyState>('detected-key-update', (event) => {
          if (!cancelled) {
            apply(event.payload);
          }
        });

        unlistenAb = await listen<DetectedKeyAbState>('detected-key-ab-update', (event) => {
          if (!cancelled) {
            setAbState(event.payload);
          }
        });
        trace('detect', 'subscribed', 'Listening for detected-key-update from Rust', undefined, 'ok');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        trace('detect', 'subscribe_fail', `Could not subscribe to the local detector (${message})`, {
          why: 'invoke_or_listen_failed',
          error: message,
        }, 'fail');
        if (!cancelled) {
          setState(FALLBACK);
          setAbState(null);
        }
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
      unlistenAb?.();
    };
  }, []);

  const resetDetection = async () => {
    if (!isTauri()) {
      return false;
    }
    try {
      trace('detect', 'reset', 'User asked to reset the local detector', undefined, 'decide');
      const ok = await invoke<boolean>('reset_detected_key');
      if (!ok) {
        trace('detect', 'reset_fail', 'Rust refused the detector reset', { why: 'invoke_false' }, 'fail');
      }
      return ok;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      trace('detect', 'reset_fail', `Detector reset failed (${message})`, { why: 'invoke_failed', error: message }, 'fail');
      return false;
    }
  };

  return { detectedKey: state, detectedKeyAb: abState, resetDetection };
}
