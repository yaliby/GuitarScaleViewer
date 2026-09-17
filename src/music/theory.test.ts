import { describe, expect, it } from 'vitest';
import { evaluateVoicingPlayability } from '../chords/playability';
import { getDiatonicTriads } from '../chords/scaleChordTheory';
import type { ChordVoicing } from '../chords/chordTypes';
import { buildScaleNotes, pitchClassForNoteLabel } from '../scaleSpell';

describe('scale spelling', () => {
  it('preserves the diatonic letters in C-sharp major', () => {
    expect(buildScaleNotes('C#', 'major').map((note) => note.label)).toEqual([
      'C#',
      'D#',
      'E#',
      'F#',
      'G#',
      'A#',
      'B#',
    ]);
  });

  it('spells the raised seventh of G-sharp harmonic minor as F-double-sharp', () => {
    expect(buildScaleNotes('G#', 'harmonic-minor').map((note) => note.label)).toEqual([
      'G#',
      'A#',
      'B',
      'C#',
      'D#',
      'E',
      'F##',
    ]);
  });

  it.each([
    ['E#', 5],
    ['B#', 0],
    ['F##', 7],
    ['Abb', 7],
    ['F♯♯', 7],
  ] as const)('parses %s as pitch class %i', (label, pitchClass) => {
    expect(pitchClassForNoteLabel(label)).toBe(pitchClass);
  });
});

describe('diatonic triads', () => {
  it('includes the diminished tonic of B Locrian', () => {
    const triads = getDiatonicTriads('B', 'locrian');

    expect(triads).toHaveLength(7);
    expect(triads[0]).toMatchObject({
      degree: 'i°',
      chordName: 'Bdim',
      quality: 'dim',
      chordPitchClasses: [11, 2, 5],
    });
  });

  it.each(['lydian', 'mixolydian'] as const)('labels the sixth triad of C %s as minor', (scaleType) => {
    expect(getDiatonicTriads('C', scaleType)[5]).toMatchObject({
      degree: 'vi',
      chordName: 'Am',
      quality: 'minor',
    });
  });
});

describe('voicing playability', () => {
  it('accepts a chord made entirely from open strings', () => {
    const openD: ChordVoicing = {
      id: 'open-d-open-tuning',
      chordName: 'D',
      baseFret: 1,
      frets: ['o', 'o', 'o', 'o', 'o', 'o'],
      difficulty: 'easy',
      tags: ['open'],
    };

    expect(evaluateVoicingPlayability(openD)).toMatchObject({
      playable: true,
      difficulty: 'easy',
    });
  });
});
