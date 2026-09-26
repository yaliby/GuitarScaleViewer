// @ts-nocheck
import { fft } from './fft';
export function modelFeatures(
  samples: Float32Array,
  sampleRate: number,
): { values: Float32Array; times: number[] } {
  if (sampleRate !== 22050) throw new Error('The research model requires 22050 Hz audio');
  if (!samples.length || samples.some((v) => !Number.isFinite(v)))
    throw new Error('Invalid model audio');
  const size = 2048,
    hop = 512,
    bins = size / 2 + 1,
    count = 1 + Math.floor((Math.max(size, samples.length) - size) / hop);
  const values = new Float32Array(count * 26),
    times: number[] = [];
  const window = Float32Array.from(
    { length: size },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)),
  );
  const real = new Float64Array(size),
    imag = new Float64Array(size),
    previous = new Float32Array(bins);
  const roundEven = (value: number) => {
    const floor = Math.floor(value);
    return value - floor === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(value);
  };
  const pitches = Array.from({ length: bins }, (_, i) => {
    const frequency = (i * sampleRate) / size;
    return frequency < 27.5
      ? -1
      : ((roundEven(69 + 12 * Math.log2(frequency / 440)) % 12) + 12) % 12;
  });
  for (let frame = 0; frame < count; frame++) {
    let power = 0;
    for (let i = 0; i < size; i++) {
      const sample = Math.fround((samples[frame * hop + i] ?? 0) * window[i]);
      real[i] = sample;
      imag[i] = 0;
      power += Math.fround(sample * sample);
    }
    fft(real, imag);
    const magnitude = Float32Array.from({ length: bins }, (_, i) => Math.hypot(real[i], imag[i]));
    const chroma = new Float32Array(12),
      bass = new Float32Array(12);
    let total = 0;
    for (let i = 0; i < bins; i++) {
      const energy = magnitude[i],
        pitch = pitches[i];
      total += energy;
      if (pitch >= 0) {
        chroma[pitch] += energy;
        if ((i * sampleRate) / size <= 330) bass[pitch] += energy;
      }
    }
    const chromaTotal = Math.max(
        chroma.reduce((a, b) => a + b, 0),
        1e-8,
      ),
      bassTotal = Math.max(
        bass.reduce((a, b) => a + b, 0),
        1e-8,
      );
    for (let i = 0; i < 12; i++) {
      values[frame * 26 + i] = chroma[i] / chromaTotal;
      values[frame * 26 + 12 + i] = bass[i] / bassTotal;
    }
    values[frame * 26 + 24] = Math.log1p(100 * Math.sqrt(power / size));
    let flux = 0;
    for (let i = 0; i < bins; i++) {
      const normalized = Math.fround(magnitude[i] / Math.max(total, 1e-8));
      if (frame > 0) flux += Math.max(normalized - previous[i], 0);
      previous[i] = normalized;
    }
    values[frame * 26 + 25] = flux;
    times.push((frame * hop + size / 2) / sampleRate);
  }
  return { values, times };
}
