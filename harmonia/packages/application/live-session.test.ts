// @ts-nocheck
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LiveSessionController } from './live-session';
import type {
  CaptureSession,
  LiveAnalysisUpdate,
  PcmCaptureService,
  StreamingAnalysisService,
} from './live-contracts';

const session: CaptureSession = {
  captureId: 'one',
  sampleRate: 48000,
  channels: 2,
  blockFrames: 960,
};
const update: LiveAnalysisUpdate = {
  captureId: 'one',
  position: 1,
  analyzedThrough: 0.8,
  lookaheadSeconds: 0.2,
  signal: 'audio',
  current: { chord: { kind: 'none' }, score: 1 },
  recent: [],
  discontinuities: 0,
  bufferedFrames: 4096,
};
const controllers: LiveSessionController[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture() {
  let publish!: (value: LiveAnalysisUpdate) => void;
  const capture: PcmCaptureService = {
    sources: vi.fn(async () => [
      { id: 'app', label: 'Music app', kind: 'process' as const, available: true },
    ]),
    start: vi.fn(async () => session),
    read: vi.fn(async () => ({ captureId: 'one', status: 'capturing' as const, blocks: [] })),
    stop: vi.fn(async () => {}),
  };
  const analysis = { push: vi.fn(async () => {}), reset: vi.fn(async () => {}), close: vi.fn() };
  const analyzer: StreamingAnalysisService = {
    open: vi.fn((_session, callback) => {
      publish = callback;
      return analysis;
    }),
  };
  const pause = vi.fn();
  const controller = new LiveSessionController({ capture, analyzer, beforeStart: pause });
  controllers.push(controller);
  return {
    controller,
    capture,
    analyzer,
    analysis,
    pause,
    publish: (value: LiveAnalysisUpdate) => publish(value),
  };
}
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.stop();
  vi.useRealTimers();
});

it('starts only after explicit selection/start and pauses optional file playback', async () => {
  const f = fixture();
  await f.controller.refreshSources();
  expect(f.capture.start).not.toHaveBeenCalled();
  f.controller.selectSource('app');
  await f.controller.start();
  expect(f.pause).toHaveBeenCalledOnce();
  expect(f.controller.snapshot().status).toBe('waiting');
  f.publish(update);
  expect(f.controller.snapshot().status).toBe('listening');
  expect(f.controller.snapshot().update?.position).toBe(1);
});

it('stop during pending native activation releases late session without opening a worker', async () => {
  const f = fixture(),
    activation = deferred<CaptureSession>();
  f.capture.start = vi.fn(() => activation.promise);
  await f.controller.refreshSources();
  f.controller.selectSource('app');
  const start = f.controller.start();
  await vi.advanceTimersByTimeAsync(0);
  const stop = f.controller.stop();
  activation.resolve(session);
  await Promise.all([start, stop]);
  expect(f.capture.stop).toHaveBeenCalledWith('one');
  expect(f.analyzer.open).not.toHaveBeenCalled();
  expect(f.controller.snapshot().status).toBe('idle');
});

it('rejects stale results after stop and clears the displayed estimate immediately', async () => {
  const f = fixture();
  await f.controller.refreshSources();
  f.controller.selectSource('app');
  await f.controller.start();
  f.publish(update);
  const stop = f.controller.stop();
  expect(f.controller.snapshot().update).toBeNull();
  f.publish(update);
  await stop;
  expect(f.controller.snapshot().update).toBeNull();
  expect(f.analysis.close).toHaveBeenCalledOnce();
});

it('clears stale estimates and resets analysis when no packets arrive', async () => {
  const f = fixture();
  await f.controller.refreshSources();
  f.controller.selectSource('app');
  await f.controller.start();
  f.publish(update);
  await vi.advanceTimersByTimeAsync(1100);
  expect(f.controller.snapshot().status).toBe('waiting');
  expect(f.controller.snapshot().update?.current ?? null).toBeNull();
  expect(f.analysis.reset).toHaveBeenCalledTimes(1);
});

it('source exit disposes the worker and native capture while preserving the reason', async () => {
  const f = fixture();
  f.capture.read = vi.fn(async () => ({
    captureId: 'one',
    status: 'ended' as const,
    blocks: [],
    error: 'Selected application closed.',
  }));
  await f.controller.refreshSources();
  f.controller.selectSource('app');
  await f.controller.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.controller.snapshot().status).toBe('ended');
  expect(f.controller.snapshot().error).toContain('closed');
  expect(f.analysis.close).toHaveBeenCalledOnce();
  expect(f.capture.stop).toHaveBeenCalledWith('one');
});

it('waits for worker consumption before requesting another PCM batch', async () => {
  const f = fixture(),
    consumed = deferred<void>();
  f.capture.read = vi.fn(async () => ({
    captureId: 'one',
    status: 'capturing' as const,
    blocks: [
      {
        ...session,
        sequence: 0,
        firstFrame: 0,
        frameCount: 960,
        samples: new Float32Array(1920),
        devicePosition: 0,
        qpc100ns: '1',
        timestampValid: true,
        silent: false,
        discontinuity: false,
        droppedFramesBefore: 0,
      },
    ],
  }));
  f.analysis.push = vi.fn(() => consumed.promise);
  await f.controller.refreshSources();
  f.controller.selectSource('app');
  await f.controller.start();
  await vi.advanceTimersByTimeAsync(500);
  expect(f.capture.read).toHaveBeenCalledOnce();
  consumed.resolve();
  await vi.advanceTimersByTimeAsync(20);
  expect(f.capture.read).toHaveBeenCalledTimes(2);
});

it('closes a worker that reports a synchronous initialization failure', async () => {
  const f = fixture();
  f.analyzer.open = vi.fn((_session, _update, error) => {
    error(new Error('Worker unavailable'));
    return f.analysis;
  });
  await f.controller.refreshSources();
  f.controller.selectSource('app');
  await f.controller.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.controller.snapshot().status).toBe('error');
  expect(f.analysis.close).toHaveBeenCalledOnce();
  expect(f.capture.read).not.toHaveBeenCalled();
});

it('does not start a replacement if stopping the previous native capture fails', async () => {
  const f = fixture();
  await f.controller.refreshSources();
  f.controller.selectSource('app');
  await f.controller.start();
  f.capture.stop = vi.fn(async () => {
    throw new Error('Could not stop capture');
  });
  await f.controller.start();
  expect(f.controller.snapshot().status).toBe('error');
  expect(f.controller.snapshot().error).toContain('Could not stop');
  expect(f.capture.start).toHaveBeenCalledOnce();
  f.capture.stop = vi.fn(async () => {});
});
