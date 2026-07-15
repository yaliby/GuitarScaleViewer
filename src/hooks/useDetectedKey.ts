import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

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

export function useDetectedKey() {
  const [state, setState] = useState<DetectedKeyState>(FALLBACK);
  const [abState, setAbState] = useState<DetectedKeyAbState | null>(null);

  useEffect(() => {
    if (!isTauri()) {
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
          setState(initial);
        }

        unlisten = await listen<DetectedKeyState>('detected-key-update', (event) => {
          if (!cancelled) {
            setState(event.payload);
          }
        });

        unlistenAb = await listen<DetectedKeyAbState>('detected-key-ab-update', (event) => {
          if (!cancelled) {
            setAbState(event.payload);
          }
        });
      } catch {
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
      return await invoke<boolean>('reset_detected_key');
    } catch {
      return false;
    }
  };

  return { detectedKey: state, detectedKeyAb: abState, resetDetection };
}
