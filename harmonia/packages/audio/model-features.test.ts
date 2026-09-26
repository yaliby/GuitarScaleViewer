// @ts-nocheck
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { modelFeatures } from './model-features';
const reference = JSON.parse(
  readFileSync(
    new URL('../../ml/artifacts/structured-chord-v1/parity-fixture.json', import.meta.url),
    'utf8',
  ),
) as {
  audio: number[];
  sample_rate: number;
  features: number[][];
  times: number[];
  feature_absolute_tolerance: number;
};
it('matches independently exported Python training features across every bin and frame', () => {
  const result = modelFeatures(Float32Array.from(reference.audio), reference.sample_rate);
  expect(result.times).toEqual(reference.times);
  expect(result.values.length).toBe(reference.features.length * 26);
  let error = 0;
  reference.features.flat().forEach((value, index) => {
    error = Math.max(error, Math.abs(value - result.values[index]));
  });
  expect(error).toBeLessThan(reference.feature_absolute_tolerance);
});
it('requires the trained sample rate and keeps short silent inputs finite', () => {
  expect(() => modelFeatures(new Float32Array(2205), 44100)).toThrow();
  const result = modelFeatures(new Float32Array(100), 22050);
  expect(result.values.length).toBe(26);
  expect(Array.from(result.values).every((v) => v === 0)).toBe(true);
});
