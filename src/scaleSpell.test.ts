import { describe, expect, it } from 'vitest';
import type { ScaleType } from './scaleDataProvider';
import {
  SCALE_DEFINITIONS,
  SCALE_DEGREE_LABELS,
  buildScaleNotes,
  labelForPitchClass,
  parseRoot,
  pitchClassForNoteLabel,
  pitchClassSet,
  relativeKey,
} from './scaleSpell';

const ALL_SCALE_TYPES = Object.keys(SCALE_DEFINITIONS) as ScaleType[];
const CHROMATIC_ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

describe('parseRoot', () => {
  it('accepts naturals, sharps and flats in either case', () => {
    expect(parseRoot('C')).toEqual({ letter: 'C', pitchClass: 0, key: 'C' });
    expect(parseRoot('f#')).toEqual({ letter: 'F', pitchClass: 6, key: 'F#' });
    expect(parseRoot(' Bb ')).toEqual({ letter: 'B', pitchClass: 10, key: 'Bb' });
  });

  it('throws on a root outside A-G', () => {
    expect(() => parseRoot('H')).toThrow(/Invalid root/);
    expect(() => parseRoot('C##')).toThrow(/Invalid root/);
    expect(() => parseRoot('')).toThrow(/Invalid root/);
  });
});

describe('buildScaleNotes', () => {
  it('spells C major with no accidentals, one per letter', () => {
    expect(buildScaleNotes('C', 'major').map((n) => n.label)).toEqual([
      'C', 'D', 'E', 'F', 'G', 'A', 'B',
    ]);
  });

  it('spells sharp and flat keys with their conventional letters', () => {
    expect(buildScaleNotes('G', 'major').map((n) => n.label)).toEqual([
      'G', 'A', 'B', 'C', 'D', 'E', 'F#',
    ]);
    expect(buildScaleNotes('F', 'major').map((n) => n.label)).toEqual([
      'F', 'G', 'A', 'Bb', 'C', 'D', 'E',
    ]);
    expect(buildScaleNotes('A', 'minor').map((n) => n.label)).toEqual([
      'A', 'B', 'C', 'D', 'E', 'F', 'G',
    ]);
  });

  it('raises the seventh in harmonic minor', () => {
    expect(buildScaleNotes('A', 'harmonic-minor').map((n) => n.label)).toEqual([
      'A', 'B', 'C', 'D', 'E', 'F', 'G#',
    ]);
  });

  it('marks exactly the first degree as the root', () => {
    for (const scaleType of ALL_SCALE_TYPES) {
      const notes = buildScaleNotes('D', scaleType);
      expect(notes.filter((n) => n.isRoot)).toHaveLength(1);
      expect(notes[0]?.isRoot).toBe(true);
    }
  });

  it('produces distinct pitch classes matching the interval set for every root and scale', () => {
    for (const scaleType of ALL_SCALE_TYPES) {
      const { intervals } = SCALE_DEFINITIONS[scaleType];
      for (const root of CHROMATIC_ROOTS) {
        const notes = buildScaleNotes(root, scaleType);
        expect(notes).toHaveLength(intervals.length);
        const rootPc = parseRoot(root).pitchClass;
        expect(notes.map((n) => n.pitchClass)).toEqual(
          intervals.map((i) => (rootPc + i) % 12),
        );
        for (const note of notes) {
          expect(note.label).not.toBe('');
        }
      }
    }
  });

  it('keeps a degree label for every note of every scale', () => {
    for (const scaleType of ALL_SCALE_TYPES) {
      expect(SCALE_DEGREE_LABELS[scaleType]).toHaveLength(
        SCALE_DEFINITIONS[scaleType].intervals.length,
      );
    }
  });
});

describe('pitchClassSet / labelForPitchClass', () => {
  it('collapses the blues scale to its six distinct pitch classes', () => {
    expect(pitchClassSet(buildScaleNotes('A', 'blues')).size).toBe(6);
  });

  it('returns the label and root flag for an in-scale pitch class', () => {
    const notes = buildScaleNotes('G', 'major');
    expect(labelForPitchClass(notes, 7)).toEqual({ label: 'G', isRoot: true });
    expect(labelForPitchClass(notes, 6)).toEqual({ label: 'F#', isRoot: false });
  });

  it('returns null for a pitch class outside the scale', () => {
    expect(labelForPitchClass(buildScaleNotes('C', 'major'), 1)).toBeNull();
  });
});

