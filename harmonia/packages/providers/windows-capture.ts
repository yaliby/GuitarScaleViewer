// @ts-nocheck
import { invoke, isTauri } from '@tauri-apps/api/core';
import type {
  CaptureBatch,
  CaptureSession,
  CaptureSource,
  PcmBlock,
  PcmCaptureService,
} from '../application/live-contracts';

type NativeInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown, max = 4096): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
function requireValue(condition: unknown): asserts condition {
  if (!condition)
    throw new Error('Windows capture returned an invalid or oversized audio response.');
}
function session(value: unknown): CaptureSession {
  requireValue(
    record(value) &&
      text(value.captureId, 128) &&
      value.sampleRate === 48000 &&
      value.channels === 2 &&
      value.blockFrames === 960,
  );
  return {
    captureId: value.captureId,
    sampleRate: value.sampleRate,
    channels: value.channels,
    blockFrames: value.blockFrames,
  };
}
function block(value: unknown, captureId: string): PcmBlock {
  const format = session(value);
  requireValue(
    record(value) &&
      format.captureId === captureId &&
      integer(value.sequence) &&
      integer(value.firstFrame) &&
      integer(value.frameCount) &&
      value.frameCount > 0 &&
      value.frameCount <= format.blockFrames &&
      integer(value.droppedFramesBefore),
  );
  requireValue(
    (value.devicePosition === null || integer(value.devicePosition)) &&
      (value.qpc100ns === null ||
        (typeof value.qpc100ns === 'string' && /^\d{1,20}$/.test(value.qpc100ns))) &&
      typeof value.timestampValid === 'boolean' &&
      typeof value.silent === 'boolean' &&
      typeof value.discontinuity === 'boolean',
  );
  requireValue(
    Array.isArray(value.samples) &&
      value.samples.length === value.frameCount * format.channels &&
      value.samples.every((v) => typeof v === 'number' && Number.isFinite(v)),
  );
  const samples = Float32Array.from(value.samples);
  requireValue(samples.every(Number.isFinite));
  return {
    ...format,
    sequence: value.sequence,
    firstFrame: value.firstFrame,
    frameCount: value.frameCount,
    devicePosition: value.devicePosition,
    qpc100ns: value.qpc100ns,
    timestampValid: value.timestampValid,
    silent: value.silent,
    discontinuity: value.discontinuity,
    droppedFramesBefore: value.droppedFramesBefore,
    samples,
  };
}

export class WindowsCaptureService implements PcmCaptureService {
  constructor(
    private native: NativeInvoke = invoke,
    private supported: () => boolean = isTauri,
  ) {}
  private check() {
    if (!this.supported())
      throw new Error(
        'Listen Live requires the Windows desktop app. File analysis remains available in this browser.',
      );
  }
  async sources(): Promise<CaptureSource[]> {
    this.check();
    const result = await this.native('capture_sources');
    requireValue(Array.isArray(result) && result.length <= 256);
    return result.map((value) => {
      requireValue(
        record(value) &&
          text(value.id) &&
          text(value.label, 512) &&
          (value.kind === 'process' || value.kind === 'system') &&
          typeof value.available === 'boolean' &&
          (value.pid === undefined || value.pid === null || integer(value.pid)) &&
          (value.reason === undefined || value.reason === null || text(value.reason, 1000)),
      );
      return {
        id: value.id,
        label: value.label,
        kind: value.kind,
        available: value.available,
        ...(typeof value.pid === 'number' ? { pid: value.pid } : {}),
        ...(typeof value.active === 'boolean' ? { active: value.active } : {}),
        ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
      };
    });
  }
  async start(sourceId: string): Promise<CaptureSession> {
    this.check();
    requireValue(text(sourceId));
    return session(await this.native('capture_start', { sourceId }));
  }
  async read(captureId: string): Promise<CaptureBatch> {
    this.check();
    requireValue(text(captureId, 128));
    const result = await this.native('capture_read', { captureId });
    requireValue(
      record(result) &&
        result.captureId === captureId &&
        ['capturing', 'ended', 'error', 'stopped'].includes(result.status as string) &&
        Array.isArray(result.blocks) &&
        result.blocks.length <= 4 &&
        (result.error === undefined || result.error === null || text(result.error, 1000)),
    );
    return {
      captureId,
      status: result.status as CaptureBatch['status'],
      blocks: result.blocks.map((value) => block(value, captureId)),
      ...(typeof result.error === 'string' ? { error: result.error } : {}),
    };
  }
  async stop(captureId: string): Promise<void> {
    this.check();
    requireValue(text(captureId, 128));
    await this.native('capture_stop', { captureId });
  }
}
