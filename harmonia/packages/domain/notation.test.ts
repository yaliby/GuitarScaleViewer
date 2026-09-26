// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { parseChord, formatChord } from './chord';
import { displayChord } from './notation';

describe('practice notation', () => {
  it.each([
    ['Cmaj7', 'roman', 'Imaj7'],
    ['Am9', 'roman', 'vi9'],
    ['G13(b9)/B', 'roman', 'V13(b9)/7'],
    ['Bb7', 'roman', 'bVII7'],
    ['F#dim7', 'roman', '#ivdim7'],
    ['Dm7', 'nashville', '2m7'],
    ['Abmaj9/Eb', 'nashville', 'b6maj9/b3'],
    ['C7sus4', 'roman', 'I7sus4'],
  ] as const)('preserves harmonic detail for %s in %s', (symbol, mode, expected) => {
    expect(displayChord(parseChord(symbol), mode, 0)).toBe(expected);
  });

  it('uses the supplied tonic and retains note names when the key is unknown', () => {
    expect(displayChord(parseChord('F#m7/A'), 'roman', 2)).toBe('iii7/5');
    expect(displayChord(parseChord('F#m7/A'), 'roman', null)).toBe('F#m7/A');
  });

  it('simplifies color tones without mutating the chord, bass or structural fifth', () => {
    const chord = parseChord('G13(b9)/B');
    expect(displayChord(chord, 'simple', 0)).toBe('G/B');
    expect(formatChord(chord)).toBe('G13(b9)/B');
    expect(displayChord(parseChord('Bm7(b5)'), 'simple', 0)).toBe('Bmb5');
  });

  it('distinguishes unknown harmony from no chord in all modes', () => {
    for (const mode of ['advanced', 'simple', 'roman', 'nashville'] as const) {
      expect(displayChord({ kind: 'none' }, mode, 0)).toBe('N');
      expect(displayChord({ kind: 'unknown' }, mode, 0)).toBe('X');
    }
  });
});
