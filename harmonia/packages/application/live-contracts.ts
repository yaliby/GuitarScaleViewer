// @ts-nocheck
import type { ChordAlternative } from '../domain/types';

/** Capture scope is independent of playback/provider capabilities. */
export interface CaptureSource {
  id: string;
  label: string;
  kind: 'process' | 'system';
  pid?: number;
  available: boolean;
  active?: boolean;
  reason?: string;
}

export interface CaptureSession {
  captureId: string;
  sampleRate: number;
  channels: number;
  blockFrames: number;
}

/** Interleaved normalized PCM. Frame indices, not arrival times, define audio time. */
export interface PcmBlock extends CaptureSession {
  sequence: number;
  firstFrame: number;
  frameCount: number;
  devicePosition: number | null;
  qpc100ns: string | null;
  timestampValid: boolean;
  silent: boolean;
  discontinuity: boolean;
  droppedFramesBefore: number;
  samples: Float32Array;
}

export interface CaptureBatch {
  captureId: string;
  status: 'capturing' | 'ended' | 'error' | 'stopped';
  blocks: PcmBlock[];
  error?: string;
}

/** Bounded pull provides backpressure; implementations must never retain unlimited PCM. */
export interface PcmCaptureService {
  sources(): Promise<CaptureSource[]>;
  start(sourceId: string): Promise<CaptureSession>;
  read(captureId: string): Promise<CaptureBatch>;
  stop(captureId: string): Promise<void>;
}

export interface LiveChordSegment {
  start: number;
  end: number;
  estimate: ChordAlternative;
}

export interface LiveAnalysisUpdate {
  captureId: string;
  position: number;
  analyzedThrough: number;
  lookaheadSeconds: number;
  signal: 'waiting' | 'audio' | 'silence';
  current: ChordAlternative | null;
  recent: LiveChordSegment[];
  discontinuities: number;
  bufferedFrames: number;
}

export interface StreamingAnalysisSession {
  /** Resolves after consumption, so the caller can pull the next bounded batch. */
  push(block: PcmBlock): Promise<void>;
  reset(reason: string): Promise<void>;
  close(): void;
}

export interface StreamingAnalysisService {
  open(
    session: CaptureSession,
    update: (value: LiveAnalysisUpdate) => void,
    error: (error: Error) => void,
  ): StreamingAnalysisSession;
}
