// @ts-nocheck
import type {
  CaptureSession,
  LiveAnalysisUpdate,
  LiveChordSegment,
  PcmBlock,
} from '../application/live-contracts';
import type { Chord, ChordAlternative } from '../domain/types';
import { PeakChromaKernel } from './frame-kernel';
import { TemplateRecognizer, type ChordRecognizer } from './recognizer';
import { RESAMPLER_LOOKAHEAD, StatefulResampler } from './stateful-resampler';
import { validateCaptureSession } from './live-protocol';

const RATE = 22050,
  SIZE = 4096,
  HOP = 512,
  RADIUS = 2;
/** Includes all canonical structure; display spelling does not alter recognition identity. */
export function liveChordIdentity(chord: Chord): string {
  return chord.kind === 'chord'
    ? JSON.stringify([
        chord.root,
        chord.triad,
        chord.fifth,
        chord.seventh,
        chord.extensions,
        chord.alterations,
        chord.addedTones,
        chord.omittedTones,
        chord.bass,
      ])
    : chord.kind;
}
export class StreamingChordEngine {
  private resampler = new StatefulResampler();
  private kernel = new PeakChromaKernel();
  private readonly pcm = new Float32Array(8192);
  private received = 0;
  private nextStart = 0;
  private origin = 0;
  private nextFrame: number | null = null;
  private sequence: number | null = null;
  private lastEnd = 0;
  private position = 0;
  private through = 0;
  private discontinuities = 0;
  private closed = false;
  private predictions: { index: number; time: number; choices: ChordAlternative[] }[] = [];
  private featureIndex = 0;
  private nextCommit = 0;
  private recent: LiveChordSegment[] = [];
  private current: ChordAlternative | null = null;
  private signal: LiveAnalysisUpdate['signal'] = 'waiting';
  constructor(
    private readonly session: CaptureSession,
    private readonly recognizer: ChordRecognizer = new TemplateRecognizer(),
  ) {
    validateCaptureSession(session);
  }

  private validate(block: PcmBlock): void {
    validateCaptureSession(block);
    if (
      this.closed ||
      block.captureId !== this.session.captureId ||
      !Number.isSafeInteger(block.sequence) ||
      block.sequence < 0 ||
      !Number.isSafeInteger(block.firstFrame) ||
      block.firstFrame < 0 ||
      !Number.isSafeInteger(block.frameCount) ||
      block.frameCount < 1 ||
      block.frameCount > 960 ||
      !Number.isSafeInteger(block.firstFrame + block.frameCount) ||
      !Number.isSafeInteger(block.droppedFramesBefore) ||
      block.droppedFramesBefore < 0 ||
      typeof block.silent !== 'boolean' ||
      typeof block.discontinuity !== 'boolean' ||
      !(block.samples instanceof Float32Array) ||
      block.samples.length !== block.frameCount * 2 ||
      block.samples.some((v) => !Number.isFinite(v)) ||
      (this.sequence !== null && block.sequence <= this.sequence) ||
      block.firstFrame < this.lastEnd
    )
      throw new Error('Invalid, stale or out-of-order live PCM block');
  }
  push(block: PcmBlock): LiveAnalysisUpdate {
    this.validate(block);
    if (
      block.discontinuity ||
      block.droppedFramesBefore > 0 ||
      (this.nextFrame !== null && block.firstFrame !== this.nextFrame) ||
      (this.sequence !== null && block.sequence !== this.sequence + 1)
    )
      this.reset('Capture discontinuity');
    if (this.nextFrame === null) this.origin = block.firstFrame / 48000;
    this.sequence = block.sequence;
    this.nextFrame = block.firstFrame + block.frameCount;
    this.lastEnd = this.nextFrame;
    this.position = this.nextFrame / 48000;
    const mono = new Float32Array(block.frameCount);
    if (!block.silent)
      for (let i = 0; i < mono.length; i++)
        mono[i] = (block.samples[i * 2] + block.samples[i * 2 + 1]) / 2;
    const samples = this.resampler.push(mono);
    for (const sample of samples) this.pcm[this.received++ % this.pcm.length] = sample;
    while (this.nextStart + SIZE <= this.received) {
      const center = this.nextStart + SIZE / 2;
      const frame = this.kernel.frame((index) => this.pcm[index % this.pcm.length], center, RATE);
      this.predictions.push({
        index: this.featureIndex++,
        time: this.origin + center / RATE,
        choices: this.recognizer.predict(frame),
      });
      this.nextStart += HOP;
      this.commitAvailable();
    }
    return this.snapshot();
  }
  private commitAvailable(): void {
    while (this.featureIndex - 1 >= this.nextCommit + RADIUS) {
      const focus = this.predictions.find((p) => p.index === this.nextCommit)!;
      const votes = new Map<string, { candidate: ChordAlternative; weight: number }>();
      for (const prediction of this.predictions) {
        if (Math.abs(prediction.index - this.nextCommit) > RADIUS) continue;
        const candidate = prediction.choices[0],
          key = liveChordIdentity(candidate.chord);
        votes.set(key, { candidate, weight: (votes.get(key)?.weight ?? 0) + candidate.score });
      }
      const chosen = [...votes.values()].sort((a, b) => b.weight - a.weight)[0].candidate;
      this.through = focus.time + HOP / RATE;
      this.signal = chosen.chord.kind === 'none' ? 'silence' : 'audio';
      this.current = chosen.chord.kind === 'none' ? null : chosen;
      const previous = this.recent.at(-1);
      if (
        previous &&
        liveChordIdentity(previous.estimate.chord) === liveChordIdentity(chosen.chord)
      )
        previous.end = this.through;
      else this.recent.push({ start: focus.time, end: this.through, estimate: chosen });
      this.nextCommit++;
      while (this.predictions[0]?.index < this.nextCommit - RADIUS) this.predictions.shift();
    }
  }
  snapshot(): LiveAnalysisUpdate {
    const cutoff = this.position - 120;
    while (this.recent.length > 120 || (this.recent[0] && this.recent[0].end <= cutoff))
      this.recent.shift();
    if (this.recent[0]) this.recent[0].start = Math.max(this.recent[0].start, cutoff);
    return structuredClone({
      captureId: this.session.captureId,
      position: this.position,
      analyzedThrough: this.through,
      lookaheadSeconds: RESAMPLER_LOOKAHEAD + (SIZE / 2 + RADIUS * HOP) / RATE,
      signal: this.signal,
      current: this.current,
      recent: this.recent,
      discontinuities: this.discontinuities,
      bufferedFrames: this.received - this.nextStart + this.resampler.retainedFrames,
    });
  }
  reset(_reason: string): LiveAnalysisUpdate {
    if (this.closed) throw new Error('Live analysis is closed');
    this.discontinuities++;
    this.resampler = new StatefulResampler();
    this.kernel = new PeakChromaKernel();
    this.pcm.fill(0);
    this.received = 0;
    this.nextStart = 0;
    this.nextFrame = null;
    this.featureIndex = 0;
    this.nextCommit = 0;
    this.predictions = [];
    this.current = null;
    this.recent = [];
    this.signal = 'waiting';
    this.through = this.position;
    return this.snapshot();
  }
  close(): void {
    if (!this.closed) this.reset('Closed');
    this.closed = true;
  }
}
