// @ts-nocheck
import { normalizeChord, transposeChord, validateChord } from './chord';
import type { Analysis, Chord, ChordSegment } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has invalid properties`);
  }
}

function assertFinite(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`${label} must be finite`);
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(`${label} must be a non-empty string`);
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be an array of strings`);
  }
}

function validateAlternative(value: unknown): void {
  if (!isRecord(value)) throw new Error('Chord alternative must be an object');
  assertExactKeys(value, ['chord', 'score'], 'Chord alternative');
  validateChord(value.chord);
  assertFinite(value.score, 'Chord alternative score');
}

function validateSegment(value: unknown, duration: number): asserts value is ChordSegment {
  if (!isRecord(value)) throw new Error('Chord segment must be an object');
  assertExactKeys(value, ['id', 'start', 'end', 'chord', 'score', 'alternatives'], 'Chord segment');
  assertNonEmptyString(value.id, 'Chord segment id');
  assertFinite(value.start, 'Chord segment start');
  assertFinite(value.end, 'Chord segment end');
  if (value.start < 0 || value.end <= value.start || value.end > duration) {
    throw new Error('Chord segment must be a positive interval within analysis duration');
  }
  validateChord(value.chord);
  assertFinite(value.score, 'Chord segment score');
  if (!Array.isArray(value.alternatives))
    throw new Error('Chord segment alternatives must be an array');
  value.alternatives.forEach(validateAlternative);
}

function validateOrderedTimes(
  value: unknown,
  duration: number,
  label: string,
): asserts value is number[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  let previous = -Infinity;
  for (const time of value) {
    assertFinite(time, `${label} time`);
    if (time < 0 || time > duration || time <= previous) {
      throw new Error(`${label} must be strictly increasing and within analysis duration`);
    }
    previous = time;
  }
}

/** Keys only newer analyses carry; a record without them is still whole. */
const OPTIONAL_ANALYSIS_KEYS = ['grid', 'tuningCents'] as const;

function validateGrid(value: unknown, beats: number[], duration: number): void {
  if (!isRecord(value)) throw new Error('Analysis beat grid must be an object');
  assertExactKeys(value, ['downbeats', 'steady', 'source'], 'Analysis beat grid');
  validateOrderedTimes(value.downbeats, duration, 'Analysis downbeats');
  const onBeat = new Set(beats);
  if (value.downbeats.some((time) => !onBeat.has(time)))
    throw new Error('Analysis downbeats must be beats');
  if (typeof value.steady !== 'boolean') throw new Error('Analysis beat grid steadiness is invalid');
  assertNonEmptyString(value.source, 'Analysis beat grid source');
  if (value.source.length > 60) throw new Error('Analysis beat grid source is too long');
}

