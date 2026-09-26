// @ts-nocheck
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalFileProvider } from './local';
import { SessionController } from '../application/session';
import type { Analysis } from '../domain/types';

class TestAudio extends EventTarget {
  preload = '';
  src = '';
  currentTime = 0;
  duration = 4;
  paused = true;
  playbackRate = 1;
  volume = 1;
  error: { code: number; message: string } | null = null;
  play: () => Promise<void> = async () => {
    this.paused = false;
  };
  pause() {
    this.paused = true;
  }
  load() {}
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
}

beforeEach(() => vi.stubGlobal('Audio', TestAudio));
afterEach(() => vi.unstubAllGlobals());

const analysis: Analysis = {
  id: 'analysis',
  fingerprint: 'audio',
  duration: 4,
  profile: 'fast',
  modelVersion: 'model',
  pipelineVersion: 'pipeline',
  segments: [],
  beats: [],
  tempo: null,
  meter: null,
  key: null,
  waveform: [],
  boundaries: [],
  createdAt: '2026-09-20',
  calibration: 'uncalibrated',
  warnings: [],
};

async function session() {
  const provider = new LocalFileProvider();
  const controller = new SessionController({
    player: provider,
    repository: { list: async () => ({ records: [], issues: [] }), save: async () => {} },
    analyzer: {
      pipelineVersion: 'pipeline',
      modelVersion: () => 'model',
      fingerprint: async () => 'audio',
      analyze: async () => analysis,
      demo: async () => ({ file: new Blob(), analysis }),
    },
  });
  controller.setProfile('fast');
  await controller.importFile(new File(['audio'], 'track.wav'));
  return { provider, controller, media: provider.audio as unknown as TestAudio };
}

it('reports native media decode errors in the visible session error state', async () => {
  const { provider, controller, media } = await session();
  await controller.togglePlayback();
  media.error = { code: 3, message: '' };
  media.dispatchEvent(new Event('error'));
  expect(controller.snapshot().error).toMatch(/decode/i);
  expect(provider.playing).toBe(false);
  expect(controller.snapshot().current?.track.name).toBe('track.wav');
  provider.release();
});

it('reports rejected automatic loop restart in the visible session error state', async () => {
  const { provider, controller, media } = await session();
  provider.setLoop({ start: 0, end: 4 });
  media.play = () => Promise.reject(new Error('Device unavailable'));
  media.dispatchEvent(new Event('ended'));
  await Promise.resolve();
  expect(controller.snapshot().error).toContain('Device unavailable');
  provider.release();
});

it('ignores late loop rejection and queued media error from a released source', async () => {
  const { provider, controller, media } = await session();
  provider.setLoop({ start: 0, end: 4 });
  let rejectPlay: ((error: Error) => void) | undefined;
  media.play = () =>
    new Promise((_, reject) => {
      rejectPlay = reject;
    });
  media.dispatchEvent(new Event('ended'));
  await controller.importFile(new File(['audio'], 'replacement.wav'));
  rejectPlay?.(new Error('Old device error'));
  await Promise.resolve();
  media.error = { code: 3, message: 'Old decode error' };
  media.dispatchEvent(new Event('error'));
  expect(controller.snapshot().error).toBeNull();
  provider.release();
});

it('disposing the session unsubscribes from subsequent provider errors', async () => {
  const { provider, controller } = await session();
  controller.dispose();
  expect(provider.available).toBe(false);
  provider.load(new Blob(['different audio']));
  const media = provider.audio as unknown as TestAudio;
  media.error = { code: 2, message: 'unreadable' };
  media.dispatchEvent(new Event('error'));
  expect(controller.snapshot().error).toBeNull();
  provider.release();
});

it('preserves the selected volume and speed when replacing a local source', () => {
  const provider = new LocalFileProvider();
  provider.load(new Blob(['first']));
  provider.setVolume(0.25);
  provider.setSpeed(0.75);
  provider.load(new Blob(['second']));
  expect(provider.audio.volume).toBe(0.25);
  expect(provider.audio.playbackRate).toBe(0.75);
  provider.release();
});

it('does not expose the previous media duration after release', () => {
  const provider = new LocalFileProvider();
  provider.load(new Blob(['audio']));
  expect(provider.duration).toBe(4);
  provider.release();
  expect(provider.duration).toBe(0);
});

it.each([NaN, Infinity, -Infinity])('rejects non-finite playback controls: %s', (value) => {
  const provider = new LocalFileProvider();
  expect(() => provider.setSpeed(value)).toThrow();
  expect(provider.audio.playbackRate).toBe(1);
  expect(() => provider.setVolume(value)).toThrow();
  expect(provider.audio.volume).toBe(1);
});

it.each([
  { start: -1, end: 2 },
  { start: 2, end: 2 },
  { start: 3, end: 2 },
  { start: NaN, end: 2 },
  { start: 0, end: Infinity },
])('rejects invalid loop ranges before media events can seek: %j', (range) => {
  const provider = new LocalFileProvider();
  provider.load(new Blob(['audio']));
  expect(() => provider.setLoop(range)).toThrow();
  provider.audio.currentTime = 3;
  provider.audio.dispatchEvent(new Event('timeupdate'));
  expect(provider.position).toBe(3);
  provider.release();
});

it('copies a valid loop so caller mutations cannot corrupt playback', () => {
  const provider = new LocalFileProvider();
  provider.load(new Blob(['audio']));
  const range = { start: 1, end: 3 };
  provider.setLoop(range);
  range.start = -10;
  provider.audio.currentTime = 3;
  provider.audio.dispatchEvent(new Event('timeupdate'));
  expect(provider.position).toBe(1);
  provider.setLoop(null);
  provider.audio.currentTime = 3;
  provider.audio.dispatchEvent(new Event('timeupdate'));
  expect(provider.position).toBe(3);
  provider.release();
});
