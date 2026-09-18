import { describe, expect, it } from 'vitest';
import type { ScaleType } from '../scaleDataProvider';
import { getDiatonicTriads, isHeptatonicScaleType, scaleNotesForChordContext } from './scaleChordTheory';

const HEPTATONIC: ScaleType[] = [
  'major', 'minor', 'harmonic-minor', 'melodic-minor',
  'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian',
];
const NON_HEPTATONIC: ScaleType[] = ['pentatonic-major', 'pentatonic-minor', 'blues'];

describe('isHeptatonicScaleType', () => {
  it('separates the seven-note modes from the pentatonic/blues scales', () => {
    for (const s of HEPTATONIC) {
      expect(isHeptatonicScaleType(s)).toBe(true);
    }
    for (const s of NON_HEPTATONIC) {
      expect(isHeptatonicScaleType(s)).toBe(false);
    }
  });
});

describe('getDiatonicTriads', () => {
  it('builds the textbook triads of C major', () => {
    const triads = getDiatonicTriads('C', 'major');
    expect(triads.map((t) => t.chordName)).toEqual([
      'C', 'Dm', 'Em', 'F', 'G', 'Am', 'Bdim',
    ]);
    expect(triads.map((t) => t.degree)).toEqual([
      'I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°',
    ]);
  });

  it('builds the textbook triads of A natural minor', () => {
    expect(getDiatonicTriads('A', 'minor').map((t) => t.chordName)).toEqual([
      'Am', 'Bdim', 'C', 'Dm', 'Em', 'F', 'G',
    ]);
  });

  it('produces the augmented III and major V of harmonic minor', () => {
    const triads = getDiatonicTriads('A', 'harmonic-minor');
    expect(triads[2]?.chordName).toBe('Caug');
    expect(triads[2]?.quality).toBe('aug');
    expect(triads[4]?.chordName).toBe('E');
    expect(triads[4]?.quality).toBe('major');
  });

  it('returns nothing for scales that have no diatonic triads', () => {
    for (const s of NON_HEPTATONIC) {
      expect(getDiatonicTriads('C', s)).toEqual([]);
    }
  });

  it('gives every triad three distinct pitch classes with a matching root', () => {
    for (const scaleType of HEPTATONIC) {
      for (const root of ['C', 'F#', 'Bb']) {
        const triads = getDiatonicTriads(root, scaleType);
        expect(triads).toHaveLength(7);
        for (const triad of triads) {
          expect(new Set(triad.chordPitchClasses).size).toBe(3);
          expect(triad.chordPitchClasses).toContain(triad.rootPitchClass);
          expect(triad.chordLabels).toHaveLength(3);
          expect(triad.chordName).not.toBe('');
        }
      }
    }
  });
});

describe('scaleNotesForChordContext', () => {
  it('returns the seven notes of a heptatonic scale', () => {
    expect(scaleNotesForChordContext('D', 'dorian').map((n) => n.label)).toEqual([
      'D', 'E', 'F', 'G', 'A', 'B', 'C',
    ]);
  });

  it('still returns the notes of a pentatonic scale', () => {
    expect(scaleNotesForChordContext('A', 'pentatonic-minor')).toHaveLength(5);
  });
});
