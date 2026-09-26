// @ts-nocheck
import { parseChord, chordPitchClasses } from '../domain/chord';
import type { Chord, ChordAlternative, PitchedChord } from '../domain/types';
import type { FeatureFrame } from './features';

export interface ChordRecognizer {
  readonly version: string;
  predict(frame: FeatureFrame): ChordAlternative[];
}
const qualities = [
  '',
  'm',
  '5',
  'sus2',
  'sus4',
  'dim',
  'aug',
  '6',
  'm6',
  '7',
  'maj7',
  'm7',
  'mMaj7',
  'm7b5',
  'dim7',
  'add9',
  'madd9',
  '9',
  'maj9',
  'm9',
  '11',
  '13',
  '7b9',
  '7#9',
  '7#11',
  '7b13',
  '13sus4',
];
const roots = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

/** Acoustic template baseline. Scores are similarities, not calibrated probabilities. */
export class TemplateRecognizer implements ChordRecognizer {
  readonly version = 'dsp-template-v1';
  private templates = roots.flatMap((root) =>
    qualities.map((quality) => {
      const chord = parseChord(root + quality) as PitchedChord;
      return { chord, pitches: chordPitchClasses(chord) };
    }),
  );

  get templateCount(): number {
    return this.templates.length;
  }

  predict(frame: FeatureFrame): ChordAlternative[] {
    return this.score(frame, false);
  }

  /** Stable template order, without top-k pruning, for the separate offline decoder. */
  scoreAll(frame: FeatureFrame): ChordAlternative[] {
    return this.score(frame, true);
  }

  /** Same frozen similarities, with no per-template chord allocations during Viterbi. */
  writeWholeEmissions(frame: FeatureFrame, output: Float64Array): void {
    if (output.length !== this.templateCount + 1) throw new Error('Invalid template emission row');
    output.fill(-Infinity);
    if (frame.rms < 0.002 || frame.chroma.every((v) => v === 0)) {
      output[this.templateCount] = 1;
      return;
    }
    this.templates.forEach(({ pitches }, index) => {
      output[index] = this.similarity(frame, pitches);
    });
  }

  /** Reconstruct only the decoded state's chord; alternatives are needed at boundaries. */
  wholeChoice(frame: FeatureFrame, state: number): ChordAlternative {
    if (state === this.templateCount) return { chord: { kind: 'none' }, score: 1 };
    const { chord, pitches } = this.templates[state];
    const bass = frame.bass.indexOf(Math.max(...frame.bass));
    const inversion = frame.bass[bass] > 0.58 && bass !== chord.root && pitches.includes(bass);
    return {
      chord: { ...chord, bass: inversion ? bass : null },
      score: this.similarity(frame, pitches),
    };
  }

  private similarity(frame: FeatureFrame, pitches: number[]): number {
    const energy =
      pitches.reduce((sum, pitch) => sum + frame.chroma[pitch], 0) / Math.sqrt(pitches.length);
    const absent = pitches.reduce((sum, pitch) => sum + (frame.chroma[pitch] < 0.12 ? 1 : 0), 0);
    return Math.max(
      0,
      Math.min(1, energy - absent * 0.05 - Math.max(0, pitches.length - 3) * 0.008),
    );
  }

  private score(frame: FeatureFrame, all: boolean): ChordAlternative[] {
    if (frame.rms < 0.002 || frame.chroma.every((v) => v === 0))
      return [{ chord: { kind: 'none' }, score: 1 }];
    const scores = this.templates.map(({ chord, pitches }) => {
      const energy =
        pitches.reduce((sum, pitch) => sum + frame.chroma[pitch], 0) / Math.sqrt(pitches.length);
      const absent = pitches.reduce((sum, pitch) => sum + (frame.chroma[pitch] < 0.12 ? 1 : 0), 0);
      const score = Math.max(
        0,
        Math.min(1, energy - absent * 0.05 - Math.max(0, pitches.length - 3) * 0.008),
      );
      return { chord, score };
    });
    // Keep the live/baseline path's original top-four allocation and bass work.
    const candidates = all ? scores : scores.sort((a, b) => b.score - a.score).slice(0, 4);
    const bass = frame.bass.indexOf(Math.max(...frame.bass));
    return candidates.map((candidate) => {
      const notes = chordPitchClasses(candidate.chord);
      const inversion =
        frame.bass[bass] > 0.58 && bass !== candidate.chord.root && notes.includes(bass);
      return { ...candidate, chord: { ...candidate.chord, bass: inversion ? bass : null } };
    });
  }
}

export function chordIdentity(chord: Chord): string {
  if (chord.kind !== 'chord') return chord.kind;
  return JSON.stringify([
    chord.root,
    chord.triad,
    chord.fifth,
    chord.seventh,
    chord.extensions,
    chord.alterations,
    chord.addedTones,
    chord.bass,
  ]);
}
