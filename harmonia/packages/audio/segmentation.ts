// @ts-nocheck
import { normalizeChord, validateChord } from '../domain/chord';
import type { Chord, ChordAlternative, ChordSegment } from '../domain/types';
import type { AudioFeatures } from './features';

export interface BoundaryCandidate {
  frameIndex: number;
  time: number;
  score: number;
}
export interface SegmentationResult {
  segments: ChordSegment[];
  candidates: BoundaryCandidate[];
  candidateSegments: { start: number; end: number }[];
  insertedCuts: number[];
  removedCuts: number[];
  timingMoves: { from: number; to: number }[];
  calibration: 'uncalibrated';
}

/** Offline candidate only. Changing these values requires a new comparison protocol. */
export const REFINEMENT_SETTINGS = Object.freeze({
  candidateThreshold: 0.35,
  sustainedSeconds: 0.06,
  sustainedMargin: 0.05,
  timingSeconds: 0.05,
  timingFrames: 8,
});
function requireInput(condition: boolean): asserts condition {
  if (!condition) throw new Error('Invalid segmentation evidence');
}
function validateFeatures(features: AudioFeatures): void {
  const { frames, duration } = features;
  requireInput(
    Number.isFinite(duration) &&
      duration > 0 &&
      duration <= 1200 &&
      frames.length > 0 &&
      frames.length <= 60000 &&
      frames[0].time === 0,
  );
  frames.forEach((frame, index) => {
    requireInput(
      Number.isFinite(frame.time) &&
        frame.time < duration &&
        (index === 0 || frame.time > frames[index - 1].time) &&
        Number.isFinite(frame.rms) &&
        frame.rms >= 0 &&
        Number.isFinite(frame.onset) &&
        frame.onset >= 0,
    );
    for (const vector of [frame.chroma, frame.bass])
      requireInput(
        vector.length === 12 &&
          vector.every((value) => Number.isFinite(value) && value >= 0 && value <= 1 + 1e-12),
      );
  });
}

/** Same acoustic evidence as the existing DSP detector; deliberately not probabilities. */
export function harmonicNovelty(features: AudioFeatures): number[] {
  validateFeatures(features);
  const { frames } = features;
  return frames.map((_, index) => {
    if (index === 0) return 0;
    const before = frames[Math.max(0, index - 2)],
      after = frames[Math.min(frames.length - 1, index + 2)];
    if (before.rms < 0.002 && after.rms < 0.002) return 0;
    if (before.rms < 0.002 !== after.rms < 0.002) return 0.95;
    return Math.max(
      0,
      Math.min(1, (1 - before.chroma.reduce((sum, v, i) => sum + v * after.chroma[i], 0)) * 2.4),
    );
  });
}

function canonicalKey(chord: Chord): string {
  if (chord.kind !== 'chord') return chord.kind;
  return JSON.stringify([
    chord.root,
    chord.triad,
    chord.fifth,
    chord.seventh,
    chord.extensions,
    chord.alterations,
    chord.addedTones,
    chord.omittedTones,
    chord.bass,
  ]);
}
interface Evidence {
  chord: Chord;
  key: string;
  score: number;
  margin: number;
}
function harmonicEvidence(
  predictions: readonly (readonly ChordAlternative[])[],
  count: number,
): Evidence[] {
  requireInput(predictions.length === count);
  return predictions.map((choices) => {
    requireInput(choices.length > 0 && choices.length <= 8);
    const normalized = choices.map((choice, index) => {
      requireInput(
        Number.isFinite(choice.score) &&
          choice.score >= 0 &&
          choice.score <= 1 &&
          (index === 0 || choice.score <= choices[index - 1].score),
      );
      const chord = choice.chord;
      // Bound nested records before domain validation/normalization allocates or sorts.
      if (chord.kind === 'chord')
        for (const field of [
          chord.extensions,
          chord.alterations,
          chord.addedTones,
          chord.omittedTones,
        ]) {
          requireInput(Array.isArray(field) && field.length <= 12);
        }
      return normalizeChord(validateChord(chord));
    });
    return {
      chord: normalized[0],
      key: canonicalKey(normalized[0]),
      score: choices[0].score,
      margin: choices[0].score - (choices[1]?.score ?? 0),
    };
  });
}

