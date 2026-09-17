import { describe, expect, it } from 'vitest';
import { getPositionFrets, getPositionWindow } from './positions';

const STANDARD = [4, 9, 2, 7, 11, 4] as const;
const DROP_D = [2, 9, 2, 7, 11, 4] as const;
const A_MINOR_PENTATONIC = [9, 0, 2, 4, 7] as const;
const C_MAJOR = [0, 2, 4, 5, 7, 9, 11] as const;

describe('pentatonic positions', () => {
  it('returns the literal A-minor pentatonic box 1 shape', () => {
    expect(getPositionWindow(9, 'pentatonic-minor', 'pentatonic', 0)).toMatchObject({
      startFret: 5,
      endFret: 8,
      label: 'Box 1',
    });

    expect(
      getPositionFrets(STANDARD, A_MINOR_PENTATONIC, 9, 'pentatonic-minor', 'pentatonic', 0),
    ).toEqual([
      { stringIndex: 0, fret: 5 },
      { stringIndex: 0, fret: 8 },
      { stringIndex: 1, fret: 5 },
      { stringIndex: 1, fret: 7 },
      { stringIndex: 2, fret: 5 },
      { stringIndex: 2, fret: 7 },
      { stringIndex: 3, fret: 5 },
      { stringIndex: 3, fret: 7 },
      { stringIndex: 4, fret: 5 },
      { stringIndex: 4, fret: 8 },
      { stringIndex: 5, fret: 5 },
      { stringIndex: 5, fret: 8 },
    ]);
  });

  it('returns all five canonical A-minor pentatonic box shapes', () => {
    const expected = [
      [[5, 8], [5, 7], [5, 7], [5, 7], [5, 8], [5, 8]],
      [[8, 10], [7, 10], [7, 10], [7, 9], [8, 10], [8, 10]],
      [[10, 12], [10, 12], [10, 12], [9, 12], [10, 13], [10, 12]],
      [[12, 15], [12, 15], [12, 14], [12, 14], [13, 15], [12, 15]],
      [[15, 17], [15, 17], [14, 17], [14, 17], [15, 17], [15, 17]],
    ];

    expected.forEach((strings, boxIndex) => {
      const actual = getPositionFrets(
        STANDARD,
        A_MINOR_PENTATONIC,
        9,
        'pentatonic-minor',
        'pentatonic',
        boxIndex,
      );
      expect(
        Array.from({ length: 6 }, (_, stringIndex) =>
          actual.filter((point) => point.stringIndex === stringIndex).map((point) => point.fret),
        ),
      ).toEqual(strings);
    });
  });

  it('adapts a pentatonic position to an alternate tuning without adding foreign pitches', () => {
    const points = getPositionFrets(
      DROP_D,
      A_MINOR_PENTATONIC,
      9,
      'pentatonic-minor',
      'pentatonic',
      0,
    );

    expect(points.length).toBeGreaterThan(0);
    for (const point of points) {
      expect(A_MINOR_PENTATONIC).toContain((DROP_D[point.stringIndex]! + point.fret) % 12);
    }
  });
});

describe('CAGED and three-note positions', () => {
  it('returns a named CAGED major-scale position in standard tuning', () => {
    expect(getPositionWindow(0, 'major', 'caged', 0).label).toBe('C shape');
    const points = getPositionFrets(STANDARD, C_MAJOR, 0, 'major', 'caged', 0);

    expect(points.length).toBeGreaterThan(0);
    for (const point of points) {
      expect(C_MAJOR).toContain((STANDARD[point.stringIndex]! + point.fret) % 12);
    }
  });

  it('reports CAGED as incompatible with alternate tuning or non-major scales', () => {
    expect(getPositionFrets(DROP_D, C_MAJOR, 0, 'major', 'caged', 0)).toEqual([]);
    expect(getPositionFrets(STANDARD, A_MINOR_PENTATONIC, 9, 'minor', 'caged', 0)).toEqual([]);
  });

  it('puts exactly three current-scale notes on every string in a seven-note pattern', () => {
    const points = getPositionFrets(DROP_D, C_MAJOR, 0, 'major', 'three-notes', 0);

    const firstLowStringNote = points.find((point) => point.stringIndex === 0);
    expect(firstLowStringNote).toBeDefined();
    expect((DROP_D[0] + firstLowStringNote!.fret) % 12).toBe(0);
    for (let stringIndex = 0; stringIndex < 6; stringIndex += 1) {
      expect(points.filter((point) => point.stringIndex === stringIndex)).toHaveLength(3);
    }
    for (const point of points) {
      expect(C_MAJOR).toContain((DROP_D[point.stringIndex]! + point.fret) % 12);
    }
  });

  it('does not present a five-note scale as a three-notes-per-string family', () => {
    expect(
      getPositionFrets(STANDARD, A_MINOR_PENTATONIC, 9, 'pentatonic-minor', 'three-notes', 0),
    ).toEqual([]);
  });
});
