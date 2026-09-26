// @ts-nocheck
import { expect, it } from 'vitest';
import { decodeWholeSequence } from './whole-decoder';
import { chordIdentity } from './recognizer';
import type { ChordSegment } from '../domain/types';
import { chordPitchClasses, formatChord, parseChord } from '../domain/chord';
import { extractFeatures, type AudioFeatures, type FeatureFrame } from './features';
import { analyzeFeatures } from './pipeline';
import { TemplateRecognizer } from './recognizer';
import { analyzeWholeSongFeatures } from './whole-pipeline';
import type { WholePipelineTimings } from './whole-timings';

function frame(label: string, time: number): FeatureFrame {
  const pitches = chordPitchClasses(parseChord(label));
  const chroma = Array.from({ length: 12 }, (_, i) =>
    pitches.includes(i) ? 1 / Math.sqrt(pitches.length) : 0,
  );
  return { time, chroma, bass: Array(12).fill(0), rms: pitches.length ? 0.1 : 0, onset: 0 };
}
function features(labels: string[]): AudioFeatures {
  return {
    frames: labels.map((label, i) => frame(label, i * 0.1)),
    duration: labels.length * 0.1,
    hopSeconds: 0.1,
    waveform: [0.1],
  };
}

it('reports non-overlapping stage timings without changing the complete analysis', () => {
  const input = features(['C', 'C', 'N', 'G', 'F']);
  let timings: WholePipelineTimings | undefined;
  const baseline = analyzeWholeSongFeatures(input, 'timing', 'balanced');
  const measured = analyzeWholeSongFeatures(input, 'timing', 'balanced', undefined, (value) => {
    timings = value;
  });
  expect({ ...measured, createdAt: '' }).toEqual({ ...baseline, createdAt: '' });
  expect(timings).toBeDefined();
  expect(Object.values(timings!).every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
  expect(
    timings!.inferenceMs +
      timings!.temporalDecodingMs +
      timings!.timelineMs +
      timings!.rhythmKeyMs +
      timings!.boundaryMs,
  ).toBeLessThanOrEqual(timings!.pipelineMs + 0.001);
});

it('exactly preserves legacy two-pass scores, bass, alternatives and merged boundaries', () => {
  const input = features(
    Array.from(
      { length: 140 },
      (_, i) => ['C', 'Cmaj7', 'Fm', 'N', 'G13', 'D7b9', 'Asus4'][Math.floor(i / 5) % 7],
    ),
  );
  let seed = 27;
  for (const f of input.frames) {
    if (!f.rms) continue;
    f.chroma = f.chroma.map((value) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return Math.min(1, value + (seed / 2 ** 32) * 0.04);
    });
    f.bass[Math.floor(f.time * 10) % 12] = 0.9;
  }
  const recognizer = new TemplateRecognizer();
  const decoded = decodeWholeSequence(
    input.frames.length,
    recognizer.templateCount + 1,
    (i, emissions) => {
      emissions.fill(-Infinity);
      const choices = recognizer.scoreAll(input.frames[i]);
      if (choices[0].chord.kind === 'none') emissions[recognizer.templateCount] = 1;
      else
        choices.forEach((choice, state) => {
          emissions[state] = choice.score;
        });
    },
  );
  const segments: ChordSegment[] = [];
  let previousKey: string | undefined;
  decoded.states.forEach((state, i) => {
    const choices = recognizer.scoreAll(input.frames[i]);
    const chosen = choices[state === recognizer.templateCount ? 0 : state];
    const key = chordIdentity(chosen.chord),
      start = input.frames[i].time;
    const end = input.frames[i + 1]?.time ?? input.duration;
    const previous = segments.at(-1);
    if (previous && previousKey === key) {
      previous.score =
        (previous.score * (previous.end - previous.start) + chosen.score * (end - start)) /
        (end - previous.start);
      previous.end = end;
    } else
      segments.push({
        id: `whole-segment-${segments.length}`,
        start,
        end,
        chord: chosen.chord,
        score: chosen.score,
        alternatives: choices
          .filter((choice) => chordIdentity(choice.chord) !== key)
          .sort((a, b) => b.score - a.score)
          .slice(0, 3),
      });
    previousKey = key;
  });
  expect(analyzeWholeSongFeatures(input, 'parity', 'balanced').segments).toEqual(segments);
});

it('makes all acoustic templates available without changing the baseline top four', () => {
  const recognizer = new TemplateRecognizer();
  const input = frame('Cmaj7', 0);
  const all = recognizer.scoreAll(input);
  expect(all).toHaveLength(324);
  expect(recognizer.predict(input)).toEqual([...all].sort((a, b) => b.score - a.score).slice(0, 4));
  expect(all.some((candidate) => formatChord(candidate.chord) === 'Cmaj7')).toBe(true);
});

it('retains supported seventh/extended chord vocabulary instead of reducing to major/minor', () => {
  const result = analyzeWholeSongFeatures(features(Array(30).fill('Cmaj7')), 'rich', 'balanced');
  expect(result.segments).toHaveLength(1);
  expect(formatChord(result.segments[0].chord)).toBe('Cmaj7');
});

it('keeps silence and both sides of a short strong chord with complete bounds', () => {
  const result = analyzeWholeSongFeatures(
    features(['C', 'C', 'N', 'G', 'N', 'F', 'F']),
    'change',
    'balanced',
  );
  expect(result.segments.map((segment) => formatChord(segment.chord))).toEqual([
    'C',
    'N',
    'G',
    'N',
    'F',
  ]);
  expect(result.segments[0].start).toBe(0);
  expect(result.segments.at(-1)?.end).toBeCloseTo(0.7);
  result.segments
    .slice(1)
    .forEach((segment, index) => expect(segment.start).toBe(result.segments[index].end));
});

it('builds a complete unknown-key no-chord timeline from actual silent PCM', () => {
  const result = analyzeWholeSongFeatures(
    extractFeatures(new Float32Array(22050), 22050),
    'silent',
    'balanced',
  );
  expect(result.segments).toMatchObject([{ start: 0, end: 1, chord: { kind: 'none' } }]);
  expect(result.key).toBeNull();
  expect(result.tempo).toBeNull();
  expect(result.meter).toBeNull();
  expect(result.calibration).toBe('uncalibrated');
});

it('uses a different cache identity from the baseline for the same complete recording', () => {
  const input = features(Array(30).fill('C'));
  const baseline = analyzeFeatures(input, 'same', 'balanced');
  const whole = analyzeWholeSongFeatures(input, 'same', 'balanced');
  expect(whole.id).not.toBe(baseline.id);
  expect(whole.pipelineVersion).not.toBe(baseline.pipelineVersion);
  expect(whole.id).toContain(whole.pipelineVersion);
  expect(whole.id).toContain(whole.modelVersion);
  expect(whole.key).toMatchObject({ root: 0, mode: 'major' });
});

it('rejects malformed or unbounded features before decoding', () => {
  expect(() =>
    analyzeWholeSongFeatures({ ...features(['C']), duration: 1201 }, 'bad', 'balanced'),
  ).toThrow();
  expect(() =>
    analyzeWholeSongFeatures({ ...features(['C']), frames: [] }, 'bad', 'balanced'),
  ).toThrow();
  const invalid = features(['C']);
  invalid.frames[0].chroma[3] = NaN;
  expect(() => analyzeWholeSongFeatures(invalid, 'bad', 'balanced')).toThrow();
});