function proposals(features: AudioFeatures, novelty: readonly number[]): BoundaryCandidate[] {
  const candidates: BoundaryCandidate[] = [];
  for (let first = 0; first < novelty.length;) {
    let end = first + 1;
    while (end < novelty.length && novelty[end] === novelty[first]) end++;
    if (
      first > 0 &&
      novelty[first] >= REFINEMENT_SETTINGS.candidateThreshold &&
      novelty[first] > novelty[first - 1] &&
      (end === novelty.length || novelty[first] > novelty[end])
    ) {
      candidates.push({
        frameIndex: first,
        time: features.frames[first].time,
        score: novelty[first],
      });
    }
    first = end;
  }
  return candidates;
}
function splitCuts(evidence: Evidence[], time: (index: number) => number): number[] {
  const cuts: number[] = [];
  let previousSupported: string | undefined;
  for (let begin = 0; begin < evidence.length;) {
    let end = begin + 1;
    while (end < evidence.length && evidence[end].key === evidence[begin].key) end++;
    const duration = time(end) - time(begin);
    let margin = 0;
    for (let i = begin; i < end; i++) margin += evidence[i].margin * (time(i + 1) - time(i));
    if (
      duration + 1e-12 >= REFINEMENT_SETTINGS.sustainedSeconds &&
      margin / duration + 1e-12 >= REFINEMENT_SETTINGS.sustainedMargin
    ) {
      if (previousSupported !== undefined && previousSupported !== evidence[begin].key)
        cuts.push(begin);
      previousSupported = evidence[begin].key;
    }
    begin = end;
  }
  return cuts;
}
interface Vote {
  key: string;
  chord: Chord;
  weight: number;
}
function votesFor(
  begin: number,
  end: number,
  evidence: Evidence[],
  time: (index: number) => number,
): Vote[] {
  const votes = new Map<string, Vote>();
  for (let i = begin; i < end; i++) {
    const frame = evidence[i],
      weight = frame.score * (time(i + 1) - time(i));
    const vote = votes.get(frame.key);
    if (vote) vote.weight += weight;
    else votes.set(frame.key, { key: frame.key, chord: frame.chord, weight });
  }
  // Keep only four ranked items; no sort of an unbounded collection of labels.
  const ranked: Vote[] = [];
  for (const vote of votes.values()) {
    const place = ranked.findIndex((other) => vote.weight > other.weight);
    ranked.splice(place < 0 ? ranked.length : place, 0, vote);
    if (ranked.length > 4) ranked.pop();
  }
  return ranked;
}
function refineTimes(
  cuts: number[],
  time: (index: number) => number,
  novelty: readonly number[],
): number[] {
  return cuts.map((frame, position) => {
    if (position === 0 || position === cuts.length - 1) return time(frame);
    const original = time(frame),
      lower = (time(cuts[position - 1]) + original) / 2,
      upper = (original + time(cuts[position + 1])) / 2;
    let best = frame;
    for (
      let i = Math.max(1, frame - REFINEMENT_SETTINGS.timingFrames);
      i <= Math.min(novelty.length - 1, frame + REFINEMENT_SETTINGS.timingFrames);
      i++
    ) {
      const distance = Math.abs(time(i) - original),
        bestDistance = Math.abs(time(best) - original);
      if (
        distance > REFINEMENT_SETTINGS.timingSeconds + 1e-12 ||
        time(i) <= lower ||
        time(i) >= upper ||
        novelty[i] <= novelty[frame]
      )
        continue;
      if (
        novelty[i] > novelty[best] ||
        (novelty[i] === novelty[best] &&
          (distance < bestDistance - 1e-12 ||
            (Math.abs(distance - bestDistance) <= 1e-12 && i < best)))
      )
        best = i;
    }
    return time(best);
  });
}

/** Pure offline comparison strategy. Production weighted stabilization is unchanged. */
export function refineSegmentation(
  features: AudioFeatures,
  predictions: readonly (readonly ChordAlternative[])[],
  novelty: readonly number[] = harmonicNovelty(features),
  options: { refineTiming?: boolean } = {},
): SegmentationResult {
  validateFeatures(features);
  requireInput(
    novelty.length === features.frames.length &&
      novelty.every((v) => Number.isFinite(v) && v >= 0 && v <= 1),
  );
  const evidence = harmonicEvidence(predictions, features.frames.length);
  const time = (index: number) =>
    index === evidence.length ? features.duration : features.frames[index].time;
  const candidates = proposals(features, novelty);
  const proposedCuts = [0, ...candidates.map((candidate) => candidate.frameIndex), evidence.length];
  const candidateSegments = proposedCuts
    .slice(0, -1)
    .map((frame, i) => ({ start: time(frame), end: time(proposedCuts[i + 1]) }));
  const proposed = new Set(proposedCuts);
  const insertedCuts = splitCuts(evidence, time).filter((frame) => !proposed.has(frame));
  const all = new Set([...proposedCuts, ...insertedCuts]);
  // Frame-order traversal gives a linear ordered union, without sorting N cuts.
  const cuts = Array.from({ length: evidence.length + 1 }, (_, i) => i).filter((i) => all.has(i));
  const merged: { begin: number; end: number; key: string }[] = [];
  const removedCuts: number[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const begin = cuts[i],
      end = cuts[i + 1],
      key = votesFor(begin, end, evidence, time)[0].key;
    const previous = merged.at(-1);
    if (previous?.key === key) {
      previous.end = end;
      removedCuts.push(begin);
    } else merged.push({ begin, end, key });
  }
  const finalCuts = [...merged.map((interval) => interval.begin), evidence.length];
  const times =
    options.refineTiming === false ? finalCuts.map(time) : refineTimes(finalCuts, time, novelty);
  const timingMoves = finalCuts.flatMap((frame, i) =>
    time(frame) === times[i] ? [] : [{ from: time(frame), to: times[i] }],
  );
  const segments = merged.map(({ begin, end }, i): ChordSegment => {
    const votes = votesFor(begin, end, evidence, time),
      duration = time(end) - time(begin);
    const alternatives = votes.map((vote) => ({
      chord: normalizeChord(vote.chord),
      score: Math.min(1, vote.weight / duration),
    }));
    requireInput(times[i + 1] > times[i]);
    return {
      id: `refined-${i}`,
      start: times[i],
      end: times[i + 1],
      ...alternatives[0],
      alternatives: alternatives.slice(1),
    };
  });
  return {
    segments,
    candidates,
    candidateSegments,
    insertedCuts,
    removedCuts,
    timingMoves,
    calibration: 'uncalibrated',
  };
}
