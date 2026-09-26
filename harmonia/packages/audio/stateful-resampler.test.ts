// @ts-nocheck
import { expect, it } from 'vitest';
import { StatefulResampler } from './stateful-resampler';

function stream(samples: Float32Array, sizes: number[]) {
  const resampler = new StatefulResampler();
  const output: number[] = [];
  for (let i = 0, block = 0; i < samples.length; block++) {
    const end = Math.min(samples.length, i + sizes[block % sizes.length]);
    output.push(...resampler.push(samples.slice(i, end)));
    i = end;
  }
  return output;
}

it('preserves phase and filter history across arbitrary native packet partitions', () => {
  const pcm = Float32Array.from({ length: 12000 }, (_, i) => Math.sin(i * 0.317) * 0.4);
  expect(stream(pcm, [960])).toEqual(stream(pcm, [1, 7, 319, 53, 960]));
});
it('passes audio-band tones and rejects frequencies above the output Nyquist', () => {
  const rms = (frequency: number) => {
    const pcm = Float32Array.from({ length: 12000 }, (_, i) =>
      Math.sin((2 * Math.PI * frequency * i) / 48000),
    );
    const samples = stream(pcm, [960]).slice(100);
    return Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length);
  };
  expect(rms(1000)).toBeGreaterThan(0.7);
  expect(rms(15000)).toBeLessThan(0.005);
});
it('waits for actual future filter samples and bounds/rejects invalid input', () => {
  const r = new StatefulResampler();
  expect(r.push(new Float32Array(64))).toHaveLength(0);
  expect(r.push(new Float32Array([0]))).toHaveLength(1);
  expect(() => r.push(new Float32Array([NaN]))).toThrow();
  expect(() => r.push(new Float32Array(961))).toThrow();
  expect(r.retainedFrames).toBeLessThanOrEqual(129);
});
