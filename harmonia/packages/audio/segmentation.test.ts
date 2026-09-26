// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { formatChord, parseChord } from '../domain/chord';
import type { ChordAlternative } from '../domain/types';
import type { AudioFeatures } from './features';
import { harmonicNovelty, refineSegmentation } from './segmentation';

function fixture(labels: string[], hop = 0.02) {
  const features: AudioFeatures = {
    duration: labels.length * hop,
    hopSeconds: hop,
    waveform: [],
    frames: labels.map((_, i) => ({
      time: i * hop,
      chroma: [1, ...Array<number>(11).fill(0)],
      bass: [1, ...Array<number>(11).fill(0)],
      rms: 0.1,
      onset: 0,
    })),
  };
  const predictions: ChordAlternative[][] = labels.map((label) => [
    { chord: parseChord(label), score: 0.9 },
  ]);
  const novelty = labels.map(() => 0);
  return { features, predictions, novelty };
}
const names = (result: ReturnType<typeof refineSegmentation>) =>
  result.segments.map((segment) => formatChord(segment.chord));

describe('independent candidates and harmonic refinement', () => {
  it('proposes a novelty candidate and removes it when both sides agree', () => {
    const input = fixture(Array<string>(16).fill('C'));
    input.novelty[8] = 0.9;
    const result = refineSegmentation(input.features, input.predictions, input.novelty);
    expect(result.candidates.map((candidate) => candidate.frameIndex)).toEqual([8]);
    expect(result.candidateSegments).toEqual([
      { start: 0, end: 0.16 },
      { start: 0.16, end: 0.32 },
    ]);
    expect(result.removedCuts).toEqual([8]);
    expect(names(result)).toEqual(['C']);
    expect(result.segments[0]).toMatchObject({ start: 0, end: 0.32 });
  });

  it('splits missed candidates at sustained harmonic changes without novelty', () => {
    const input = fixture([
      ...Array<string>(6).fill('C'),
      ...Array<string>(6).fill('G'),
      ...Array<string>(6).fill('C'),
    ]);
    const result = refineSegmentation(input.features, input.predictions, input.novelty);
    expect(result.candidates).toEqual([]);
    expect(result.insertedCuts).toEqual([6, 12]);
    expect(names(result)).toEqual(['C', 'G', 'C']);
    expect(result.segments.map((segment) => [segment.start, segment.end])).toEqual([
      [0, 0.12],
      [0.12, 0.24],
      [0.24, 0.36],
    ]);
    expect(result.calibration).toBe('uncalibrated');
  });

  it('keeps a 40ms candidate-supported chord, with no minimum output duration', () => {
    const input = fixture([
      ...Array<string>(6).fill('C'),
      'Dm',
      'Dm',
      ...Array<string>(6).fill('C'),
    ]);
    input.novelty[6] = 0.9;
    input.novelty[8] = 0.8;
    const result = refineSegmentation(input.features, input.predictions, input.novelty);
    expect(names(result)).toEqual(['C', 'Dm', 'C']);
    expect(result.segments[1].end - result.segments[1].start).toBeCloseTo(0.04);
    expect(result.insertedCuts).toEqual([]);
  });

  it('does not split isolated jitter or sustained ties', () => {
    const input = fixture([...Array<string>(6).fill('C'), 'G', ...Array<string>(6).fill('C')]);
    expect(names(refineSegmentation(input.features, input.predictions, input.novelty))).toEqual([
      'C',
    ]);
    for (let i = 6; i < 10; i++)
      input.predictions[i] = [
        { chord: parseChord('G'), score: 0.5 },
        { chord: parseChord('C'), score: 0.5 },
      ];
    expect(
      refineSegmentation(input.features, input.predictions, input.novelty).insertedCuts,
    ).toEqual([]);
  });

  it('distinguishes bass and omitted tones while merging enharmonic spelling', () => {
    const bass = fixture([...Array<string>(5).fill('C'), ...Array<string>(5).fill('C/E')]);
    expect(names(refineSegmentation(bass.features, bass.predictions, bass.novelty))).toEqual([
      'C',
      'C/E',
    ]);
    const omission = fixture(Array<string>(10).fill('C'));
    for (let i = 5; i < 10; i++) {
      const chord = omission.predictions[i][0].chord;
      if (chord.kind === 'chord') chord.omittedTones = [5];
    }
    expect(
      refineSegmentation(omission.features, omission.predictions, omission.novelty).segments,
    ).toHaveLength(2);
    const spelling = fixture([...Array<string>(5).fill('C#'), ...Array<string>(5).fill('Db')]);
    spelling.novelty[5] = 1;
    expect(
      refineSegmentation(spelling.features, spelling.predictions, spelling.novelty).segments,
    ).toHaveLength(1);
  });

  it('weights irregular frame coverage by duration instead of frame count', () => {
    const input = fixture(['G', 'G', 'C']);
    input.features.frames[1].time = 0.005;
    input.features.frames[2].time = 0.01;
    expect(names(refineSegmentation(input.features, input.predictions, input.novelty))).toEqual([
      'C',
    ]);
  });

  it('keeps unknown distinct from explicit no-chord', () => {
    const input = fixture(Array<string>(10).fill('N'));
    for (let i = 5; i < 10; i++) input.predictions[i][0].chord = { kind: 'unknown' };
    expect(
      refineSegmentation(input.features, input.predictions, input.novelty).segments.map(
        (s) => s.chord.kind,
      ),
    ).toEqual(['none', 'unknown']);
  });

  it('picks only the first frame of a flat novelty peak', () => {
    const input = fixture(Array<string>(12).fill('C'));
    input.novelty.splice(4, 4, 0.7, 0.7, 0.7, 0.7);
    expect(
      refineSegmentation(input.features, input.predictions, input.novelty).candidates.map(
        (c) => c.frameIndex,
      ),
    ).toEqual([4]);
  });
});