export function validateAnalysis(value: unknown): Analysis {
  if (!isRecord(value)) throw new Error('Analysis must be an object');
  assertExactKeys(
    Object.fromEntries(
      Object.entries(value).filter(([key]) => !(OPTIONAL_ANALYSIS_KEYS as readonly string[]).includes(key)),
    ),
    [
      'id',
      'fingerprint',
      'profile',
      'modelVersion',
      'pipelineVersion',
      'duration',
      'segments',
      'beats',
      'tempo',
      'meter',
      'key',
      'waveform',
      'boundaries',
      'createdAt',
      'calibration',
      'warnings',
    ],
    'Analysis',
  );
  assertNonEmptyString(value.id, 'Analysis id');
  assertNonEmptyString(value.fingerprint, 'Analysis fingerprint');
  if (!['fast', 'balanced', 'accurate'].includes(value.profile as string))
    throw new Error('Analysis profile is invalid');
  assertNonEmptyString(value.modelVersion, 'Analysis model version');
  assertNonEmptyString(value.pipelineVersion, 'Analysis pipeline version');
  assertFinite(value.duration, 'Analysis duration');
  if (value.duration <= 0) throw new Error('Analysis duration must be positive');

  if (!Array.isArray(value.segments)) throw new Error('Analysis segments must be an array');
  const segmentIds = new Set<string>();
  let previousEnd = 0;
  for (const [index, segment] of value.segments.entries()) {
    validateSegment(segment, value.duration);
    if (segmentIds.has(segment.id)) throw new Error('Chord segment ids must be unique');
    segmentIds.add(segment.id);
    if (index > 0 && segment.start < previousEnd)
      throw new Error('Chord segments must be sorted and non-overlapping');
    previousEnd = segment.end;
  }

  validateOrderedTimes(value.beats, value.duration, 'Analysis beats');
  if (value.tempo !== null) {
    assertFinite(value.tempo, 'Analysis tempo');
    if (value.tempo <= 0) throw new Error('Analysis tempo must be positive');
  }
  if (value.meter !== null && (!Number.isInteger(value.meter) || (value.meter as number) <= 0)) {
    throw new Error('Analysis meter must be a positive integer');
  }
  if (value.key !== null) {
    if (!isRecord(value.key)) throw new Error('Analysis key must be an object or null');
    assertExactKeys(value.key, ['root', 'mode', 'score'], 'Analysis key');
    if (
      !Number.isInteger(value.key.root) ||
      (value.key.root as number) < 0 ||
      (value.key.root as number) > 11
    ) {
      throw new Error('Analysis key root is invalid');
    }
    if (value.key.mode !== 'major' && value.key.mode !== 'minor')
      throw new Error('Analysis key mode is invalid');
    assertFinite(value.key.score, 'Analysis key score');
  }
  if (!Array.isArray(value.waveform)) throw new Error('Analysis waveform must be an array');
  for (const sample of value.waveform) {
    assertFinite(sample, 'Analysis waveform sample');
    if (sample < -1 || sample > 1) throw new Error('Analysis waveform samples must be normalized');
  }
  if (!Array.isArray(value.boundaries)) throw new Error('Analysis boundaries must be an array');
  let previousBoundary = -Infinity;
  for (const boundary of value.boundaries) {
    if (!isRecord(boundary)) throw new Error('Analysis boundary must be an object');
    assertExactKeys(boundary, ['time', 'probability'], 'Analysis boundary');
    assertFinite(boundary.time, 'Analysis boundary time');
    assertFinite(boundary.probability, 'Analysis boundary probability');
    if (boundary.time < 0 || boundary.time > value.duration || boundary.time <= previousBoundary) {
      throw new Error(
        'Analysis boundaries must be strictly increasing and within analysis duration',
      );
    }
    if (boundary.probability < 0 || boundary.probability > 1) {
      throw new Error('Analysis boundary probability must be between zero and one');
    }
    previousBoundary = boundary.time;
  }
  assertNonEmptyString(value.createdAt, 'Analysis creation timestamp');
  if (!Number.isFinite(Date.parse(value.createdAt)))
    throw new Error('Analysis creation timestamp is invalid');
  if (value.calibration !== 'uncalibrated' && value.calibration !== 'temperature') {
    throw new Error('Analysis calibration is invalid');
  }
  assertStringArray(value.warnings, 'Analysis warnings');
  if (value.grid !== undefined) validateGrid(value.grid, value.beats, value.duration);
  if (value.tuningCents !== undefined && value.tuningCents !== null) {
    assertFinite(value.tuningCents, 'Analysis tuning');
    if (Math.abs(value.tuningCents) > 50) throw new Error('Analysis tuning must be within a quarter tone');
  }
  return value as unknown as Analysis;
}

export function findSegmentIndex(segments: readonly ChordSegment[], time: number): number {
  if (!Number.isFinite(time)) return -1;
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const segment = segments[middle]!;
    if (time < segment.start) {
      high = middle - 1;
    } else if (time >= segment.end) {
      low = middle + 1;
    } else {
      return middle;
    }
  }
  return -1;
}

