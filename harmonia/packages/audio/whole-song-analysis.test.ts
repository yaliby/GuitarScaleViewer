// @ts-nocheck
import { afterEach, expect, it, vi } from 'vitest';
import { WholeSongAnalysisService } from './whole-song-analysis';
import { BrowserAudioAnalysisService } from './browser-analysis';
import { analyzeWholeSongFeatures } from './whole-pipeline';
import { extractFeatures } from './features';
import { NATIVE_MODEL_VERSION, NATIVE_PIPELINE_VERSION } from './native-whole';

class WorkerHarness {
  static latest: WorkerHarness | undefined;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  terminated = false;
  message: { channels: Float32Array[]; fingerprint: string; profile: string } | undefined;
  constructor(readonly url: URL) {
    WorkerHarness.latest = this;
  }
  postMessage(message: typeof this.message) {
    this.message = message;
  }
  terminate() {
    this.terminated = true;
  }
}
class DecodedService extends WholeSongAnalysisService {
  protected override async decode(): Promise<AudioBuffer> {
    const pcm = new Float32Array(22050);
    return {
      numberOfChannels: 1,
      sampleRate: 22050,
      duration: 1,
      getChannelData: () => pcm,
    } as unknown as AudioBuffer;
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  WorkerHarness.latest = undefined;
});

it('native model preparation has a distinct cache identity and cancellation rejects late inference', async () => {
  vi.stubGlobal('Worker', WorkerHarness);
  let finish!: (value: unknown) => void;
  const recognize = vi.fn(
    (_samples: Float32Array, _signal: AbortSignal) =>
      new Promise<unknown>((resolve) => {
        finish = resolve;
      }),
  );
  const service = new DecodedService({ recognize });
  expect(service.pipelineVersion).toBe(NATIVE_PIPELINE_VERSION);
  expect(service.modelVersion('balanced')).toBe(NATIVE_MODEL_VERSION);
  const abort = new AbortController();
  const promise = service.analyze(
    new File([], 'song.wav'),
    'fixture',
    'balanced',
    abort.signal,
    () => {},
  );
  const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve();
  const worker = WorkerHarness.latest!;
  worker.onmessage!({
    data: { kind: 'inference-request', samples: new Float32Array(22050) },
  } as MessageEvent);
  expect(worker.terminated).toBe(false);
  expect(recognize).toHaveBeenCalledOnce();
  abort.abort();
  await rejected;
  expect(recognize.mock.calls[0][1].aborted).toBe(true);
  finish({ schemaVersion: 1 });
  await Promise.resolve();
  expect(worker.message).not.toHaveProperty('kind', 'model-result');
  expect(worker.terminated).toBe(true);
});

it('a failed assembly worker cancels its still-running native inference', async () => {
  vi.stubGlobal('Worker', WorkerHarness);
  const recognize = vi.fn(
    (_samples: Float32Array, _signal: AbortSignal) => new Promise<unknown>(() => {}),
  );
  const service = new DecodedService({ recognize });
  const promise = service.analyze(
    new File([], 'song.wav'),
    'fixture',
    'balanced',
    new AbortController().signal,
    () => {},
  );
  const rejected = expect(promise).rejects.toThrow('worker stopped');
  await Promise.resolve();
  const worker = WorkerHarness.latest!;
  worker.onmessage!({
    data: { kind: 'inference-request', samples: new Float32Array(22050) },
  } as MessageEvent);
  worker.onerror!();
  await rejected;
  expect(recognize.mock.calls[0][1].aborted).toBe(true);
});

it('rejects decodable wrong-duration acquired audio before starting recognition', async () => {
  vi.stubGlobal('Worker', WorkerHarness);
  const file = new File([], 'short.wav');
  const service = new DecodedService();
  service.expectDuration(file, 180);
  await expect(
    service.analyze(file, 'fixture', 'balanced', new AbortController().signal, () => {}),
  ).rejects.toMatchObject({ code: 'INVALID_AUDIO_INPUT' });
  expect(WorkerHarness.latest).toBeUndefined();
  expect(() => service.expectDuration(file, NaN)).toThrow();
  service.expectDuration(file, null);
});

it('uses whole-song identities for cache lookup rather than the experimental learned model', () => {
  const service = new WholeSongAnalysisService();
  const baseline = new BrowserAudioAnalysisService();
  expect(service.pipelineVersion).not.toBe(baseline.pipelineVersion);
  expect(service.modelVersion('accurate')).toBe(service.modelVersion('balanced'));
  expect(service.modelVersion('balanced')).not.toBe(baseline.modelVersion('balanced'));
});

