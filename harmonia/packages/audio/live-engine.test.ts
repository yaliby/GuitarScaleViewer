// @ts-nocheck
import { expect, it } from 'vitest';
import type { CaptureSession, PcmBlock } from '../application/live-contracts';
import { StreamingChordEngine, liveChordIdentity } from './live-engine';
import { parseChord } from '../domain/chord';

const session: CaptureSession = {
  captureId: 'fixture',
  sampleRate: 48000,
  channels: 2,
  blockFrames: 960,
};
function block(index: number, silent = false): PcmBlock {
  return {
    ...session,
    sequence: index,
    firstFrame: index * 960,
    frameCount: 960,
    devicePosition: index * 960,
    qpc100ns: null,
    timestampValid: false,
    silent,
    discontinuity: false,
    droppedFramesBefore: 0,
    samples: Float32Array.from({ length: 1920 }, (_, i) =>
      silent
        ? 0
        : 0.2 * Math.sin((2 * Math.PI * 130.8128 * (index * 960 + Math.floor(i / 2))) / 48000),
    ),
  };
}
it('waits for full spectral and stabilization context and reports observed sample time', () => {
  const engine = new StreamingChordEngine(session);
  for (let i = 0; i < 10; i++) expect(engine.push(block(i)).current).toBeNull();
  const update = engine.push(block(10));
  expect(update.position).toBeCloseTo(0.22);
  expect(update.current).toBeNull();
  const recognized = engine.push(block(11));
  expect(recognized.current?.chord.kind).toBe('chord');
  expect(recognized.analyzedThrough).toBeLessThan(recognized.position);
  expect(recognized.lookaheadSeconds).toBeGreaterThan(0.139);
});
it('clears stale chord on explicit loss and distinguishes waiting from actual silence', () => {
  const engine = new StreamingChordEngine(session);
  for (let i = 0; i < 30; i++) engine.push(block(i));
  expect(engine.snapshot().current?.chord.kind).toBe('chord');
  const gap = engine.push({ ...block(35), discontinuity: true, droppedFramesBefore: 4800 });
  expect(gap.signal).toBe('waiting');
  expect(gap.current).toBeNull();
  expect(gap.recent).toHaveLength(0);
  for (let i = 36; i < 60; i++) engine.push(block(i, true));
  expect(engine.snapshot().signal).toBe('silence');
  expect(engine.snapshot().current).toBeNull();
});
it('rejects corrupt/stale blocks, backward frames, and unexpected formats', () => {
  const engine = new StreamingChordEngine(session);
  expect(() => engine.push({ ...block(0), captureId: 'old' })).toThrow();
  expect(() => engine.push({ ...block(0), samples: new Float32Array([NaN]) })).toThrow();
  expect(() => engine.push({ ...block(0), channels: 1 })).toThrow();
  engine.push(block(0));
  expect(() => engine.push(block(0))).toThrow();
  engine.close();
  expect(() => engine.push(block(1))).toThrow();
});
it('keeps buffers and recent history bounded during sustained listening and resets cleanly', () => {
  const engine = new StreamingChordEngine(session);
  for (let i = 0; i < 7000; i++) {
    const update = engine.push(block(i, i % 100 > 50));
    expect(update.bufferedFrames).toBeLessThan(6144);
    expect(update.recent.length).toBeLessThanOrEqual(120);
    if (update.recent.length)
      expect(update.recent[0].start).toBeGreaterThanOrEqual(update.position - 120);
  }
  const reset = engine.reset('source loss');
  expect(reset.current).toBeNull();
  expect(reset.recent).toEqual([]);
  expect(reset.signal).toBe('waiting');
  expect(() => engine.push(block(0))).toThrow();
});
it('produces identical estimates/history regardless of native packet partition', () => {
  const run = (sizes: number[]) => {
    const engine = new StreamingChordEngine(session);
    for (let first = 0, sequence = 0; first < 48000 * 2; sequence++) {
      const frameCount = Math.min(sizes[sequence % sizes.length], 48000 * 2 - first);
      const pcm = Float32Array.from(
        { length: frameCount * 2 },
        (_, i) =>
          0.2 *
          Math.sin(
            (2 * Math.PI * (first < 48000 ? 130.8128 : 146.8324) * (first + Math.floor(i / 2))) /
              48000,
          ),
      );
      // Frequency transition is sample-defined, independent of packet partitions.
      for (let i = 0; i < frameCount; i++)
        for (let c = 0; c < 2; c++)
          pcm[i * 2 + c] =
            0.2 *
            Math.sin(
              (2 * Math.PI * (first + i < 48000 ? 130.8128 : 146.8324) * (first + i)) / 48000,
            );
      engine.push({ ...block(sequence), firstFrame: first, frameCount, samples: pcm });
      first += frameCount;
    }
    return engine.snapshot();
  };
  expect(run([960])).toEqual(run([13, 1, 319, 960, 7]));
});
it('retains omitted tones in canonical chord identity', () => {
  const chord = parseChord('C7');
  if (chord.kind !== 'chord') throw new Error('fixture');
  expect(liveChordIdentity({ ...chord, omittedTones: [5] })).not.toBe(liveChordIdentity(chord));
});
it('accepts finite PCM above nominal full scale and snapshots cannot mutate engine chords', () => {
  const engine = new StreamingChordEngine(session);
  for (let i = 0; i < 20; i++) {
    const pcm = block(i);
    pcm.samples = pcm.samples.map((v) => v * 8);
    engine.push(pcm);
  }
  const snapshot = engine.snapshot();
  expect(snapshot.signal).toBe('audio');
  if (snapshot.current?.chord.kind !== 'chord') throw new Error('fixture');
  snapshot.current.chord.omittedTones.push(11);
  expect(engine.snapshot().current?.chord).not.toEqual(snapshot.current.chord);
});
