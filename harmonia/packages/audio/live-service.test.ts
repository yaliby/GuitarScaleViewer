// @ts-nocheck
import { afterEach, expect, it, vi } from 'vitest';
import { createStreamingAnalysisService } from './live-service';
import type { CaptureSession, PcmBlock } from '../application/live-contracts';

const capture: CaptureSession = {
  captureId: 'test',
  sampleRate: 48000,
  channels: 2,
  blockFrames: 960,
};
const block = (): PcmBlock => ({
  ...capture,
  sequence: 0,
  firstFrame: 0,
  frameCount: 960,
  devicePosition: 0,
  qpc100ns: null,
  timestampValid: false,
  silent: true,
  discontinuity: false,
  droppedFramesBefore: 0,
  samples: new Float32Array(1920),
});
class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  send(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}
afterEach(() => vi.useRealTimers());
it('keeps one block in flight, transfers PCM and resolves only matching acknowledgments', async () => {
  const worker = new FakeWorker(),
    update = vi.fn();
  const stream = createStreamingAnalysisService(() => worker as unknown as Worker).open(
    capture,
    update,
    vi.fn(),
  );
  const pcm = block();
  const first = stream.push(pcm);
  await expect(stream.push(block())).rejects.toThrow(/previous/);
  expect(worker.postMessage.mock.calls[1][1]).toEqual([pcm.samples.buffer]);
  let settled = false;
  first.then(() => (settled = true));
  worker.send({ kind: 'ack', captureId: 'old', requestId: 1 });
  await Promise.resolve();
  expect(settled).toBe(false);
  worker.send({ kind: 'ack', captureId: 'test', requestId: 1 });
  await first;
  stream.close();
});
it('rejects pending work and ignores all late updates after close', async () => {
  const worker = new FakeWorker(),
    update = vi.fn(),
    error = vi.fn();
  const stream = createStreamingAnalysisService(() => worker as unknown as Worker).open(
    capture,
    update,
    error,
  );
  const pending = stream.push(block());
  const rejection = expect(pending).rejects.toThrow(/closed/i);
  stream.close();
  await rejection;
  worker.send({ kind: 'update', captureId: 'test', update: { current: 'stale' } });
  expect(update).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  await expect(stream.push(block())).rejects.toThrow(/closed/i);
});
it('bounds hung initialization and consumption and releases the worker on failure', async () => {
  vi.useFakeTimers();
  const worker = new FakeWorker(),
    error = vi.fn();
  createStreamingAnalysisService(() => worker as unknown as Worker).open(capture, vi.fn(), error);
  await vi.advanceTimersByTimeAsync(5001);
  expect(error).toHaveBeenCalledTimes(1);
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});
it('acknowledges reset and forwards worker faults once without an unbounded queue', async () => {
  const worker = new FakeWorker(),
    error = vi.fn();
  const stream = createStreamingAnalysisService(() => worker as unknown as Worker).open(
    capture,
    vi.fn(),
    error,
  );
  worker.send({ kind: 'ready', captureId: 'test' });
  const reset = stream.reset('missing PCM');
  worker.send({ kind: 'ack', captureId: 'test', requestId: 1 });
  await reset;
  const pending = stream.push(block());
  const rejection = expect(pending).rejects.toThrow('Corrupt PCM');
  worker.send({ kind: 'error', captureId: 'test', message: 'Corrupt PCM' });
  await rejection;
  expect(error).toHaveBeenCalledTimes(1);
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});
it('invalidates already-posted old snapshots immediately when reset starts', async () => {
  const worker = new FakeWorker(),
    update = vi.fn();
  const stream = createStreamingAnalysisService(() => worker as unknown as Worker).open(
    capture,
    update,
    vi.fn(),
  );
  const reset = stream.reset('gap');
  worker.send({ kind: 'update', captureId: 'test', generation: 0, update: { signal: 'audio' } });
  expect(update).not.toHaveBeenCalled();
  worker.send({ kind: 'update', captureId: 'test', generation: 1, update: { signal: 'waiting' } });
  expect(update).toHaveBeenCalledWith({ signal: 'waiting' });
  worker.send({ kind: 'ack', captureId: 'test', requestId: 1 });
  await reset;
  stream.close();
});
