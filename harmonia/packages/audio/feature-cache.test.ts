// @ts-nocheck
import { expect, it } from 'vitest';
import { extractFeatures } from './features';
import { modelFeatures } from './model-features';
import { decodeDsp, encodeDsp, decodeModel, encodeModel, featureKey } from './feature-cache';
import { dspFeatures } from './feature-cache';
import { analyzeAudio, analyzeFeatures } from './pipeline';
import type { DerivedFeatureCache } from '../application/feature-cache';

const identity = { fingerprint: 'a'.repeat(64), sampleRate: 22050, samples: 22050, channels: 1 };
it('preserves every DSP and model feature exactly through binary storage', () => {
  const samples = Float32Array.from({ length: 22050 }, (_, i) => Math.sin(i * 0.123) * 0.2);
  const dsp = extractFeatures(samples, 22050);
  expect(decodeDsp(encodeDsp(dsp), identity)).toEqual(dsp);
  const model = modelFeatures(samples, 22050);
  expect(decodeModel(encodeModel(model), identity)).toEqual(model);
});
it('rejects malformed feature lengths, nonfinite bins and altered timing', () => {
  const dsp = extractFeatures(new Float32Array(22050), 22050);
  expect(() => decodeDsp(new ArrayBuffer(4), identity)).toThrow();
  dsp.frames[0].chroma[0] = NaN;
  expect(() => decodeDsp(encodeDsp(dsp), identity)).toThrow();
  dsp.frames[0].chroma[0] = 0;
  dsp.frames[1].time = 900;
  expect(() => decodeDsp(encodeDsp(dsp), identity)).toThrow();
});
it('refuses oversized encodings before traversing or allocating payload buffers', () => {
  const frames = new Array(100000);
  expect(() => encodeDsp({ frames, waveform: [], duration: 1, hopSeconds: 0.02 })).toThrow(
    'Corrupt derived features',
  );
  expect(() => encodeModel({ times: new Array(200000), values: new Float32Array(0) })).toThrow(
    'Corrupt derived features',
  );
});
it('separates extraction versions and decoded layouts while remaining profile-independent', async () => {
  const base = await featureKey(identity, 'peak-chroma-v1');
  expect(await featureKey(identity, 'peak-chroma-v1')).toBe(base);
  expect(await featureKey(identity, 'chroma-bass-browser-v1')).not.toBe(base);
  expect(await featureKey({ ...identity, channels: 2 }, 'peak-chroma-v1')).not.toBe(base);
  expect(await featureKey({ ...identity, samples: 22051 }, 'peak-chroma-v1')).not.toBe(base);
});
it('reuses exact features across profiles and recovers a structurally corrupt cache', async () => {
  let stored: ArrayBuffer | null = null;
  const cache: DerivedFeatureCache = {
    read: async () => stored,
    write: async (_key, bytes) => {
      stored = bytes;
    },
    remove: async () => {
      stored = null;
    },
    clear: async () => {
      stored = null;
    },
  };
  const samples = Float32Array.from({ length: 22050 }, (_, i) => Math.sin(i * 0.123) * 0.2);
  const cold = await dspFeatures(samples, identity, cache, () => undefined);
  const stages: string[] = [];
  const warm = await dspFeatures(samples, identity, cache, (stage) => stages.push(stage));
  expect(stages).toContain('Reusing local analysis features');
  expect(warm).toEqual(cold);
  for (const profile of ['fast', 'balanced'] as const) {
    const expected = analyzeAudio(samples, 22050, identity.fingerprint, profile);
    const actual = analyzeFeatures(warm, identity.fingerprint, profile);
    expect({ ...actual, createdAt: '' }).toEqual({ ...expected, createdAt: '' });
  }
  stored = new ArrayBuffer(4);
  expect(await dspFeatures(samples, identity, cache, () => undefined)).toEqual(cold);
});
