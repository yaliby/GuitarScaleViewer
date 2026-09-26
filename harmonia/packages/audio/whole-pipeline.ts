// @ts-nocheck
import type { Analysis, AnalysisProfile, ChordSegment } from '../domain/types';
import type { AudioFeatures } from './features';
import { TemplateRecognizer, chordIdentity } from './recognizer';
import { estimateKey, estimateRhythm } from './rhythm';
import { harmonicNovelty } from './segmentation';
import { decodeWholeSequence } from './whole-decoder';
import type { WholePipelineTimings } from './whole-timings';
export const WHOLE_SONG_PIPELINE_VERSION = 'harmonia-whole-song-v1';
export const WHOLE_SONG_MODEL_VERSION = 'dsp-whole-song-v1';
/** Frozen engineering settings; no validation-based tuning or quality claim. */
export const WHOLE_SONG_SETTINGS = Object.freeze({ changePenalty: 0.12 });
export function analyzeWholeSongFeatures(
  features: AudioFeatures,
  fingerprint: string,
  profile: AnalysisProfile,
  progress?: (stage: string, value: number) => void,
  reportTimings?: (timings: WholePipelineTimings) => void,
): Analysis {
  const started = performance.now();
  if (
    !Number.isFinite(features.hopSeconds) ||
    features.hopSeconds <= 0 ||
    features.waveform.length > 900 ||
    features.waveform.some((value) => !Number.isFinite(value) || value < 0 || value > 1)
  )
    throw new Error('Invalid whole-song feature metadata');
  const novelty = harmonicNovelty(features);
  const boundaryMs = performance.now() - started;
  const recognizer = new TemplateRecognizer();
  const noChord = recognizer.templateCount;
  let inferenceMs = 0;
  const decoderStarted = performance.now();
  const decoded = decodeWholeSequence(
    features.frames.length,
    noChord + 1,
    (index, emissions) => {
      const scoringStarted = performance.now();
      recognizer.writeWholeEmissions(features.frames[index], emissions);
      inferenceMs += performance.now() - scoringStarted;
    },
    WHOLE_SONG_SETTINGS.changePenalty,
    (value) => progress?.('Decoding complete-song harmony', 0.65 + value * 0.25),
  );
  const temporalDecodingMs = Math.max(0, performance.now() - decoderStarted - inferenceMs);

  const timelineStarted = performance.now();
  const emissionMs = inferenceMs;
  const segments: ChordSegment[] = [];
  let previousKey: string | undefined;
  for (let i = 0; i < decoded.states.length; i++) {
    const scoringStarted = performance.now();
    const chosen = recognizer.wholeChoice(features.frames[i], decoded.states[i]);
    inferenceMs += performance.now() - scoringStarted;
    const key = chordIdentity(chosen.chord);
    const start = features.frames[i].time;
    const end = i + 1 < features.frames.length ? features.frames[i + 1].time : features.duration;
    const previous = segments.at(-1);
    if (previous && key === previousKey) {
      previous.score =
        (previous.score * (previous.end - previous.start) + chosen.score * (end - start)) /
        (end - previous.start);
      previous.end = end;
    } else {
      const alternativesStarted = performance.now();
      const choices = recognizer.scoreAll(features.frames[i]);
      inferenceMs += performance.now() - alternativesStarted;
      segments.push({
        id: `whole-segment-${segments.length}`,
        start,
        end,
        chord: chosen.chord,
        score: chosen.score,
        alternatives: choices
          .filter((choice) => chordIdentity(choice.chord) !== key)
          .sort((a, b) => b.score - a.score)
          .slice(0, 3),
      });
    }
    previousKey = key;
    if (i % 128 === 0)
      progress?.('Building complete-song timeline', 0.9 + (i / decoded.states.length) * 0.09);
  }
  const timelineMs = Math.max(0, performance.now() - timelineStarted - (inferenceMs - emissionMs));
  const rhythmStarted = performance.now();
  const rhythm = estimateRhythm(features);
  const key = estimateKey(features);
  const rhythmKeyMs = performance.now() - rhythmStarted;
  const analysis: Analysis = {
    id: `${fingerprint}:${WHOLE_SONG_MODEL_VERSION}:${WHOLE_SONG_PIPELINE_VERSION}:${profile}`,
    fingerprint,
    profile,
    modelVersion: WHOLE_SONG_MODEL_VERSION,
    pipelineVersion: WHOLE_SONG_PIPELINE_VERSION,
    duration: features.duration,
    segments,
    beats: rhythm.beats,
    tempo: rhythm.tempo,
    meter: null,
    key,
    waveform: features.waveform,
    boundaries: novelty.map((probability, i) => ({ time: features.frames[i].time, probability })),
    createdAt: new Date().toISOString(),
    calibration: 'uncalibrated',
    warnings: [
      'Whole-song DSP prototype: final Viterbi decoding uses the complete recording. Recognition accuracy has not been established.',
      'Scores and boundary values are uncalibrated acoustic similarities, not probabilities. Bass and extended chords require review.',
      'Global key and beats are provisional estimates. Global tuning correction, local keys, song sections, meter and downbeats are not implemented.',
      'All whole-song profiles use the same frozen DSP decoder; no pretrained recognition model is used.',
    ],
  };
  progress?.('Complete-song analysis ready', 1);
  reportTimings?.({
    inferenceMs,
    temporalDecodingMs,
    timelineMs,
    rhythmKeyMs,
    boundaryMs,
    pipelineMs: performance.now() - started,
  });
  return analysis;
}
