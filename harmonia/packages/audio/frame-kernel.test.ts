// @ts-nocheck
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { extractFeatures } from './features';
it('preserves exact offline DSP bytes from the immutable B001 source snapshot', () => {
  const samples = Float32Array.from(
    { length: 10007 },
    (_, i) => Math.sin(i * 0.19) * 0.3 + Math.cos(i * 0.061) * 0.2,
  );
  // Captured from packages/audio/features.ts inside the immutable B001 source ZIP;
  // the original and refactored complete objects were also compared before freezing this digest.
  expect(
    createHash('sha256')
      .update(JSON.stringify(extractFeatures(samples, 22050)))
      .digest('hex'),
  ).toBe('0e42fedfec1daa5446b8832050d1673d164a63f6a651cd2c8fa68595d600674c');
});
