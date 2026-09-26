// @ts-nocheck
import type { AnalysisProfile } from '../domain/types';
import { createFeatureCache } from '../persistence/feature-cache';
import { dspFeatures } from './feature-cache';
import { analyzeWholeSongFeatures } from './whole-pipeline';
import type { WholePipelineTimings } from './whole-timings';
import {
  assembleNativeWholeSong,
  type NativeHarmonyResult,
  type NativeWholeMetadata,
} from './native-whole';

const scope = self as unknown as {
  onmessage: (event: MessageEvent) => Promise<void>;
  postMessage: (value: unknown, transfer?: Transferable[]) => void;
};
let pending: { metadata: NativeWholeMetadata; started: number; normalizeMs: number } | undefined;
scope.onmessage = async (
  event: MessageEvent<{
    channels: Float32Array[];
    sampleRate: number;
    fingerprint: string;
    profile: AnalysisProfile;
    native?: boolean;
    kind?: 'model-result';
    result?: NativeHarmonyResult;
  }>,
) => {
  try {
    if (event.data.kind === 'model-result') {
      if (!pending || !event.data.result) throw new Error('Unexpected native recognition result');
      const { metadata, started, normalizeMs } = pending;
      pending = undefined;
      const result = event.data.result;
      const timelineStarted = performance.now();
      const analysis = assembleNativeWholeSong(result, metadata);
      scope.postMessage({
        kind: 'result',
        analysis,
        timings: {
          normalizeMs,
          featuresMs: result.timings.cqtSeconds * 1000,
          inferenceMs: result.timings.inferenceSeconds * 1000,
          temporalDecodingMs: (result.timings.hmmSeconds ?? 0) * 1000,
          rhythmKeyMs: result.timings.beatSeconds * 1000,
          timelineMs: performance.now() - timelineStarted + result.timings.decodeSeconds * 1000,
          boundaryMs: (result.timings.refinementSeconds ?? 0) * 1000,
          pipelineMs: result.timings.totalSeconds * 1000,
          workerMs: performance.now() - started,
        },
      });
      return;
    }
    const started = performance.now();
    const { channels, sampleRate, fingerprint, profile } = event.data;
    if (
      !Array.isArray(channels) ||
      channels.length < 1 ||
      channels.length > 2 ||
      !Number.isFinite(sampleRate) ||
      sampleRate < 8000 ||
      sampleRate > 192000 ||
      typeof fingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(fingerprint) ||
      !['fast', 'balanced', 'accurate'].includes(profile) ||
      channels.some((channel) => !(channel instanceof Float32Array)) ||
      channels[0].length < 1 ||
      channels[0].length / sampleRate > 1200 ||
      channels.some((channel) => channel.length !== channels[0].length) ||
      channels[0].byteLength * channels.length > 256 * 1024 * 1024
    )
      throw new Error('Invalid or oversized whole-song audio input');
    const mono = new Float32Array(channels[0].length);
    for (const channel of channels)
      for (let i = 0; i < mono.length; i++) {
        if (!Number.isFinite(channel[i])) throw new Error('Invalid whole-song audio sample');
        mono[i] += channel[i] / channels.length;
      }
    const normalizeMs = performance.now() - started;
    if (event.data.native) {
      if (sampleRate !== 22050) throw new Error('Native recognition requires the pinned PCM rate');
      const waveform = Array.from({ length: Math.min(900, mono.length) }, (_, bin) => {
        const size = Math.min(900, mono.length);
        let peak = 0;
        for (
          let i = Math.floor((bin * mono.length) / size);
          i < Math.floor(((bin + 1) * mono.length) / size);
          i++
        )
          peak = Math.max(peak, Math.abs(mono[i]));
        return Math.min(1, peak);
      });
      pending = {
        metadata: { fingerprint, profile, samples: mono.length, waveform },
        started,
        normalizeMs,
      };
      scope.postMessage({ kind: 'inference-request', samples: mono }, [mono.buffer]);
      return;
    }
    const progress = (stage: string, value: number) =>
      scope.postMessage({ kind: 'progress', stage, value });
    const featureStarted = performance.now();
    const cache = await createFeatureCache();
    const features = await dspFeatures(
      mono,
      {
        fingerprint,
        sampleRate,
        samples: mono.length,
        channels: channels.length,
      },
      cache,
      progress,
    );
    const featuresMs = performance.now() - featureStarted;
    let stages: WholePipelineTimings | undefined;
    const analysis = analyzeWholeSongFeatures(features, fingerprint, profile, progress, (value) => {
      stages = value;
    });
    scope.postMessage({
      kind: 'result',
      analysis,
      timings: { ...stages, normalizeMs, featuresMs, workerMs: performance.now() - started },
    });
  } catch (error) {
    scope.postMessage({
      kind: 'error',
      message: error instanceof Error ? error.message : 'Whole-song analysis failed',
    });
  }
};
