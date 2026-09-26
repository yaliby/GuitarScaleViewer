// @ts-nocheck
import { FEATURE_CACHE_ENTRY_BYTES, type DerivedFeatureCache } from '../application/feature-cache';
import { extractFeatures, FEATURE_VERSION, type AudioFeatures } from './features';
import { modelFeatures } from './model-features';

export interface FeatureIdentity {
  fingerprint: string;
  sampleRate: number;
  samples: number;
  channels: number;
}
type ModelFeatures = ReturnType<typeof modelFeatures>;
type Progress = (stage: string, value: number) => void;
export async function featureKey(identity: FeatureIdentity, version: string): Promise<string> {
  if (
    !/^[a-f0-9]{64}$/.test(identity.fingerprint) ||
    !Number.isInteger(identity.samples) ||
    identity.samples < 1 ||
    identity.samples / identity.sampleRate > 1200 ||
    ![1, 2].includes(identity.channels) ||
    !Number.isFinite(identity.sampleRate) ||
    identity.sampleRate < 8000 ||
    identity.sampleRate > 192000
  )
    throw new Error('Invalid feature identity');
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      'feature-codec-v1',
      'web-audio-22050-arithmetic-mono-v1',
      identity.fingerprint,
      identity.sampleRate,
      identity.samples,
      identity.channels,
      version,
    ]),
  );
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
function requireValue(condition: boolean): asserts condition {
  if (!condition) throw new Error('Corrupt derived features');
}
export function encodeDsp(features: AudioFeatures): ArrayBuffer {
  const length = 4 + features.frames.length * 27 + features.waveform.length;
  requireValue(
    features.frames.length > 0 &&
      features.waveform.length <= 900 &&
      length * 8 <= FEATURE_CACHE_ENTRY_BYTES,
  );
  const values = new Float64Array(length);
  values.set([
    features.duration,
    features.hopSeconds,
    features.frames.length,
    features.waveform.length,
  ]);
  features.frames.forEach((frame, index) =>
    values.set(
      [frame.time, ...frame.chroma, ...frame.bass, frame.rms, frame.onset],
      4 + index * 27,
    ),
  );
  values.set(features.waveform, 4 + features.frames.length * 27);
  return values.buffer;
}
export function decodeDsp(bytes: ArrayBuffer, identity: FeatureIdentity): AudioFeatures {
  requireValue(
    bytes.byteLength >= 32 &&
      bytes.byteLength <= FEATURE_CACHE_ENTRY_BYTES &&
      bytes.byteLength % 8 === 0,
  );
  const values = new Float64Array(bytes);
  const [duration, hopSeconds, count, waveformLength] = values;
  const hop = Math.max(1, Math.round(identity.sampleRate * 0.02322));
  requireValue(
    duration === identity.samples / identity.sampleRate &&
      hopSeconds === hop / identity.sampleRate &&
      count === Math.ceil(identity.samples / hop) &&
      waveformLength === Math.min(900, identity.samples) &&
      values.length === 4 + count * 27 + waveformLength &&
      values.every(Number.isFinite),
  );
  const frames = Array.from({ length: count }, (_, index) => {
    const offset = 4 + index * 27;
    const time = values[offset],
      chroma = Array.from(values.slice(offset + 1, offset + 13)),
      bass = Array.from(values.slice(offset + 13, offset + 25)),
      rms = values[offset + 25],
      onset = values[offset + 26];
    requireValue(
      time === (index * hop) / identity.sampleRate &&
        rms >= 0 &&
        onset >= 0 &&
        [...chroma, ...bass].every((v) => v >= 0 && v <= 1 + 1e-12),
    );
    return { time, chroma, bass, rms, onset };
  });
  const waveform = Array.from(values.slice(4 + count * 27));
  requireValue(waveform.every((v) => v >= 0 && v <= 1));
  return { frames, waveform, duration, hopSeconds };
}
export function encodeModel(features: ModelFeatures): ArrayBuffer {
  const length = 8 + features.times.length * 8 + features.values.byteLength;
  requireValue(
    features.times.length > 0 &&
      features.values.length === features.times.length * 26 &&
      length <= FEATURE_CACHE_ENTRY_BYTES,
  );
  const bytes = new ArrayBuffer(length);
  new Float64Array(bytes, 0, 1)[0] = features.times.length;
  new Float64Array(bytes, 8, features.times.length).set(features.times);
  new Float32Array(bytes, 8 + features.times.length * 8).set(features.values);
  return bytes;
}
export function decodeModel(bytes: ArrayBuffer, identity: FeatureIdentity): ModelFeatures {
  requireValue(bytes.byteLength >= 8 && bytes.byteLength <= FEATURE_CACHE_ENTRY_BYTES);
  const count = new Float64Array(bytes, 0, 1)[0];
  requireValue(
    identity.sampleRate === 22050 &&
      count === 1 + Math.floor((Math.max(2048, identity.samples) - 2048) / 512) &&
      bytes.byteLength === 8 + count * (8 + 26 * 4),
  );
  const times = Array.from(new Float64Array(bytes, 8, count));
  const values = new Float32Array(bytes, 8 + count * 8);
  requireValue(
    times.every((t, i) => t === (i * 512 + 1024) / 22050) &&
      values.every((v, i) => Number.isFinite(v) && v >= 0 && (i % 26 >= 24 || v <= 1 + 1e-6)),
  );
  return { times, values };
}
async function cached<T>(
  cache: DerivedFeatureCache | null,
  identity: FeatureIdentity,
  version: string,
  decode: (bytes: ArrayBuffer, identity: FeatureIdentity) => T,
  encode: (value: T) => ArrayBuffer,
  extract: () => T,
  progress: Progress,
): Promise<T> {
  let key: string | undefined;
  try {
    if (cache) {
      key = await featureKey(identity, version);
      const bytes = await cache.read(key);
      if (bytes) {
        try {
          const value = decode(bytes, identity);
          progress('Reusing local analysis features', 0.05);
          return value;
        } catch {
          await cache.remove(key);
        }
      }
    }
  } catch {
    /* Optional storage; normal extraction remains authoritative. */
  }
  const value = extract();
  if (cache && key) {
    try {
      await cache.write(key, encode(value));
    } catch {
      /* Storage can be denied or full. */
    }
  }
  return value;
}
export function dspFeatures(
  samples: Float32Array,
  identity: FeatureIdentity,
  cache: DerivedFeatureCache | null,
  progress: Progress,
): Promise<AudioFeatures> {
  return cached(
    cache,
    identity,
    FEATURE_VERSION,
    decodeDsp,
    encodeDsp,
    () =>
      extractFeatures(samples, identity.sampleRate, (value) =>
        progress('Extracting harmonic features', value * 0.65),
      ),
    progress,
  );
}
export function learnedFeatures(
  samples: Float32Array,
  identity: FeatureIdentity,
  cache: DerivedFeatureCache | null,
  progress: Progress,
): Promise<ModelFeatures> {
  return cached(
    cache,
    identity,
    'chroma-bass-browser-v1',
    decodeModel,
    encodeModel,
    () => modelFeatures(samples, identity.sampleRate),
    progress,
  );
}
