// @ts-nocheck
import type { Analysis, AnalysisProfile } from '../domain/types';
import { chordPitchClasses, fromHarte } from '../domain/chord';
import { validateAnalysis } from '../domain/timeline';
import { estimateKey } from './rhythm';

export const NATIVE_MODEL_VERSION = 'lv-chordia-1.1.0-submission-native-v4';
export const NATIVE_PIPELINE_VERSION = 'harmonia-whole-song-lv-v4';
/** The beat tracker whose bars v4 decodes against; anything else is the degraded fallback. */
export const NATIVE_BEAT_TRACKER = 'beat-this-final0';
export interface NativeHarmonyResult {
  schemaVersion: number;
  sampleRate: number;
  sampleCount: number;
  duration: number;
  modelVersion: string;
  segments: { start: number; end: number; label: string; score: number | null }[];
  beats: number[];
  downbeats?: number[];
  tempo: number | null;
  tempoSteady?: boolean;
  meter?: number | null;
  rhythmSource?: string;
  tuningCents?: number | null;
  warnings: string[];
  timings: {
    setupSeconds: number;
    cqtSeconds: number;
    inferenceSeconds: number;
    decodeSeconds: number;
    beatSeconds: number;
    tuningSeconds?: number;
    hmmSeconds?: number;
    refinementSeconds?: number;
    totalSeconds: number;
  };
}
export interface NativeWholeMetadata {
  fingerprint: string;
  profile: AnalysisProfile;
  samples: number;
  waveform: number[];
}
export function assembleNativeWholeSong(value: unknown, metadata: NativeWholeMetadata): Analysis {
  const r = value as NativeHarmonyResult;
  const duration = metadata.samples / 22050;
  if (
    !r ||
    r.schemaVersion !== 1 ||
    r.modelVersion !== NATIVE_MODEL_VERSION ||
    r.sampleCount !== metadata.samples ||
    r.sampleRate !== 22050 ||
    Math.abs(r.duration - duration) > 1e-6 ||
    !Number.isFinite(r.duration) ||
    !Array.isArray(r.segments) ||
    !r.segments.length ||
    r.segments.length > 20000 ||
    !Array.isArray(r.beats) ||
    r.beats.length > 10000 ||
    (r.downbeats !== undefined && (!Array.isArray(r.downbeats) || r.downbeats.length > r.beats.length)) ||
    !Array.isArray(r.warnings) ||
    r.warnings.length > 30
  )
    throw new Error('Invalid complete-song recognition result');
  const segments = r.segments.map((s, i) => {
    if (
      !Number.isFinite(s.start) ||
      !Number.isFinite(s.end) ||
      s.end <= s.start ||
      (i === 0 ? s.start !== 0 : s.start !== r.segments[i - 1].end) ||
      typeof s.label !== 'string' ||
      s.label.length > 120 ||
      (s.score !== null && (!Number.isFinite(s.score) || s.score < 0 || s.score > 1))
    )
      throw new Error('Invalid native harmonic region');
    return {
      id: `lv-region-${i}`,
      start: s.start,
      end: s.end,
      chord: fromHarte(s.label),
      score: s.score ?? 0,
      alternatives: [],
    };
  });
  if (Math.abs(segments.at(-1)!.end - duration) > 1e-6)
    throw new Error('Incomplete native timeline');
  // Native JSON and JS division can differ by an ULP at EOF. The adapter
  // already verifies coverage above; publish the exact sample-count endpoint
  // so strict domain bounds cannot reject an otherwise complete recording.
  segments.at(-1)!.end = duration;
  const chroma = Array<number>(12).fill(0);
  for (const s of segments)
    for (const pitch of chordPitchClasses(s.chord)) chroma[pitch] += (s.end - s.start) / duration;
  const key = estimateKey({
    frames: [{ time: 0, chroma, bass: Array(12).fill(0), rms: 1, onset: 0 }],
    hopSeconds: duration,
    duration,
    waveform: [],
  });
  const analysis: Analysis = {
    id: `${metadata.fingerprint}:${NATIVE_MODEL_VERSION}:${NATIVE_PIPELINE_VERSION}:${metadata.profile}`,
    fingerprint: metadata.fingerprint,
    profile: metadata.profile,
    modelVersion: NATIVE_MODEL_VERSION,
    pipelineVersion: NATIVE_PIPELINE_VERSION,
    duration,
    segments,
    beats: r.beats,
    tempo: r.tempo,
    meter: Number.isInteger(r.meter) && r.meter > 0 ? r.meter : null,
    key,
    waveform: metadata.waveform,
    boundaries: [],
    createdAt: new Date().toISOString(),
    calibration: 'uncalibrated',
    warnings: [
      'LV-Chordia full-song CPU ensemble, tuned to the recording and decoded beat by beat against Beat This! bars. Component support is uncalibrated, not whole-chord probability.',
      'Global key is a duration-weighted harmonic summary. Modulation labels are not established.',
      ...r.warnings.filter((w) => typeof w === 'string' && w.length < 1000),
    ],
    grid: {
      downbeats: Array.isArray(r.downbeats) ? r.downbeats : [],
      steady: r.tempoSteady === true,
      source: typeof r.rhythmSource === 'string' && r.rhythmSource ? r.rhythmSource : 'unknown',
    },
    tuningCents:
      typeof r.tuningCents === 'number' && Number.isFinite(r.tuningCents) ? r.tuningCents : null,
  };
  validateAnalysis(analysis);
  return analysis;
}
