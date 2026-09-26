// @ts-nocheck
import { fft } from './fft';
import type { FeatureFrame } from './features';

export function normalize(values: number[]): number[] {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? values.map((value) => value / norm) : values;
}

/** Reusable frame kernel; no retained PCM or whole-recording state. */
export class PeakChromaKernel {
  private lastEnergy = 0;
  private readonly size = 4096;
  private readonly window = Float64Array.from(
    { length: 4096 },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / 4095),
  );
  private readonly real = new Float64Array(4096);
  private readonly imag = new Float64Array(4096);
  private readonly magnitude = new Float64Array(2048);
  frame(sampleAt: (index: number) => number, center: number, sampleRate: number): FeatureFrame {
    const { size, window, real, imag, magnitude } = this;
    let power = 0;
    for (let i = 0; i < size; i++) {
      const position = center + i - size / 2;
      const sample = sampleAt(position);
      real[i] = sample * window[i];
      imag[i] = 0;
      power += sample * sample;
    }
    fft(real, imag);
    let max = 0;
    for (let i = 0; i < magnitude.length; i++) {
      magnitude[i] = Math.hypot(real[i], imag[i]);
      max = Math.max(max, magnitude[i]);
    }
    const chroma = Array<number>(12).fill(0),
      bass = Array<number>(12).fill(0);
    for (let i = 2; i < magnitude.length - 1; i++) {
      if (
        magnitude[i] < max * 0.015 ||
        magnitude[i] <= magnitude[i - 1] ||
        magnitude[i] < magnitude[i + 1]
      )
        continue;
      const left = Math.log(magnitude[i - 1] + 1e-12),
        mid = Math.log(magnitude[i] + 1e-12),
        right = Math.log(magnitude[i + 1] + 1e-12);
      const offset = Math.max(
        -0.5,
        Math.min(0.5, (0.5 * (left - right)) / (left - 2 * mid + right)),
      );
      const frequency = ((i + offset) * sampleRate) / size;
      if (frequency < 45 || frequency > 2500) continue;
      const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
      const pitch = ((midi % 12) + 12) % 12;
      const energy = Math.sqrt(magnitude[i] / Math.max(max, 1e-12));
      chroma[pitch] += energy;
      if (frequency < 260) bass[pitch] += energy * Math.pow(65 / frequency, 0.75);
    }
    const rms = Math.sqrt(power / size);
    const result: FeatureFrame = {
      time: center / sampleRate,
      chroma: normalize(chroma),
      bass: normalize(bass),
      rms,
      onset: Math.max(0, rms - this.lastEnergy),
    };
    this.lastEnergy = rms;
    return result;
  }
}
