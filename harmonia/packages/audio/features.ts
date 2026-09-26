// @ts-nocheck
import { PeakChromaKernel } from './frame-kernel';
export { normalize } from './frame-kernel';

export const FEATURE_VERSION = 'peak-chroma-v1';
export interface FeatureFrame {
  time: number;
  chroma: number[];
  bass: number[];
  rms: number;
  onset: number;
}
export interface AudioFeatures {
  frames: FeatureFrame[];
  waveform: number[];
  duration: number;
  hopSeconds: number;
}
export function extractFeatures(
  samples: Float32Array,
  sampleRate: number,
  progress?: (value: number) => void,
): AudioFeatures {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000)
    throw new Error('Unsupported sample rate');
  if (samples.length === 0 || samples.length / sampleRate > 1200)
    throw new Error('Audio must be between one sample and 20 minutes');
  if (samples.some((sample) => !Number.isFinite(sample))) throw new Error('Invalid audio samples');
  const duration = samples.length / sampleRate;
  const hop = Math.max(1, Math.round(sampleRate * 0.02322));
  const kernel = new PeakChromaKernel();
  const frames: FeatureFrame[] = [];
  for (let center = 0; center < samples.length; center += hop) {
    frames.push(
      kernel.frame(
        (position) => (position >= 0 && position < samples.length ? samples[position] : 0),
        center,
        sampleRate,
      ),
    );
    if (frames.length % 64 === 0) progress?.(center / samples.length);
  }
  const waveform = Array.from({ length: Math.min(900, samples.length) }, (_, bin) => {
    const begin = Math.floor((bin * samples.length) / Math.min(900, samples.length));
    const end = Math.floor(((bin + 1) * samples.length) / Math.min(900, samples.length));
    let peak = 0;
    for (let i = begin; i < end; i++) peak = Math.max(peak, Math.abs(samples[i]));
    return Math.min(1, peak);
  });
  progress?.(1);
  return { frames, waveform, duration, hopSeconds: hop / sampleRate };
}
