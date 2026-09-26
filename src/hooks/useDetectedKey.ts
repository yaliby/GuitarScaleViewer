import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { trace } from '../services/debugLog';
import type { NoteSetEvidence } from '../services/keyFusion';

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
  /** Advances only when native analysis receives fresh audio. */
  evidenceId?: number;
  /** Identity of the track whose audio produced this snapshot. */
  trackIdentity?: string | null;
  primaryKey: string | null;
  primaryScale: string | null;
  displayName: string | null;
  confidence: number;
  /** The engine's calibrated evidence about this key; absent from backends that cannot supply it. */
  noteSetEvidence?: NoteSetEvidence | null;
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

type Listener = (key: DetectedKeyState, ab: DetectedKeyAbState | null) => void;

let snapshot: DetectedKeyState = FALLBACK;
let abSnapshot: DetectedKeyAbState | null = null;
let lastIdentity: string | null = null;
const subscribers = new Set<Listener>();
let listenGeneration = 0;
let unlistenFn: (() => void) | undefined;
let connecting = false;

function publish(next: DetectedKeyState, ab: DetectedKeyAbState | null = abSnapshot): void {
  snapshot = next;
  abSnapshot = ab;
  subscribers.forEach((listener) => listener(snapshot, abSnapshot));
}

function apply(next: DetectedKeyState): void {
  const identity = detectedIdentity(next);
  if (lastIdentity !== identity) {
    lastIdentity = identity;
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
        noteSetP: next.noteSetEvidence?.confidence ?? null,
        noteSetRun: next.noteSetEvidence?.noteSetRun ?? null,
        keyRun: next.noteSetEvidence?.keyRun ?? null,
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
  publish(next);
}

function stopListening(): void {
  listenGeneration += 1;
  connecting = false;
  unlistenFn?.();
  unlistenFn = undefined;
  snapshot = { ...FALLBACK };
  abSnapshot = null;
  lastIdentity = null;
}

function startListening(): void {
  if (!isTauri()) {
    trace('detect', 'unavailable', 'Not running inside Tauri — local audio detection is off', {
      why: 'not_tauri',
    }, 'skip');
    publish({ ...FALLBACK }, null);
    return;
  }
  if (connecting || unlistenFn) return;
  connecting = true;
  const generation = listenGeneration;
  void (async () => {
    try {
      const initial = await invoke<DetectedKeyState>('get_detected_key');
      if (generation !== listenGeneration || subscribers.size === 0) {
        connecting = false;
        return;
      }
      apply(initial);

      const nextUnlisten = await listen<DetectedKeyState>('detected-key-update', (event) => {
        if (generation !== listenGeneration) return;
        apply(event.payload);
      });
      if (generation !== listenGeneration || subscribers.size === 0) {
        nextUnlisten();
        connecting = false;
        return;
      }

      const nextUnlistenAb = await listen<DetectedKeyAbState>('detected-key-ab-update', (event) => {
        if (generation !== listenGeneration) return;
        abSnapshot = event.payload;
        subscribers.forEach((listener) => listener(snapshot, abSnapshot));
      });
      if (generation !== listenGeneration || subscribers.size === 0) {
        nextUnlisten();
        nextUnlistenAb();
        connecting = false;
        return;
      }
      unlistenFn = () => {
        nextUnlisten();
        nextUnlistenAb();
      };
      connecting = false;
      trace('detect', 'subscribed', 'Listening for detected-key-update from Rust', undefined, 'ok');
    } catch (error) {
      connecting = false;
      const message = error instanceof Error ? error.message : String(error);
      trace('detect', 'subscribe_fail', `Could not subscribe to the local detector (${message})`, {
        why: 'invoke_or_listen_failed',
        error: message,
      }, 'fail');
      if (generation === listenGeneration && subscribers.size > 0) {
        publish({ ...FALLBACK }, null);
      }
    }
  })();
}

function subscribe(listener: Listener): () => void {
  subscribers.add(listener);
  listener(snapshot, abSnapshot);
  if (subscribers.size === 1) startListening();
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) stopListening();
  };
}

async function resetDetection(): Promise<boolean> {
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
}

/**
 * One local-detector subscription for the whole window.
 * Live Jam reads the same snapshot App keeps, so leaving the room does not cold-start it.
 */
export function useDetectedKey() {
  const [state, setState] = useState(snapshot);
  const [abState, setAbState] = useState(abSnapshot);

  useEffect(
    () =>
      subscribe((key, ab) => {
        setState(key);
        setAbState(ab);
      }),
    [],
  );

  return { detectedKey: state, detectedKeyAb: abState, resetDetection };
}