describe('bounded timing refinement', () => {
  it('moves a harmonic cut to a stronger nearby novelty sample and records the move', () => {
    const input = fixture([...Array<string>(8).fill('C'), ...Array<string>(8).fill('G')]);
    input.novelty[7] = 0.3; // Below proposal threshold, still useful timing evidence.
    const result = refineSegmentation(input.features, input.predictions, input.novelty);
    expect(result.timingMoves).toEqual([{ from: 0.16, to: 0.14 }]);
    expect(result.segments[0].end).toBe(0.14);
    expect(result.segments[1].start).toBe(0.14);
  });

  it('prefers nearest, then earlier equally strong evidence, and never moves on a flat zero field', () => {
    const input = fixture([...Array<string>(8).fill('C'), ...Array<string>(8).fill('G')]);
    input.novelty[6] = input.novelty[7] = input.novelty[9] = 0.3;
    expect(
      refineSegmentation(input.features, input.predictions, input.novelty).timingMoves,
    ).toEqual([{ from: 0.16, to: 0.14 }]);
    input.novelty.fill(0);
    expect(
      refineSegmentation(input.features, input.predictions, input.novelty).timingMoves,
    ).toEqual([]);
  });

  it('uses original-neighbor guards so nearby cuts cannot cross or collapse', () => {
    const input = fixture([
      ...Array<string>(6).fill('C'),
      'Dm',
      'Dm',
      ...Array<string>(6).fill('G'),
    ]);
    input.novelty[6] = 0.7;
    input.novelty[8] = 0.8;
    const result = refineSegmentation(input.features, input.predictions, input.novelty);
    expect(names(result)).toEqual(['C', 'Dm', 'G']);
    for (let i = 0; i < result.segments.length; i++) {
      const segment = result.segments[i];
      expect(segment.end).toBeGreaterThan(segment.start);
      if (i) expect(segment.start).toBe(result.segments[i - 1].end);
    }
    expect(result.segments[0].start).toBe(0);
    expect(result.segments.at(-1)?.end).toBe(input.features.duration);
  });

  it('rejects a stronger shared midpoint instead of snapping both changes to one time', () => {
    const input = fixture([
      ...Array<string>(4).fill('C'),
      ...Array<string>(4).fill('Dm'),
      ...Array<string>(4).fill('G'),
    ]);
    input.novelty[6] = 0.3;
    const result = refineSegmentation(input.features, input.predictions, input.novelty);
    expect(names(result)).toEqual(['C', 'Dm', 'G']);
    expect(result.segments.map((segment) => segment.start)).toEqual([0, 0.08, 0.16]);
    expect(result.timingMoves).toEqual([]);
  });

  it('can retain harmonic timings explicitly for a timing-refinement ablation', () => {
    const input = fixture([...Array<string>(8).fill('C'), ...Array<string>(8).fill('G')]);
    input.novelty[7] = 0.3;
    const result = refineSegmentation(input.features, input.predictions, input.novelty, {
      refineTiming: false,
    });
    expect(result.segments.map((segment) => segment.start)).toEqual([0, 0.16]);
    expect(result.timingMoves).toEqual([]);
  });

  it('does not search past the 50ms or eight-frame timing bounds', () => {
    const input = fixture([...Array<string>(12).fill('C'), ...Array<string>(12).fill('G')]);
    input.novelty[9] = 0.3;
    expect(
      refineSegmentation(input.features, input.predictions, input.novelty).timingMoves,
    ).toEqual([]);
    const dense = fixture(
      [...Array<string>(100).fill('C'), ...Array<string>(100).fill('G')],
      0.001,
    );
    dense.novelty[90] = 0.3;
    expect(
      refineSegmentation(dense.features, dense.predictions, dense.novelty).timingMoves,
    ).toEqual([]);
  });
});