describe('pitchClassForNoteLabel', () => {
  it('round-trips every label produced by buildScaleNotes', () => {
    for (const scaleType of ALL_SCALE_TYPES) {
      for (const note of buildScaleNotes('Eb', scaleType)) {
        expect(pitchClassForNoteLabel(note.label)).toBe(note.pitchClass);
      }
    }
  });

  it('returns null for labels that are not notes', () => {
    expect(pitchClassForNoteLabel('H')).toBeNull();
    expect(pitchClassForNoteLabel('')).toBeNull();
    expect(pitchClassForNoteLabel('C#m')).toBeNull();
  });
});

/**
 * Cloud and library keys now arrive spelled the way the key is written, so a flat root has to
 * spell its scale with flats rather than fall back to the chromatic sharp names.
 */
describe('flat key spelling', () => {
  it('spells Ab major with flats', () => {
    expect(buildScaleNotes('Ab', 'major').map((n) => n.label)).toEqual([
      'Ab', 'Bb', 'C', 'Db', 'Eb', 'F', 'G',
    ]);
  });

  it('spells Bb minor with flats', () => {
    expect(buildScaleNotes('Bb', 'minor').map((n) => n.label)).toEqual([
      'Bb', 'C', 'Db', 'Eb', 'F', 'Gb', 'Ab',
    ]);
  });

  it('spells Db major with flats', () => {
    expect(buildScaleNotes('Db', 'major').map((n) => n.label)).toEqual([
      'Db', 'Eb', 'F', 'Gb', 'Ab', 'Bb', 'C',
    ]);
  });
});

describe('relativeKey', () => {
  it('maps a major key to its relative minor and back', () => {
    expect(relativeKey('C', 'major')).toEqual({ root: 'A', scaleType: 'minor' });
    expect(relativeKey('A', 'minor')).toEqual({ root: 'C', scaleType: 'major' });
    expect(relativeKey('G', 'major')).toEqual({ root: 'E', scaleType: 'minor' });
    expect(relativeKey('E', 'minor')).toEqual({ root: 'G', scaleType: 'major' });
  });

  it('spells the result the way the key is actually written', () => {
    // pc 3 is Eb major but C minor's relative; pc 6 is F# minor but A major's relative.
    expect(relativeKey('C', 'minor')).toEqual({ root: 'Eb', scaleType: 'major' });
    expect(relativeKey('A', 'major')).toEqual({ root: 'F#', scaleType: 'minor' });
    expect(relativeKey('Eb', 'major')).toEqual({ root: 'C', scaleType: 'minor' });
    expect(relativeKey('Db', 'major')).toEqual({ root: 'Bb', scaleType: 'minor' });
  });

  it('round-trips every chromatic root in both directions', () => {
    for (const root of CHROMATIC_ROOTS) {
      for (const type of ['major', 'minor'] as const) {
        const once = relativeKey(root, type);
        expect(once).not.toBeNull();
        const back = relativeKey(once!.root, once!.scaleType);
        expect(back).not.toBeNull();
        expect(back!.scaleType).toBe(type);
        expect(pitchClassForNoteLabel(back!.root)).toBe(pitchClassForNoteLabel(root));
      }
    }
  });

  it('keeps the same seven pitch classes, which is the whole point', () => {
    for (const root of CHROMATIC_ROOTS) {
      for (const type of ['major', 'minor'] as const) {
        const rel = relativeKey(root, type)!;
        expect([...pitchClassSet(buildScaleNotes(rel.root, rel.scaleType))].sort()).toEqual(
          [...pitchClassSet(buildScaleNotes(root, type))].sort(),
        );
      }
    }
  });

  it('returns null for scale types that have no relative pair', () => {
    for (const type of ALL_SCALE_TYPES) {
      if (type === 'major' || type === 'minor') {
        continue;
      }
      expect(relativeKey('C', type)).toBeNull();
    }
  });

  it('returns null for an unparseable root', () => {
    expect(relativeKey('H', 'major')).toBeNull();
    expect(relativeKey('', 'minor')).toBeNull();
  });
});
