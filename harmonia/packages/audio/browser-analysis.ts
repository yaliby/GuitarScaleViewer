// @ts-nocheck
import type { AudioAnalysisService } from '../application/contracts';
import type { Analysis, AnalysisProfile } from '../domain/types';
import manifest from '../../ml/artifacts/structured-chord-v1/manifest.json';
import { inspectAudioChannels, validateDecodeBudget } from './preflight';
import { PIPELINE_VERSION } from './versions';

function aborted(): DOMException {
  return new DOMException('Analysis cancelled', 'AbortError');
}
function inspectDuration(file: File, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const audio = new Audio(),
      url = URL.createObjectURL(file);
    audio.preload = 'metadata';
    const cleanup = () => {
      clearTimeout(timer);
      audio.onloadedmetadata = null;
      audio.onerror = null;
      signal.removeEventListener('abort', cancel);
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
    };
    const cancel = () => {
      cleanup();
      reject(aborted());
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Could not read audio duration. Try converting to WAV.'));
    }, 15000);
    audio.onloadedmetadata = () => {
      const duration = audio.duration;
      cleanup();
      if (!Number.isFinite(duration) || duration <= 0 || duration > 1200)
        reject(new Error('Choose a recording with a known duration of at most 20 minutes.'));
      else resolve(duration);
    };
    audio.onerror = () => {
      cleanup();
      reject(
        new Error(
          'This audio file could not be decoded. Try an unprotected WAV, MP3 or FLAC file.',
        ),
      );
    };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    else audio.src = url;
  });
}

export class BrowserAudioAnalysisService implements AudioAnalysisService {
  readonly pipelineVersion: string = PIPELINE_VERSION;
  private decoding: Promise<unknown> = Promise.resolve();
  modelVersion(profile: AnalysisProfile) {
    return profile === 'accurate' ? manifest.model_id : 'dsp-template-v1';
  }
  async fingerprint(file: File) {
    if (file.size > 100 * 1024 * 1024) throw new Error('Choose an audio file under 100 MB.');
    if (!/\.(wav|mp3|flac|ogg|oga|m4a|aac|aif|aiff|opus|webm)$/i.test(file.name))
      throw new Error(
        'Unsupported file. Choose WAV, MP3, FLAC, OGG, M4A, AAC, AIFF or Opus audio.',
      );
    const bytes = await file.arrayBuffer(),
      hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  protected decode(file: File, signal: AbortSignal): Promise<AudioBuffer> {
    const operation = this.decoding.then(async () => {
      if (signal.aborted) throw aborted();
      if (file.size > 100 * 1024 * 1024) throw new Error('Choose an audio file under 100 MB.');
      // MP4 moov/track metadata can follow mdat. Read the bounded encoded file once,
      // structurally validate it, then reuse the same bytes for the single decode.
      const encoded = await file.arrayBuffer();
      const channels = inspectAudioChannels(new Uint8Array(encoded));
      validateDecodeBudget(channels, 1);
      validateDecodeBudget(channels, await inspectDuration(file, signal));
      if (signal.aborted) throw aborted();
      const context = new AudioContext({ sampleRate: 22050 });
      try {
        const decoded = await context.decodeAudioData(encoded);
        if (signal.aborted) throw aborted();
        if (
          decoded.numberOfChannels !== channels ||
          decoded.duration > 1200 ||
          decoded.length * decoded.numberOfChannels * 4 > 256 * 1024 * 1024
        )
          throw new Error(
            'Decoded audio exceeds the declared channel layout or 256 MB analysis limit. Use a shorter mono or stereo file.',
          );
        return decoded;
      } finally {
        await context.close();
      }
    });
    this.decoding = operation.catch(() => undefined);
    return operation;
  }
  async analyze(
    file: File,
    fingerprint: string,
    profile: AnalysisProfile,
    signal: AbortSignal,
    progress: (stage: string, value: number) => void,
  ): Promise<Analysis> {
    progress('Reading local audio', 0);
    const decoded = await this.decode(file, signal);
    if (signal.aborted) throw aborted();
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) =>
      decoded.getChannelData(i),
    );
    const worker = new Worker(new URL('./import-worker.ts', import.meta.url), { type: 'module' });
    return this.runWorker<Analysis>(
      worker,
      signal,
      {
        channels,
        sampleRate: decoded.sampleRate,
        fingerprint,
        profile,
        assetBase: new URL('/', location.href).href,
      },
      channels.map((c) => c.buffer),
      progress,
    );
  }
  async demo(signal: AbortSignal): Promise<{ file: Blob; analysis: Analysis }> {
    const worker = new Worker(new URL('./demo-worker.ts', import.meta.url), { type: 'module' });
    const result = await this.runWorker<{ analysis: Analysis; bytes: ArrayBuffer }>(
      worker,
      signal,
      {},
      [],
    );
    return { analysis: result.analysis, file: new Blob([result.bytes], { type: 'audio/wav' }) };
  }
  protected runWorker<T>(
    worker: Worker,
    signal: AbortSignal,
    message: unknown,
    transfer: Transferable[],
    progress?: (stage: string, value: number) => void,
    result?: (message: unknown) => void,
    request?: (message: { samples: Float32Array }) => Promise<unknown>,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        worker.terminate();
        signal.removeEventListener('abort', cancel);
      };
      const cancel = () => {
        cleanup();
        reject(aborted());
      };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) {
        cancel();
        return;
      }
      worker.onmessage = (event) => {
        const data = event.data;
        if (data.kind === 'inference-request' && request) {
          void request(data).then(
            (value) => {
              if (!signal.aborted) worker.postMessage({ kind: 'model-result', result: value });
            },
            (error) => {
              cleanup();
              reject(error instanceof Error ? error : new Error(String(error)));
            },
          );
          return;
        }
        if (data.kind === 'progress') {
          progress?.(data.stage, data.value);
          return;
        }
        cleanup();
        if (data.kind === 'error') reject(new Error(data.message));
        else {
          result?.(data);
          resolve((data.kind === 'result' ? data.analysis : data) as T);
        }
      };
      worker.onerror = () => {
        cleanup();
        reject(new Error('The audio worker stopped unexpectedly. Try a shorter recording.'));
      };
      worker.postMessage(message, transfer);
    });
  }
}
