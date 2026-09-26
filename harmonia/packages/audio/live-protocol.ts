// @ts-nocheck
import type { CaptureSession, LiveAnalysisUpdate, PcmBlock } from '../application/live-contracts';

export type LiveWorkerRequest =
  | { kind: 'open'; session: CaptureSession }
  | { kind: 'push'; captureId: string; requestId: number; block: PcmBlock }
  | { kind: 'reset'; captureId: string; requestId: number; generation: number; reason: string };
export type LiveWorkerResponse =
  | { kind: 'ready'; captureId: string }
  | { kind: 'ack'; captureId: string; requestId: number }
  | { kind: 'update'; captureId: string; generation: number; update: LiveAnalysisUpdate }
  | { kind: 'error'; captureId: string; message: string };

export function validateCaptureSession(session: CaptureSession): void {
  if (
    !session ||
    typeof session.captureId !== 'string' ||
    !session.captureId.length ||
    session.captureId.length > 200 ||
    session.sampleRate !== 48000 ||
    session.channels !== 2 ||
    session.blockFrames !== 960
  )
    throw new Error('Live analysis requires 48kHz stereo PCM in bounded 20ms blocks');
}
