// @ts-nocheck
import { describe, expect, it } from 'vitest';

import type { Analysis } from './types';
import {
  correctBoundary,
  correctChord,
  correctSegment,
  findSegmentIndex,
  findSegmentNeighbors,
  transposeAnalysis,
  validateAnalysis,
} from './timeline';
import { formatChord, parseChord } from './chord';

describe('complete segment correction', () => {
  it('moves both contiguous neighbors without mutating the source or transposed projection', () => {
    const source = analysisFixture();
    source.segments[1].start = 2;
    source.segments.push({ ...source.segments[0], id: 's3', start: 6, end: 8 });
    const before = structuredClone(source);
    const corrected = correctSegment(source, 's2', {
      start: 1.5,
      end: 6.5,
      chord: parseChord('Dm9/F'),
    });
    expect(corrected.segments.map(({ start, end }) => [start, end])).toEqual([
      [0, 1.5],
      [1.5, 6.5],
      [6.5, 8],
    ]);
    expect(formatChord(corrected.segments[1].chord)).toBe('Dm9/F');
    expect(formatChord(transposeAnalysis(corrected, 2).segments[1].chord)).toBe('Em9/G');
    expect(source).toEqual(before);
  });

  it('allows unlabelled leading/trailing spans and leaves neighbors across gaps unchanged', () => {
    const source = analysisFixture();
    const first = correctSegment(source, 's1', { start: 0.5, end: 2.5, chord: parseChord('C') });
    expect(first.segments[1]).toEqual(source.segments[1]);
    expect(findSegmentIndex(first.segments, 0.25)).toBe(-1);
    const last = correctSegment(first, 's2', { start: 3.5, end: 7.5, chord: parseChord('G') });
    expect(last.segments[0]).toEqual(first.segments[0]);
    expect(findSegmentIndex(last.segments, 7.75)).toBe(-1);
    expect(last.segments).toHaveLength(2);
  });

  it.each([
    [-1, 4],
    [2, 9],
    [4, 4],
    [5, 4],
    [NaN, 4],
    [2, Infinity],
    [1, 4],
  ])('rejects invalid or overlapping bounds %s..%s without partial chord changes', (start, end) => {
    const source = analysisFixture();
    const before = structuredClone(source);
    expect(() => correctSegment(source, 's2', { start, end, chord: parseChord('Dm') })).toThrow();
    expect(source).toEqual(before);
  });

  it('rejects a boundary that would erase a contiguous neighbor and unknown segment IDs', () => {
    const source = analysisFixture();
    source.segments[1].start = 2;
    expect(() =>
      correctSegment(source, 's2', { start: 0, end: 7, chord: parseChord('G') }),
    ).toThrow();
    expect(() =>
      correctSegment(source, 'missing', { start: 2, end: 7, chord: parseChord('G') }),
    ).toThrow();
  });
});

function analysisFixture(): Analysis {
  return {
    id: 'analysis-1',
    fingerprint: 'sha256:abc',
    profile: 'balanced',
    modelVersion: 'dsp-1',
    pipelineVersion: 'pipeline-1',
    duration: 8,
    segments: [
      {
        id: 's1',
        start: 0,
        end: 2,
        chord: parseChord('Cmaj7'),
        score: 2.1,
        alternatives: [{ chord: parseChord('Am7'), score: 1.4 }],
      },
      {
        id: 's2',
        start: 3,
        end: 6,
        chord: parseChord('G7/B'),
        score: 1.9,
        alternatives: [],
      },
    ],
    beats: [0, 1, 2, 3, 4, 5, 6, 7],
    tempo: 60,
    meter: 4,
    key: { root: 0, mode: 'major', score: 0.75 },
    waveform: [0, 0.25, -0.5, 1],
    boundaries: [
      { time: 2, probability: 0.7 },
      { time: 3, probability: 0.8 },
    ],
    createdAt: '2026-09-20T08:00:00.000Z',
    calibration: 'uncalibrated',
    warnings: ['Synthetic fixture'],
  };
}

