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

// A real element's load() pauses, zeroes the clock and drops playbackRate to defaultPlaybackRate.
function restartsOnLoad(media: TestAudio & { defaultPlaybackRate?: number }) {
  media.load = () => {
    media.currentTime = 0;
    media.paused = true;
    media.playbackRate = media.defaultPlaybackRate ?? 1;
  };
}

const stems = { instrumental: 'blob:band', vocals: 'blob:voice' };

it('keeps the place, the play state and the speed when the singer slider swaps the file', () => {
  const provider = new LocalFileProvider();
  provider.load(new Blob(['audio']));
  const media = provider.audio as unknown as TestAudio;
  restartsOnLoad(media);
  provider.setSpeed(0.75);
  provider.setStems(stems);
  media.currentTime = 2.5;
  media.paused = false;
  provider.setSinger(0.5);
  expect(media.src).toBe(stems.instrumental);
  expect(provider.position).toBe(2.5);
  expect(provider.playing).toBe(true);
  expect(provider.duration).toBe(4);
  media.dispatchEvent(new Event('loadedmetadata'));
  expect(media.currentTime).toBe(2.5);
  expect(media.paused).toBe(false);
  expect(media.playbackRate).toBe(0.75);
  provider.release();
});

it('does not lose the place when the slider crosses back before the swapped file has loaded', () => {
  const provider = new LocalFileProvider();
  provider.load(new Blob(['audio']));
  const media = provider.audio as unknown as TestAudio;
  restartsOnLoad(media);
  provider.setStems(stems);
  media.currentTime = 3;
  media.paused = false;
  provider.setSinger(0.5);
  provider.setSinger(1);
  media.dispatchEvent(new Event('loadedmetadata'));
  expect(media.currentTime).toBe(3);
  expect(media.paused).toBe(false);
  provider.release();
});

it('follows a seek and a pause made while the swapped file is still loading', () => {
  const provider = new LocalFileProvider();
  provider.load(new Blob(['audio']));
  const media = provider.audio as unknown as TestAudio;
  restartsOnLoad(media);
  provider.setStems(stems);
  media.currentTime = 1;
  media.paused = false;
  provider.setSinger(0.5);
  provider.seek(3);
  provider.pause();
  expect(provider.position).toBe(3);
  media.dispatchEvent(new Event('loadedmetadata'));
  expect(media.currentTime).toBe(3);
  expect(media.paused).toBe(true);
  provider.release();
});

const webkit = 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15';

function stubFileReader(read: string) {
  vi.stubGlobal(
    'FileReader',
    class {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      error = null;
      readAsDataURL() {
        queueMicrotask(() => {
          this.result = read;
          this.onload?.();
        });
      }
    },
  );
}

it('gives the element a data: URL on WebKit, whose blob: URLs play an MP3 from the wrong place', async () => {
  vi.stubGlobal('navigator', { userAgent: webkit });
  stubFileReader('data:application/octet-stream;base64,QUJD');
  const provider = new LocalFileProvider();
  provider.load(new Blob(['abc'], { type: 'audio/mpeg' }));
  const media = provider.audio as unknown as TestAudio;
  expect(provider.available).toBe(true);
  expect(media.src).toBe('');
  await Promise.resolve();
  await Promise.resolve();
  expect(media.src).toBe('data:audio/mpeg;base64,QUJD');
  provider.release();
});

it('holds a play pressed while the data: URL is still being made, then plays', async () => {
  vi.stubGlobal('navigator', { userAgent: webkit });
  stubFileReader('data:audio/mpeg;base64,QUJD');
  const provider = new LocalFileProvider();
  provider.load(new Blob(['abc'], { type: 'audio/mpeg' }));
  const media = provider.audio as unknown as TestAudio;
  await provider.play();
  expect(media.src).toBe('data:audio/mpeg;base64,QUJD');
  expect(media.paused).toBe(false);
  provider.release();
});

it('applies the singer once the original is ready when the stems arrive first', async () => {
  vi.stubGlobal('navigator', { userAgent: webkit });
  stubFileReader('data:audio/mpeg;base64,QUJD');
  const provider = new LocalFileProvider();
  provider.load(new Blob(['abc'], { type: 'audio/mpeg' }));
  const media = provider.audio as unknown as TestAudio;
  provider.setStems(stems);
  provider.setSinger(0.5);
  expect(media.src).toBe('');
  await Promise.resolve();
  await Promise.resolve();
  expect(media.src).toBe(stems.instrumental);
  provider.release();
});

it('a play with nothing readable rejects instead of waiting for ever', async () => {
  vi.stubGlobal('navigator', { userAgent: webkit });
  vi.stubGlobal(
    'FileReader',
    class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      error = null;
      readAsDataURL() {
        queueMicrotask(() => this.onerror?.());
      }
    },
  );
  const provider = new LocalFileProvider();
  provider.load(new Blob(['abc']));
  await expect(provider.play()).rejects.toThrow('could not be read');
  provider.release();
});
