// @ts-nocheck
import { describe, expect, it } from 'vitest';
import type { PitchedChord, Triad } from './types';

import {
  chordPitchClasses,
  equalChords,
  formatChord,
  fromHarte,
  normalizeChord,
  parseChord,
  pitchName,
  toHarte,
  transposeChord,
  validateChord,
} from './chord';

describe('canonical chord boundaries', () => {
  it('accepts and losslessly exports all 301 native submission dictionary states', () => {
    // Pinned LV-Chordia 1.1.0 submission dictionary: 25 qualities × 12 roots + N.
    const roots = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
    const qualities = [
      'min/b7',
      'min/2',
      'maj/b7',
      'maj/2',
      'sus4(b7)',
      'sus2',
      'sus4',
      '13',
      '11',
      'min9',
      '9',
      'maj9',
      'dim7',
      'hdim7',
      'min7',
      '7',
      'maj7',
      'min/5',
      'min/b3',
      'maj/5',
      'maj/3',
      'dim',
      'aug',
      'min',
      'maj',
    ];
    const labels = [
      'N',
      ...roots.flatMap((root) => qualities.map((quality) => `${root}:${quality}`)),
    ];
    expect(labels).toHaveLength(301);
    for (const label of labels) {
      const chord = fromHarte(label);
      expect(validateChord(chord), label).toEqual(chord);
      expect(equalChords(fromHarte(toHarte(chord)), chord), label).toBe(true);
    }
  });

  it.each([
    ['C:11', [9, 11], [0, 2, 4, 5, 7, 10]],
    ['C:13', [9, 11, 13], [0, 2, 4, 5, 7, 9, 10]],
  ] as const)('preserves every native extension and pitch in %s', (label, extensions, pitches) => {
    const chord = fromHarte(label);
    expect(chord).toMatchObject({ root: 0, triad: 'major', seventh: 'minor', extensions });
    expect(chordPitchClasses(chord)).toEqual(pitches);
    expect(equalChords(fromHarte(toHarte(chord)), chord)).toBe(true);
  });

  const triadPitches: Record<Triad, number[]> = {
    major: [0, 4, 7],
    minor: [0, 3, 7],
    diminished: [0, 3, 6],
    augmented: [0, 4, 8],
    sus2: [0, 2, 7],
    sus4: [0, 5, 7],
    power: [0, 7],
  };
  const seventhPitches = { minor: 10, major: 11, diminished: 9 };
  const extensionPitches: Record<number, number> = { 6: 9, 9: 2, 11: 5, 13: 9 };
  const combinations = Object.entries(triadPitches).flatMap(([triad, pitches]) =>
    ([null, 'minor', 'major', 'diminished'] as const).flatMap((seventh) =>
      Array.from({ length: 16 }, (_, mask) => {
        const extensions = [6, 9, 11, 13].filter((_, index) => (mask & (1 << index)) !== 0);
        const chord: PitchedChord = {
          kind: 'chord',
          root: 0,
          triad: triad as Triad,
          fifth: 0,
          seventh,
          extensions,
          alterations: [],
          addedTones: [],
          omittedTones: [],
          bass: null,
          spelling: 'sharp',
        };
        const expected = [
          ...new Set([
            ...pitches,
            ...(seventh ? [seventhPitches[seventh]] : []),
            ...extensions.map((degree) => extensionPitches[degree]),
          ]),
        ].sort((a, b) => a - b);
        return { triad, seventh, mask, chord, expected };
      }),
    ),
  );
  it.each(combinations)(
    'preserves displayed pitches: $triad / $seventh / extension mask $mask',
    ({ chord, expected }) => {
      const symbol = formatChord(chord);
      expect(chordPitchClasses(chord)).toEqual(expected);
      expect(chordPitchClasses(parseChord(symbol)), symbol).toEqual(expected);
    },
  );

  it.each([
    ['diminished', 'minor', [], 'Cm7b5'],
    ['augmented', 'major', [], 'Caugmaj7'],
    ['power', 'minor', [], 'C7(no3)'],
    ['major', 'minor', [9, 11, 13], 'C13add11'],
    ['major', null, [9], 'Cadd9'],
  ] as const)(
    'uses readable notation for %s with %s seventh',
    (triad, seventh, extensions, expected) => {
      const chord: PitchedChord = {
        kind: 'chord',
        root: 0,
        triad,
        fifth: 0,
        seventh,
        extensions: [...extensions],
        alterations: [],
        addedTones: [],
        omittedTones: [],
        bass: null,
        spelling: 'sharp',
      };
      expect(formatChord(chord)).toBe(expected);
    },
  );
  it.each([
    ['G13(b9)/B', 'G13(b9)/B'],
    ['Cmaj9', 'Cmaj9'],
    ['CmMaj7', 'CmMaj7'],
    ['F6', 'F6'],
    ['Dadd9', 'Dadd9'],
    ['Asus', 'Asus4'],
    ['Bm7b5', 'Bm7b5'],
    ['Cdim7', 'Cdim7'],
    ['C13sus4', 'C13sus4'],
    ['N', 'N'],
    ['X', 'X'],
  ])('parses and canonically formats %s', (input, expected) => {
    expect(formatChord(parseChord(input))).toBe(expected);
  });

  it('retains every structural part of an altered extended inversion', () => {
    expect(parseChord('G13(b9)/B')).toEqual({
      kind: 'chord',
      root: 7,
      triad: 'major',
      fifth: 0,
      seventh: 'minor',
      extensions: [9, 13],
      alterations: [{ degree: 9, accidental: -1 }],
      addedTones: [],
      omittedTones: [],
      bass: 11,
      spelling: 'sharp',
    });
  });

  it('stores fifth alterations in the dedicated fifth field', () => {
    const chord = parseChord('C7#5');
    expect(chord.kind).toBe('chord');
    if (chord.kind !== 'chord') throw new Error('Expected pitched chord');
    expect(chord.fifth).toBe(1);
    expect(chord.alterations).toEqual([]);
  });

  it('normalizes ordering, duplicates, pitch classes and enharmonic comparison', () => {
    const normalized = normalizeChord({
      kind: 'chord',
      root: -1,
      triad: 'major',
      fifth: 0,
      seventh: 'minor',
      extensions: [13, 9, 13],
      alterations: [
        { degree: 13, accidental: -1 },
        { degree: 9, accidental: 1 },
        { degree: 9, accidental: 1 },
      ],
      addedTones: [11, 9, 11],
      omittedTones: [5, 3, 5],
      bass: 13,
      spelling: 'flat',
    });

    expect(normalized).toEqual({
      kind: 'chord',
      root: 11,
      triad: 'major',
      fifth: 0,
      seventh: 'minor',
      extensions: [9, 13],
      alterations: [
        { degree: 9, accidental: 1 },
        { degree: 13, accidental: -1 },
      ],
      addedTones: [9, 11],
      omittedTones: [3, 5],
      bass: 1,
      spelling: 'flat',
    });
    expect(equalChords(parseChord('C#maj7'), parseChord('Dbmaj7'))).toBe(true);
  });

  it('transposes roots and absolute basses while retaining chord structure', () => {
    expect(formatChord(transposeChord(parseChord('G13(b9)/B'), 2))).toBe('A13(b9)/C#');
    expect(transposeChord({ kind: 'none' }, 7)).toEqual({ kind: 'none' });
  });

  it('derives unique sorted sounding pitch classes with alterations and omissions', () => {
    expect(chordPitchClasses(parseChord('G13(b9,no5)/B'))).toEqual([4, 5, 7, 8, 11]);
    expect(chordPitchClasses({ kind: 'none' })).toEqual([]);
  });

  it('converts Harte bass intervals relative to the root and omitted degrees', () => {
    const chord = parseChord('C7(b9,no5)/E');
    const harte = toHarte(chord);

    expect(harte).toBe('C:7(b9,*5)/3');
    expect(equalChords(fromHarte(harte), chord)).toBe(true);
    expect(toHarte({ kind: 'none' })).toBe('N');
    expect(fromHarte('X')).toEqual({ kind: 'unknown' });
  });

  it('accepts Harte major shorthand omission and relative inversions', () => {
    expect(equalChords(fromHarte('C/5'), parseChord('C/G'))).toBe(true);
  });

  it.each(['G13(b9)/B', 'Dadd9', 'F6', 'Bm7b5'])(
    'preserves %s through Harte conversion',
    (symbol) => {
      const chord = parseChord(symbol);
      expect(equalChords(fromHarte(toHarte(chord)), chord)).toBe(true);
    },
  );

  it('validates strict structured chords and rejects malformed persisted values', () => {
    expect(validateChord(parseChord('Ebmaj9/G'))).toEqual(parseChord('Ebmaj9/G'));
    expect(() => validateChord({ kind: 'chord', root: 12 })).toThrow();
    expect(() => validateChord({ kind: 'none', root: 0 })).toThrow();
    expect(() => parseChord('Hmaj7')).toThrow();
  });

  it('spells all pitch classes deterministically', () => {
    expect(Array.from({ length: 12 }, (_, pc) => pitchName(pc))).toEqual([
      'C',
      'C#',
      'D',
      'D#',
      'E',
      'F',
      'F#',
      'G',
      'G#',
      'A',
      'A#',
      'B',
    ]);
    expect(pitchName(10, 'flat')).toBe('Bb');
  });

  it.each(['C7sus4', 'C7sus2', 'Cmaj7sus4'])(
    'formats suspended sevenths conventionally: %s',
    (symbol) => {
      expect(formatChord(parseChord(symbol))).toBe(symbol);
    },
  );

  it.each([
    ['CmMaj9', 'C:minmaj7(9)'],
    ['C9sus4', 'C:sus4(b7,9)'],
    ['C7sus2', 'C:sus2(b7)'],
    ['Caug7', 'C:aug(b7)'],
    ['Cmaj7sus4', 'C:sus4(7)'],
    ['Cdim9', 'C:dim7(9)'],
    ['F13sus4/A', 'F:sus4(b7,9,13)/3'],
  ])('preserves the triad, seventh and extensions of %s in Harte', (symbol, label) => {
    const chord = parseChord(symbol);
    expect(toHarte(chord)).toBe(label);
    expect(equalChords(fromHarte(label), chord)).toBe(true);
  });

  it('retains simultaneous flat and sharp ninths in the sounding chord', () => {
    expect(chordPitchClasses(parseChord('C7(b9,#9)'))).toEqual([0, 1, 3, 4, 7, 10]);
    expect(chordPitchClasses(parseChord('C7(b9,#9,no9)'))).toEqual([0, 4, 7, 10]);
  });

  it.each([
    ['C7#5', 'C:7(*5,#5)'],
    ['Cm7(no3)', 'C:min7(*b3)'],
    ['C9(b9)', 'C:9(*9,b9)'],
    ['C9(b9,#9)', 'C:9(*9,b9,#9)'],
  ])('emits explicit Harte pitch removals for %s', (symbol, label) => {
    const chord = parseChord(symbol);
    expect(toHarte(chord)).toBe(label);
    expect(equalChords(fromHarte(label), chord)).toBe(true);
  });

  it('recognizes an explicit seventh before classifying unordered extension degrees', () => {
    expect(equalChords(fromHarte('C:sus4(9,b7)'), parseChord('C9sus4'))).toBe(true);
  });

  it.each(['C7sus4(#11)', 'C9sus2(b9)', 'Caug7#5'])(
    'retains sounding pitches across compound-degree replacements: %s',
    (symbol) => {
      const chord = parseChord(symbol);
      const restored = fromHarte(toHarte(chord));
      expect(equalChords(restored, chord)).toBe(true);
      expect(chordPitchClasses(restored)).toEqual(chordPitchClasses(chord));
    },
  );
});
