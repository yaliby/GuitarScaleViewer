// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { parseChord } from './chord';
import { buildPracticeLibrary } from './practice-library';
import type { ChordSegment } from './types';

function segment(id: string, label: string, start: number, end: number): ChordSegment {
  return { id, chord: parseChord(label), start, end, score: 0.8, alternatives: [] };
}

describe('practice chord library', () => {
  it('groups repeated enharmonic chords in first appearance order with every occurrence', () => {
    const segments = [
      segment('a', 'Db', 0, 2),
      segment('b', 'G', 2, 5),
      segment('c', 'C#', 5, 9),
      segment('d', 'Db', 9, 10),
    ];
    const result = buildPracticeLibrary(segments);
    expect(
      result.map(({ label, count, totalDuration }) => ({ label, count, totalDuration })),
    ).toEqual([
      { label: 'Db', count: 3, totalDuration: 7 },
      { label: 'G', count: 1, totalDuration: 3 },
    ]);
    expect(result[0].labels).toEqual(['Db', 'C#']);
    expect(result[0].occurrences).toEqual([
      { segmentId: 'a', start: 0, end: 2 },
      { segmentId: 'c', start: 5, end: 9 },
      { segmentId: 'd', start: 9, end: 10 },
    ]);
  });

  it('preserves inversion, quality, rooted identity, and analyzes spelling aliases canonically', () => {
    const labels = ['C', 'C/C', 'C/E', 'Cm', 'C7', 'Cmaj7', 'C6', 'Am7', 'Cadd2', 'Cadd9'];
    const result = buildPracticeLibrary(
      labels.map((label, i) => segment(String(i), label, i, i + 1)),
    );
    expect(result.map(({ label, count }) => [label, count])).toEqual([
      ['C', 2],
      ['C/E', 1],
      ['Cm', 1],
      ['C7', 1],
      ['Cmaj7', 1],
      ['C6', 1],
      ['Am7', 1],
      ['Cadd2', 2],
    ]);
  });

  it('skips no-chord/unknown and never changes or shares mutable chord data with frozen analysis', () => {
    const source = [segment('a', 'D7/F#', 0, 3), segment('n', 'N', 3, 4), segment('x', 'X', 4, 5)];
    const before = structuredClone(source);
    for (const item of source) {
      if (item.chord.kind === 'chord') {
        Object.freeze(item.chord.extensions);
        Object.freeze(item.chord.alterations);
        Object.freeze(item.chord.addedTones);
        Object.freeze(item.chord.omittedTones);
      }
      Object.freeze(item.chord);
      Object.freeze(item);
    }
    const result = buildPracticeLibrary(Object.freeze(source));
    expect(result).toHaveLength(1);
    result[0].chord.root = 1;
    expect(source).toEqual(before);
    expect(buildPracticeLibrary([])).toEqual([]);
  });
});