it('accepts OGA filenames for fingerprinting while decode still checks the actual header', async () => {
  const service = new WholeSongAnalysisService();
  const bytes = new Uint8Array([79, 103, 103, 83]);
  expect(await service.fingerprint(new File([bytes], 'recording.oga'))).toBe(
    await service.fingerprint(new File([bytes], 'recording.ogg')),
  );
});

it('sends complete PCM to the separate worker and releases it after the final timeline', async () => {
  vi.stubGlobal('Worker', WorkerHarness);
  const service = new DecodedService();
  const promise = service.analyze(
    new File([], 'audio.wav'),
    'fixture',
    'balanced',
    new AbortController().signal,
    () => {},
  );
  await Promise.resolve();
  const worker = WorkerHarness.latest!;
  expect(worker.url.pathname).toContain('whole-song-worker');
  expect(worker.message?.channels[0].length).toBe(22050);
  const analysis = analyzeWholeSongFeatures(
    extractFeatures(worker.message!.channels[0], 22050),
    'fixture',
    'balanced',
  );
  worker.onmessage!({ data: { kind: 'result', analysis } } as MessageEvent);
  expect((await promise).segments.at(-1)?.end).toBe(1);
  expect(worker.terminated).toBe(true);
});

it('terminates an active whole-song worker on cancellation and rejects its result', async () => {
  vi.stubGlobal('Worker', WorkerHarness);
  const abort = new AbortController();
  const promise = new DecodedService().analyze(
    new File([], 'audio.wav'),
    'fixture',
    'balanced',
    abort.signal,
    () => {},
  );
  const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve();
  abort.abort();
  await rejected;
  expect(WorkerHarness.latest?.terminated).toBe(true);
});

it('does not start a worker for already cancelled preparation', async () => {
  vi.stubGlobal('Worker', WorkerHarness);
  const abort = new AbortController();
  abort.abort();
  await expect(
    new DecodedService().analyze(
      new File([], 'audio.wav'),
      'fixture',
      'balanced',
      abort.signal,
      () => {},
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(WorkerHarness.latest).toBeUndefined();
});

it('marks invalid decoded input for acquisition failover without marking recognition failures', async () => {
  class InvalidService extends WholeSongAnalysisService {
    protected override async decode(): Promise<AudioBuffer> {
      throw new Error('Corrupt media');
    }
  }
  await expect(
    new InvalidService().analyze(
      new File([], 'bad.wav'),
      'fixture',
      'balanced',
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toMatchObject({ code: 'INVALID_AUDIO_INPUT', message: 'Corrupt media' });
  vi.stubGlobal('Worker', WorkerHarness);
  const analysis = new DecodedService().analyze(
    new File([], 'valid.wav'),
    'fixture',
    'balanced',
    new AbortController().signal,
    () => {},
  );
  const failed = expect(analysis).rejects.not.toHaveProperty('code');
  await Promise.resolve();
  WorkerHarness.latest!.onmessage!({
    data: { kind: 'error', message: 'Recognition failed' },
  } as MessageEvent);
  await failed;
});

it('publishes immutable diagnostic timings and bounds browser performance entries', async () => {
  vi.stubGlobal('Worker', WorkerHarness);
  const service = new DecodedService();
  const promise = service.analyze(
    new File([], 'audio.wav'),
    'fixture',
    'balanced',
    new AbortController().signal,
    () => {},
  );
  await Promise.resolve();
  const analysis = analyzeWholeSongFeatures(
    extractFeatures(new Float32Array(22050), 22050),
    'fixture',
    'balanced',
  );
  const timings = {
    normalizeMs: 1,
    featuresMs: 2,
    inferenceMs: 3,
    temporalDecodingMs: 4,
    timelineMs: 5,
    rhythmKeyMs: 6,
    boundaryMs: 7,
    pipelineMs: 25,
    workerMs: 28,
  };
  WorkerHarness.latest!.onmessage!({ data: { kind: 'result', analysis, timings } } as MessageEvent);
  await promise;
  expect(service.lastTimings).toMatchObject(timings);
  expect(Object.isFrozen(service.lastTimings)).toBe(true);
  expect(performance.getEntriesByName('harmonia.whole.analysis')).toHaveLength(1);
  expect(performance.getEntriesByName('harmonia.whole.decode')).toHaveLength(1);
});
