// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { extractFeatures } from './features';

function tones(frequencies: number[], seconds = 1) {
  return Float32Array.from(
    { length: 22050 * seconds },
    (_, i) =>
      (frequencies.reduce((sum, f) => sum + Math.sin((2 * Math.PI * f * i) / 22050), 0) /
        frequencies.length) *
      0.3,
  );
}
describe('spectral features', () => {
  it('locates the C, E and G fundamentals in a sounding C major chord', () => {
    const frames = extractFeatures(tones([130.8128, 164.8138, 195.9977]), 22050).frames;
    const pitches = frames[8].chroma
      .map((energy, pitch) => ({ energy, pitch }))
      .sort((a, b) => b.energy - a.energy)
      .slice(0, 3)
      .map((v) => v.pitch)
      .sort((a, b) => a - b);
    expect(pitches).toEqual([0, 4, 7]);
  });
  it('keeps silence finite and produces a zero waveform', () => {
    const result = extractFeatures(new Float32Array(22050), 22050);
    expect(
      result.frames.every((frame) => frame.rms === 0 && frame.chroma.every((v) => v === 0)),
    ).toBe(true);
    expect(result.waveform.every((v) => v === 0)).toBe(true);
  });
  it('rejects invalid rates and nonfinite untrusted samples', () => {
    expect(() => extractFeatures(tones([440]), 0)).toThrow();
    expect(() => extractFeatures(new Float32Array([NaN, 0]), 22050)).toThrow();
  });
  it('extracts short clips and reports their true duration', () => {
    const result = extractFeatures(tones([440]).slice(0, 2205), 22050);
    expect(result.duration).toBeCloseTo(0.1);
    expect(result.frames.length).toBeGreaterThan(0);
    expect(result.frames.at(-1)!.time).toBeLessThan(0.1);
  });
});