describe('novelty and input contract', () => {
  it('computes independent harmonic/silence novelty with no invented probabilities', () => {
    const input = fixture(Array<string>(12).fill('C'));
    expect(harmonicNovelty(input.features)).toEqual(Array(12).fill(0));
    input.features.frames.slice(6).forEach((frame) => {
      frame.chroma = [0, 1, ...Array<number>(10).fill(0)];
    });
    expect(harmonicNovelty(input.features)[6]).toBe(1);
    input.features.frames.forEach((frame) => {
      frame.rms = 0;
    });
    expect(harmonicNovelty(input.features)).toEqual(Array(12).fill(0));
    input.features.frames[8].rms = 0.1;
    expect(harmonicNovelty(input.features)[6]).toBe(0.95);
  });

  it('is deterministic and leaves input arrays/chords unchanged', () => {
    const input = fixture([...Array<string>(6).fill('C'), ...Array<string>(6).fill('G')]);
    const snapshot = structuredClone(input);
    const first = refineSegmentation(input.features, input.predictions, input.novelty);
    expect(refineSegmentation(input.features, input.predictions, input.novelty)).toEqual(first);
    expect(input).toEqual(snapshot);
    if (first.segments[0].chord.kind === 'chord') first.segments[0].chord.addedTones.push(9);
    expect(input).toEqual(snapshot);
  });

  it('keeps a single-frame track positive and complete without fabricated boundaries', () => {
    const input = fixture(['N'], 1 / 22050);
    const result = refineSegmentation(input.features, input.predictions);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({ start: 0, end: 1 / 22050, chord: { kind: 'none' } });
    expect(result.candidates).toEqual([]);
    expect(result.timingMoves).toEqual([]);
  });

  it.each([
    'empty',
    'length',
    'nonfinite-time',
    'nonzero-start',
    'duplicate-time',
    'end-time',
    'duration',
    'score',
    'novelty',
    'feature',
    'alternatives',
    'unordered',
    'chord',
    'frame-cap',
  ])('rejects malformed or unbounded input: %s', (kind) => {
    const input = fixture(Array<string>(8).fill('C'));
    if (kind === 'empty') input.features.frames = [];
    if (kind === 'length') input.predictions.pop();
    if (kind === 'nonfinite-time') input.features.frames[3].time = NaN;
    if (kind === 'nonzero-start') input.features.frames[0].time = 0.001;
    if (kind === 'duplicate-time') input.features.frames[3].time = input.features.frames[2].time;
    if (kind === 'end-time') input.features.frames[7].time = input.features.duration;
    if (kind === 'duration') input.features.duration = Infinity;
    if (kind === 'score') input.predictions[0][0].score = NaN;
    if (kind === 'novelty') input.novelty[0] = 2;
    if (kind === 'feature') input.features.frames[0].chroma[0] = Infinity;
    if (kind === 'alternatives') input.predictions[0] = Array(9).fill(input.predictions[0][0]);
    if (kind === 'unordered') input.predictions[0].push({ chord: parseChord('G'), score: 1 });
    if (kind === 'chord' && input.predictions[0][0].chord.kind === 'chord')
      input.predictions[0][0].chord.root = 12;
    if (kind === 'frame-cap') input.features.frames = Array(60001).fill(input.features.frames[0]);
    expect(() => refineSegmentation(input.features, input.predictions, input.novelty)).toThrow();
  });
});
