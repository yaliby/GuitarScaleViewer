// @ts-nocheck
import { expect, it } from 'vitest';
import { analyzeAudio } from './pipeline';

function fixture() {
  const notes = [
    [130.8128, 164.8138, 195.9977],
    [87.3071, 130.8128, 174.6141, 220],
  ];
  return Float32Array.from({ length: 22050 * 4 }, (_, i) => {
    const chord = notes[Math.floor(i / (22050 * 2))];
    return chord.reduce((sum, f) => sum + 0.09 * Math.sin((2 * Math.PI * f * i) / 22050), 0);
  });
}
it('analyzes actual changing audio into contiguous chords and independent boundary evidence', () => {
  const result = analyzeAudio(fixture(), 22050, 'fixture', 'fast');
  expect(result.segments[0].start).toBe(0);
  expect(result.segments.at(-1)?.end).toBe(4);
  expect(result.segments.some((s) => s.chord.kind === 'chord' && s.chord.root === 0)).toBe(true);
  expect(result.segments.some((s) => s.chord.kind === 'chord' && s.chord.root === 5)).toBe(true);
  expect(result.boundaries.some((b) => Math.abs(b.time - 2) < 0.15 && b.probability > 0.2)).toBe(
    true,
  );
  expect(result.calibration).toBe('uncalibrated');
  expect(result.meter).toBeNull();
});
it('returns no-chord, unknown key and no fabricated tempo for silence', () => {
  const result = analyzeAudio(new Float32Array(22050), 22050, 'silence', 'balanced');
  expect(result.segments).toHaveLength(1);
  expect(result.segments[0].chord.kind).toBe('none');
  expect(result.tempo).toBeNull();
  expect(result.key).toBeNull();
  expect(result.boundaries.every((boundary) => boundary.probability === 0)).toBe(true);
});