describe('timeline lookup', () => {
  it.each([
    [0, undefined, 's2'],
    [2.5, 's1', 's2'],
    [7, 's2', undefined],
    [-1, undefined, 's1'],
    [NaN, undefined, undefined],
  ])(
    'locates neighboring labels around time %s including unlabelled gaps',
    (time, previous, next) => {
      const result = findSegmentNeighbors(analysisFixture().segments, time);
      expect(result.previous?.id).toBe(previous);
      expect(result.next?.id).toBe(next);
    },
  );

  it('uses half-open segment intervals and returns -1 for gaps and the final end', () => {
    const segments = analysisFixture().segments;

    expect(findSegmentIndex(segments, 0)).toBe(0);
    expect(findSegmentIndex(segments, 1.999)).toBe(0);
    expect(findSegmentIndex(segments, 2)).toBe(-1);
    expect(findSegmentIndex(segments, 2.5)).toBe(-1);
    expect(findSegmentIndex(segments, 3)).toBe(1);
    expect(findSegmentIndex(segments, 6)).toBe(-1);
    expect(findSegmentIndex(segments, Number.NaN)).toBe(-1);
  });
});

describe('persisted analysis validation', () => {
  it('accepts complete finite analyses with sorted, non-overlapping segments', () => {
    const value = analysisFixture();
    expect(validateAnalysis(value)).toEqual(value);
  });

  it.each([
    ['overlapping segments', (a: Analysis) => (a.segments[1]!.start = 1.5)],
    ['out-of-range segment end', (a: Analysis) => (a.segments[1]!.end = 9)],
    ['duplicate segment ids', (a: Analysis) => (a.segments[1]!.id = 's1')],
    [
      'non-finite nested score',
      (a: Analysis) => (a.segments[0]!.alternatives[0]!.score = Number.NaN),
    ],
    ['unsorted beats', (a: Analysis) => (a.beats = [0, 2, 1])],
    ['invalid boundary probability', (a: Analysis) => (a.boundaries[0]!.probability = 1.1)],
    [
      'malformed nested chord',
      (a: Analysis) => ((a.segments[0]!.chord as { root: number }).root = 12),
    ],
  ])('rejects %s', (_name, mutate) => {
    const value = analysisFixture();
    mutate(value);
    expect(() => validateAnalysis(value)).toThrow();
  });

  it('rejects unknown analysis properties', () => {
    const value = analysisFixture() as Analysis & { surprise?: boolean };
    value.surprise = true;

    expect(() => validateAnalysis(value)).toThrow();
  });

  it('rejects unknown nested properties', () => {
    const value = analysisFixture();
    (value.boundaries[0] as { time: number; probability: number; extra?: string }).extra = 'no';

    expect(() => validateAnalysis(value)).toThrow();
  });
});

describe('immutable timeline correction and transposition', () => {
  it('replaces one chord without mutating the analysis', () => {
    const before = analysisFixture();
    const after = correctChord(before, 's2', parseChord('Fm9/Ab'));

    expect(formatChord(after.segments[1]!.chord)).toBe('Fm9/Ab');
    expect(formatChord(before.segments[1]!.chord)).toBe('G7/B');
    expect(after.segments[0]).toBe(before.segments[0]);
    expect(() => correctChord(before, 'missing', parseChord('C'))).toThrow();
  });

  it('moves the shared boundary while preserving positive adjacent segments', () => {
    const before = analysisFixture();
    const after = correctBoundary(before, 's1', 2.5);

    expect(after.segments.map(({ start, end }) => [start, end])).toEqual([
      [0, 2.5],
      [2.5, 6],
    ]);
    expect(before.segments[0]!.end).toBe(2);
    expect(() => correctBoundary(before, 's1', 0)).toThrow();
    expect(() => correctBoundary(before, 's2', 7)).toThrow();
  });

  it('transposes primary chords, alternatives, basses and key without mutating timing', () => {
    const before = analysisFixture();
    const after = transposeAnalysis(before, 2);

    expect(after.segments.map((segment) => formatChord(segment.chord))).toEqual(['Dmaj7', 'A7/C#']);
    expect(formatChord(after.segments[0]!.alternatives[0]!.chord)).toBe('Bm7');
    expect(after.key?.root).toBe(2);
    expect(after.segments[0]!.start).toBe(0);
    expect(formatChord(before.segments[0]!.chord)).toBe('Cmaj7');
  });
});
