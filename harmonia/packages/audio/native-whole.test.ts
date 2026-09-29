// @ts-nocheck
import { expect, it } from 'vitest';
import { assembleNativeWholeSong, NATIVE_BEAT_TRACKER, NATIVE_MODEL_VERSION } from './native-whole';
import { formatChord } from '../domain/chord';
const result = () => ({
  schemaVersion: 1,
  sampleRate: 22050,
  sampleCount: 220500,
  duration: 10,
  modelVersion: NATIVE_MODEL_VERSION,
  segments: [
    { start: 0, end: 5, label: 'G:maj', score: 0.8 },
    { start: 5, end: 10, label: 'D:7/3', score: 0.75 },
  ],
  beats: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  downbeats: [1, 5, 9],
  tempo: 60,
  tempoSteady: true,
  meter: 4,
  rhythmSource: 'beat-this-final0',
  tuningCents: -32,
  timings: {
    setupSeconds: 0,
    cqtSeconds: 0.1,
    inferenceSeconds: 0.2,
    decodeSeconds: 0.03,
    beatSeconds: 0.02,
    totalSeconds: 0.4,
  },
  warnings: [],
});
it('invalidates the previous timing pipeline before accepting a prepared playback snapshot', () => {
  expect(NATIVE_MODEL_VERSION).not.toBe('lv-chordia-1.1.0-submission-native-v2');
  expect(NATIVE_MODEL_VERSION).not.toBe('lv-chordia-1.1.0-submission-native-v3');
  expect(() =>
    assembleNativeWholeSong(
      { ...result(), modelVersion: 'lv-chordia-1.1.0-submission-native-v2' },
      {
        fingerprint: 'a'.repeat(64),
        profile: 'balanced',
        samples: 220500,
        waveform: [],
      },
    ),
  ).toThrow('Invalid complete-song recognition result');
});
it('assembles native eleventh and thirteenth labels without losing their constituent extensions', () => {
  const native = result();
  native.segments[0].label = 'C:11';
  native.segments[1].label = 'C:13';
  const analysis = assembleNativeWholeSong(native, {
    fingerprint: 'a'.repeat(64),
    profile: 'balanced',
    samples: native.sampleCount,
    waveform: [],
  });
  expect(analysis.segments.map((s) => s.chord)).toMatchObject([
    { root: 0, seventh: 'minor', extensions: [9, 11] },
    { root: 0, seventh: 'minor', extensions: [9, 11, 13] },
  ]);
  expect(native.segments.map((s) => s.label)).toEqual(['C:11', 'C:13']);
});
it('assembles the complete native region timeline without frame-level bass splitting', () => {
  const analysis = assembleNativeWholeSong(result(), {
    fingerprint: 'a'.repeat(64),
    profile: 'balanced',
    samples: 220500,
    waveform: [0.1],
  });
  expect(analysis.segments.map((s) => formatChord(s.chord))).toEqual(['G', 'D7/F#']);
  expect(analysis.duration).toBe(10);
  expect(analysis.modelVersion).toBe(NATIVE_MODEL_VERSION);
  expect(analysis.calibration).toBe('uncalibrated');
});
it('rejects wrong models, incomplete bounds, nonfinite support and mismatched PCM identity', () => {
  const metadata = {
    fingerprint: 'a'.repeat(64),
    profile: 'balanced' as const,
    samples: 220500,
    waveform: [0.1],
  };
  expect(() => assembleNativeWholeSong({ ...result(), modelVersion: 'wrong' }, metadata)).toThrow();
  expect(() => assembleNativeWholeSong({ ...result(), sampleCount: 220499 }, metadata)).toThrow();
  const gap = result();
  gap.segments[1].start = 5.2;
  expect(() => assembleNativeWholeSong(gap, metadata)).toThrow();
  const nonfinite = result();
  nonfinite.segments[0].score = NaN;
  expect(() => assembleNativeWholeSong(nonfinite, metadata)).toThrow();
});

it.each([196.7310657596372, 196.73106575963715])(
  'normalizes the complete native endpoint %s to the exact PCM duration',
  (nativeEnd) => {
    // 4,337,920 samples reproduced a cross-runtime JSON rounding difference.
    // Keep chord decisions and interior boundaries intact; only reconcile EOF.
    const native = result();
    native.sampleCount = 4337920;
    native.duration = nativeEnd;
    native.segments[1].end = nativeEnd;
    const original = structuredClone(native);
    const analysis = assembleNativeWholeSong(native, {
      fingerprint: 'a'.repeat(64),
      profile: 'balanced',
      samples: native.sampleCount,
      waveform: [],
    });
    expect(analysis.duration).toBe(native.sampleCount / 22050);
    expect(analysis.segments.at(-1)!.end).toBe(analysis.duration);
    expect(analysis.segments[0].end).toBe(5);
    expect(analysis.segments.map((s) => formatChord(s.chord))).toEqual(['G', 'D7/F#']);
    expect(native).toEqual(original);
  },
);

it.each([9.99, 10.01])('still rejects a materially incomplete or overlong endpoint %s', (end) => {
  const native = result();
  native.segments[1].end = end;
  expect(() =>
    assembleNativeWholeSong(native, {
      fingerprint: 'a'.repeat(64),
      profile: 'balanced',
      samples: native.sampleCount,
      waveform: [],
    }),
  ).toThrow('Incomplete native timeline');
});

const metadata = () => ({
  fingerprint: 'a'.repeat(64),
  profile: 'balanced' as const,
  samples: 220500,
  waveform: [],
});

it('keeps the bars, meter, steadiness and tuning the recognizer read', () => {
  const analysis = assembleNativeWholeSong(result(), metadata());
  expect(analysis.meter).toBe(4);
  expect(analysis.tempo).toBe(60);
  expect(analysis.grid).toEqual({ downbeats: [1, 5, 9], steady: true, source: NATIVE_BEAT_TRACKER });
  expect(analysis.tuningCents).toBe(-32);
});

it('reads a result without a beat grid as bars unknown rather than failing', () => {
  const native = result();
  delete native.downbeats;
  delete native.meter;
  delete native.rhythmSource;
  delete native.tuningCents;
  delete native.tempoSteady;
  const analysis = assembleNativeWholeSong(native, metadata());
  expect(analysis.meter).toBeNull();
  expect(analysis.grid).toEqual({ downbeats: [], steady: false, source: 'unknown' });
  expect(analysis.tuningCents).toBeNull();
});

it('rejects downbeats that are not beats and tuning past a quarter tone', () => {
  expect(() => assembleNativeWholeSong({ ...result(), downbeats: [1.5] }, metadata())).toThrow(
    'Analysis downbeats must be beats',
  );
  expect(() => assembleNativeWholeSong({ ...result(), tuningCents: 60 }, metadata())).toThrow(
    'quarter tone',
  );
});
