// @ts-nocheck
import type { Analysis, AnalysisProfile, ChordAlternative, ChordSegment } from '../domain/types';
import { extractFeatures, type AudioFeatures } from './features';
import { chordIdentity, TemplateRecognizer, type ChordRecognizer } from './recognizer';
import { estimateKey, estimateRhythm } from './rhythm';

import { PIPELINE_VERSION } from './versions';
export { PIPELINE_VERSION } from './versions';
export interface BoundaryDetector {
  detect(features: AudioFeatures): { time: number; probability: number }[];
}
export class NoveltyBoundaryDetector implements BoundaryDetector {
  detect(features: AudioFeatures) {
    const { frames } = features;
    return frames.map((frame, i) => {
      if (i === 0) return { time: 0, probability: 0 };
      const before = frames[Math.max(0, i - 2)],
        after = frames[Math.min(frames.length - 1, i + 2)];
      if (before.rms < 0.002 && after.rms < 0.002) return { time: frame.time, probability: 0 };
      const cosine = before.chroma.reduce((s, v, j) => s + v * after.chroma[j], 0);
      const silenceChange = before.rms < 0.002 !== after.rms < 0.002;
      return {
        time: frame.time,
        probability: silenceChange ? 0.95 : Math.max(0, Math.min(1, (1 - cosine) * 2.4)),
      };
    });
  }
}
export function analyzeAudio(
  samples: Float32Array,
  sampleRate: number,
  fingerprint: string,
  profile: AnalysisProfile,
  progress?: (stage: string, value: number) => void,
  recognizer: ChordRecognizer = new TemplateRecognizer(),
): Analysis {
  progress?.('Extracting harmonic features', 0);
  const features = extractFeatures(samples, sampleRate, (value) =>
    progress?.('Extracting harmonic features', value * 0.65),
  );
  return analyzeFeatures(features, fingerprint, profile, progress, recognizer);
}
export function analyzeFeatures(
  features: AudioFeatures,
  fingerprint: string,
  profile: AnalysisProfile,
  progress?: (stage: string, value: number) => void,
  recognizer: ChordRecognizer = new TemplateRecognizer(),
): Analysis {
  const boundaries = new NoveltyBoundaryDetector().detect(features);
  const predictions: ChordAlternative[][] = [];
  for (let i = 0; i < features.frames.length; i++) {
    predictions.push(recognizer.predict(features.frames[i]));
    if (i % 128 === 0)
      progress?.('Recognizing chords and bass', 0.65 + (0.3 * i) / features.frames.length);
  }
  // Every frame remains eligible for a transition, even when novelty missed it.
  // Majority stabilization merges short false boundaries without a progression prior.
  const radius = profile === 'fast' ? 2 : 4;
  const smoothed = predictions.map((choices, index) => {
    const votes = new Map<string, { weight: number; candidate: ChordAlternative }>();
    for (
      let j = Math.max(0, index - radius);
      j <= Math.min(predictions.length - 1, index + radius);
      j++
    ) {
      const candidate = predictions[j][0],
        key = chordIdentity(candidate.chord);
      const existing = votes.get(key);
      votes.set(key, { candidate, weight: (existing?.weight ?? 0) + candidate.score });
    }
    return [...votes.values()].sort((a, b) => b.weight - a.weight)[0]?.candidate ?? choices[0];
  });
  const segments: ChordSegment[] = [];
  for (let i = 0; i < smoothed.length; i++) {
    const chosen = smoothed[i],
      previous = segments.at(-1);
    const end = i + 1 < features.frames.length ? features.frames[i + 1].time : features.duration;
    if (previous && chordIdentity(previous.chord) === chordIdentity(chosen.chord))
      previous.end = end;
    else
      segments.push({
        id: `segment-${segments.length}`,
        start: features.frames[i].time,
        end,
        chord: chosen.chord,
        score: chosen.score,
        alternatives: predictions[i]
          .filter((c) => chordIdentity(c.chord) !== chordIdentity(chosen.chord))
          .slice(0, 3),
      });
  }
  const rhythm = estimateRhythm(features);
  progress?.('Building the harmonic timeline', 1);
  return {
    id: `${fingerprint}:${recognizer.version}:${PIPELINE_VERSION}:${profile}`,
    fingerprint,
    profile,
    modelVersion: recognizer.version,
    pipelineVersion: PIPELINE_VERSION,
    duration: features.duration,
    segments,
    beats: rhythm.beats,
    tempo: rhythm.tempo,
    meter: null,
    key: estimateKey(features),
    waveform: features.waveform,
    boundaries,
    createdAt: new Date().toISOString(),
    calibration: 'uncalibrated',
    warnings: [
      'DSP baseline: similarity scores are not calibrated confidence. Dense mixes and extended chords need review.',
      'Beat and key estimates are provisional. Meter and downbeats are not inferred.',
      ...(profile === 'accurate'
        ? ['Maximum accuracy model is not installed; this result uses the DSP baseline.']
        : []),
    ],
  };
}
