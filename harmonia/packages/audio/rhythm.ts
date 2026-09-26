// @ts-nocheck
import type { AudioFeatures } from './features';

export function estimateRhythm(features: AudioFeatures): { tempo: number | null; beats: number[] } {
  const { frames, hopSeconds, duration } = features;
  if (duration < 4) return { tempo: null, beats: [] };
  const onset = frames.map((f) => f.onset);
  const total = onset.reduce((sum, v) => sum + v * v, 0);
  if (total < 1e-6) return { tempo: null, beats: [] };
  let bestLag = 0,
    bestScore = 0;
  for (let lag = Math.floor(60 / 180 / hopSeconds); lag <= Math.ceil(60 / 55 / hopSeconds); lag++) {
    let score = 0;
    for (let i = lag; i < onset.length; i++) score += onset[i] * onset[i - lag];
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestScore / total < 0.08 || bestLag === 0) return { tempo: null, beats: [] };
  let phase = 0,
    strength = 0;
  for (let offset = 0; offset < bestLag; offset++) {
    let sum = 0;
    for (let i = offset; i < onset.length; i += bestLag) sum += onset[i];
    if (sum > strength) {
      strength = sum;
      phase = offset;
    }
  }
  const beats: number[] = [];
  for (let t = phase * hopSeconds; t < duration; t += bestLag * hopSeconds) beats.push(t);
  return { tempo: 60 / (bestLag * hopSeconds), beats };
}

export function estimateKey(
  features: AudioFeatures,
): { root: number; mode: 'major' | 'minor'; score: number } | null {
  const mean = Array<number>(12).fill(0);
  for (const frame of features.frames)
    frame.chroma.forEach((value, pitch) => {
      mean[pitch] += value;
    });
  if (mean.every((v) => v === 0)) return null;
  const profiles = {
    major: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
    minor: [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
  };
  const centered = (values: number[]) => {
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    return values.map((v) => v - avg);
  };
  const chroma = centered(mean),
    norm = Math.hypot(...chroma);
  let best: { root: number; mode: 'major' | 'minor'; score: number } = {
    root: 0,
    mode: 'major',
    score: 0,
  };
  for (const mode of ['major', 'minor'] as const)
    for (let root = 0; root < 12; root++) {
      const profile = centered(profiles[mode]);
      const score =
        chroma.reduce((sum, v, p) => sum + v * profile[(p - root + 12) % 12], 0) /
        (norm * Math.hypot(...profile) || 1);
      if (score > best.score) best = { root, mode, score };
    }
  return best;
}