export function findSegmentNeighbors(
  segments: readonly ChordSegment[],
  time: number,
): { previous: ChordSegment | undefined; next: ChordSegment | undefined } {
  if (!Number.isFinite(time)) return { previous: undefined, next: undefined };
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (segments[middle].start <= time) low = middle + 1;
    else high = middle;
  }
  const candidate = segments[low - 1];
  const containsTime = candidate && time < candidate.end;
  return { previous: segments[low - (containsTime ? 2 : 1)], next: segments[low] };
}

export function correctChord(analysis: Analysis, segmentId: string, chord: Chord): Analysis {
  validateAnalysis(analysis);
  const correctedChord = normalizeChord(validateChord(chord));
  const index = analysis.segments.findIndex((segment) => segment.id === segmentId);
  if (index < 0) throw new Error(`Unknown chord segment: ${segmentId}`);
  const segments = [...analysis.segments];
  segments[index] = { ...segments[index]!, chord: correctedChord };
  return { ...analysis, segments };
}

export interface SegmentCorrection {
  chord: Chord;
  start: number;
  end: number;
}

/** Move shared boundaries together; neighbors across existing gaps stay unchanged.
 * Leading/trailing uncovered time remains unlabelled rather than becoming N.
 */
export function correctSegment(
  analysis: Analysis,
  segmentId: string,
  correction: SegmentCorrection,
): Analysis {
  validateAnalysis(analysis);
  const chord = normalizeChord(validateChord(correction.chord));
  assertFinite(correction.start, 'Corrected segment start');
  assertFinite(correction.end, 'Corrected segment end');
  const index = analysis.segments.findIndex((segment) => segment.id === segmentId);
  if (index < 0) throw new Error(`Unknown chord segment: ${segmentId}`);
  const selected = analysis.segments[index];
  const segments = [...analysis.segments];
  segments[index] = { ...selected, chord, start: correction.start, end: correction.end };
  const previous = segments[index - 1];
  const next = segments[index + 1];
  if (previous && previous.end === selected.start)
    segments[index - 1] = { ...previous, end: correction.start };
  if (next && next.start === selected.end) segments[index + 1] = { ...next, start: correction.end };
  return validateAnalysis({ ...analysis, segments });
}

export function correctBoundary(analysis: Analysis, leftSegmentId: string, time: number): Analysis {
  validateAnalysis(analysis);
  assertFinite(time, 'Corrected boundary time');
  const leftIndex = analysis.segments.findIndex((segment) => segment.id === leftSegmentId);
  if (leftIndex < 0) throw new Error(`Unknown chord segment: ${leftSegmentId}`);
  const rightIndex = leftIndex + 1;
  if (rightIndex >= analysis.segments.length)
    throw new Error('The final segment has no following boundary');
  const left = analysis.segments[leftIndex]!;
  const right = analysis.segments[rightIndex]!;
  if (time <= left.start || time >= right.end) {
    throw new Error('Corrected boundary must preserve positive adjacent segments');
  }
  const segments = [...analysis.segments];
  segments[leftIndex] = { ...left, end: time };
  segments[rightIndex] = { ...right, start: time };
  const corrected = { ...analysis, segments };
  validateAnalysis(corrected);
  return corrected;
}

export function transposeAnalysis(analysis: Analysis, semitones: number): Analysis {
  validateAnalysis(analysis);
  if (!Number.isInteger(semitones))
    throw new Error('Transposition must be an integer number of semitones');
  return {
    ...analysis,
    key:
      analysis.key === null
        ? null
        : { ...analysis.key, root: (((analysis.key.root + semitones) % 12) + 12) % 12 },
    segments: analysis.segments.map((segment) => ({
      ...segment,
      chord: transposeChord(segment.chord, semitones),
      alternatives: segment.alternatives.map((alternative) => ({
        ...alternative,
        chord: transposeChord(alternative.chord, semitones),
      })),
    })),
  };
}
