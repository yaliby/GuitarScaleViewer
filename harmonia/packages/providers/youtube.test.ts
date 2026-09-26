// @ts-nocheck
import { afterEach, expect, it, vi } from 'vitest';
import {
  parseYouTubeVideoId,
  YouTubeProvider,
  type YouTubePlayer,
  type YouTubePlayerOptions,
} from './youtube';

it.each([
  'M7lc1UVf-VE',
  'https://www.youtube.com/watch?v=M7lc1UVf-VE&feature=share',
  'https://youtube.com/watch?v=M7lc1UVf-VE',
  'https://m.youtube.com/watch?v=M7lc1UVf-VE',
  'https://youtu.be/M7lc1UVf-VE?si=share',
  'https://www.youtube.com/embed/M7lc1UVf-VE',
  'https://www.youtube.com/shorts/M7lc1UVf-VE',
  'https://www.youtube.com/live/M7lc1UVf-VE',
])('extracts only the video identity from supported input %s', (source) => {
  expect(parseYouTubeVideoId(source)).toBe('M7lc1UVf-VE');
});

it.each([
  '',
  'M7lc1UVf-VE/extra',
  'http://www.youtube.com/watch?v=M7lc1UVf-VE',
  'https://youtube.com.evil.test/watch?v=M7lc1UVf-VE',
  'https://youtube.com@evil.test/watch?v=M7lc1UVf-VE',
  'https://user:password@youtube.com/watch?v=M7lc1UVf-VE',
  'https://youtube.com:8443/watch?v=M7lc1UVf-VE',
  'https://www.youtube.com/watch?v=M7lc1UVf-VE&v=dQw4w9WgXcQ',
  'https://www.youtube.com/playlist?list=M7lc1UVf-VE',
  'https://www.youtube.com/watch?v=bad',
  'https://youtu.be/M7lc1UVf-VE/extra',
  'javascript:alert(1)',
])('rejects unsupported or ambiguous source %s', (source) => {
  expect(() => parseYouTubeVideoId(source)).toThrow(/YouTube/);
});

afterEach(() => vi.useRealTimers());

// The only double is the external SDK; adapter state, promises and timers are real.
function setup() {
  const players: Array<YouTubePlayer & { options: YouTubePlayerOptions }> = [];
  const provider = new YouTubeProvider(
    (_host, options) => {
      const player = {
        options,
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        seekTo: vi.fn(),
        getCurrentTime: vi.fn(() => 12.5),
        getDuration: vi.fn(() => 90),
        destroy: vi.fn(),
      };
      players.push(player);
      return player;
    },
    { origin: 'http://127.0.0.1:1425', timeoutMs: 1000 },
  );
  const host = {} as HTMLElement;
  async function ready() {
    const loading = provider.load('M7lc1UVf-VE', host);
    const player = players.at(-1)!;
    player.options.events.onReady();
    await loading;
    return player;
  }
  return { provider, players, host, ready };
}

it('requires an explicit ready player and never exposes stream analysis or offline access', async () => {
  const { provider, players, host } = setup();
  expect(provider.available).toBe(false);
  expect(provider.position).toBe(0);
  expect(provider.duration).toBe(0);
  await expect(provider.play()).rejects.toMatchObject({ code: 'not-ready' });
  expect(provider.capabilities.rawAnalysisAvailable).toBe(false);
  expect(provider.capabilities.offlineAvailable).toBe(false);
  const loading = provider.load('https://youtu.be/M7lc1UVf-VE', host);
  expect(provider.status).toBe('loading');
  expect(provider.available).toBe(false);
  expect(players[0].options).toMatchObject({
    videoId: 'M7lc1UVf-VE',
    width: 480,
    height: 270,
    playerVars: { origin: 'http://127.0.0.1:1425', autoplay: 0, controls: 1, playsinline: 1 },
  });
  players[0].options.events.onReady();
  await loading;
  expect(provider.status).toBe('ready');
  expect(provider.available).toBe(true);
  expect(provider.position).toBe(12.5);
  expect(provider.duration).toBe(90);
  provider.dispose();
});

it('resolves play only after actual PLAYING and shares concurrent requests', async () => {
  const { provider, ready } = setup();
  const player = await ready();
  const playing = provider.play();
  expect(provider.play()).toBe(playing);
  let settled = false;
  void playing.then(() => {
    settled = true;
  });
  player.options.events.onStateChange({ data: 3 });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(provider.playing).toBe(false);
  player.options.events.onStateChange({ data: 1 });
  await playing;
  expect(provider.playing).toBe(true);
  provider.pause();
  player.options.events.onStateChange({ data: 2 });
  expect(provider.status).toBe('paused');
  player.options.events.onStateChange({ data: 0 });
  expect(provider.status).toBe('ended');
  provider.dispose();
});

it('rejects invalid replacement without disturbing an existing ready player', async () => {
  const { provider, ready, host, players } = setup();
  const player = await ready();
  await expect(provider.load('https://evil.test/video', host)).rejects.toMatchObject({
    code: 'invalid-source',
  });
  expect(provider.available).toBe(true);
  expect(players).toHaveLength(1);
  expect(player.destroy).not.toHaveBeenCalled();
  provider.dispose();
});

it.each([2, 5, 100, 101, 150, 153, 999])(
  'maps SDK error %s to an actionable typed failure',
  async (sdkCode) => {
    const { provider, ready } = setup();
    const player = await ready();
    const errors: Error[] = [];
    provider.onError((error) => errors.push(error));
    const playing = provider.play();
    const expected = {
      2: 'invalid-source',
      5: 'playback-failed',
      100: 'unavailable',
      101: 'embedding-disabled',
      150: 'embedding-disabled',
      153: 'client-identification',
      999: 'playback-failed',
    }[sdkCode];
    const failure = expect(playing).rejects.toMatchObject({ code: expected, sdkCode });
    player.options.events.onError({ data: sdkCode });
    await failure;
    expect(provider.status).toBe('error');
    expect(provider.available).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/try|choose|reopen|identification|environment/i);
    provider.dispose();
  },
);

it('keeps a blocked player recoverable by an explicit playback retry', async () => {
  const { provider, ready } = setup();
  const player = await ready();
  const blocked = expect(provider.play()).rejects.toMatchObject({ code: 'autoplay-blocked' });
  player.options.events.onAutoplayBlocked();
  await blocked;
  expect(provider.status).toBe('blocked');
  expect(provider.available).toBe(true);
  expect(provider.error?.message).toMatch(/player|play/i);
  const retry = provider.play();
  player.options.events.onStateChange({ data: 1 });
  await retry;
  expect(provider.error).toBeNull();
  expect(provider.playing).toBe(true);
  provider.dispose();
});

it('rejects pending load on replacement and ignores all old player events', async () => {
  const { provider, players, host } = setup();
  const first = expect(provider.load('M7lc1UVf-VE', host)).rejects.toMatchObject({
    code: 'cancelled',
  });
  const old = players[0];
  const next = provider.load('dQw4w9WgXcQ', host);
  await first;
  expect(old.destroy).toHaveBeenCalledOnce();
  old.options.events.onReady();
  old.options.events.onStateChange({ data: 1 });
  old.options.events.onError({ data: 100 });
  old.options.events.onAutoplayBlocked();
  expect(provider.status).toBe('loading');
  expect(provider.error).toBeNull();
  players[1].options.events.onReady();
  await next;
  expect(provider.status).toBe('ready');
  provider.dispose();
});

it.each(['replace', 'pause', 'dispose'] as const)('rejects pending play on %s', async (action) => {
  const { provider, ready, host, players } = setup();
  const old = await ready();
  const pending = expect(provider.play()).rejects.toMatchObject({ code: 'cancelled' });
  if (action === 'replace') {
    const load = provider.load('dQw4w9WgXcQ', host);
    players[1].options.events.onReady();
    await load;
  } else if (action === 'pause') provider.pause();
  else provider.dispose();
  await pending;
  if (action !== 'pause') {
    old.options.events.onStateChange({ data: 1 });
    expect(provider.playing).toBe(false);
  }
  provider.dispose();
});

it('bounds readiness and ignores late events after timeout', async () => {
  vi.useFakeTimers();
  const { provider, players, host } = setup();
  const failure = expect(provider.load('M7lc1UVf-VE', host)).rejects.toMatchObject({
    code: 'timeout',
  });
  await vi.advanceTimersByTimeAsync(1000);
  await failure;
  players[0].options.events.onReady();
  expect(provider.status).toBe('error');
  expect(provider.available).toBe(false);
  expect(players[0].destroy).toHaveBeenCalledOnce();
  provider.dispose();
});

it('bounds playback startup and destroys its late-playing source', async () => {
  vi.useFakeTimers();
  const { provider, ready } = setup();
  const player = await ready();
  const failure = expect(provider.play()).rejects.toMatchObject({ code: 'timeout' });
  await vi.advanceTimersByTimeAsync(1000);
  await failure;
  player.options.events.onStateChange({ data: 1 });
  expect(provider.playing).toBe(false);
  expect(player.destroy).toHaveBeenCalledOnce();
  provider.dispose();
});

it('rejects a pending load on dispose and prevents resurrection', async () => {
  const { provider, host, players } = setup();
  const failure = expect(provider.load('M7lc1UVf-VE', host)).rejects.toMatchObject({
    code: 'cancelled',
  });
  provider.dispose();
  provider.dispose();
  await failure;
  players[0].options.events.onReady();
  expect(provider.status).toBe('disposed');
  expect(provider.position).toBe(0);
  expect(players[0].destroy).toHaveBeenCalledOnce();
  await expect(provider.load('M7lc1UVf-VE', host)).rejects.toMatchObject({ code: 'disposed' });
});

it('validates seeks and uses the SDK clock instead of fabricating a position', async () => {
  const { provider, ready } = setup();
  const player = await ready();
  for (const seconds of [NaN, Infinity, -Infinity])
    expect(() => provider.seek(seconds)).toThrow(/finite/i);
  provider.seek(-1);
  expect(player.seekTo).toHaveBeenLastCalledWith(0, true);
  provider.seek(120);
  expect(player.seekTo).toHaveBeenLastCalledWith(90, true);
  expect(provider.position).toBe(12.5);
  vi.mocked(player.getCurrentTime).mockReturnValue(NaN);
  vi.mocked(player.getDuration).mockReturnValue(Infinity);
  expect(provider.position).toBe(0);
  expect(provider.duration).toBe(0);
  provider.dispose();
});

it.each([
  'null',
  'file:///a',
  'https://example.com/path',
  'https://user@example.com',
  'http://example.com',
])('rejects insecure or non-origin identification %s', (origin) => {
  expect(
    () =>
      new YouTubeProvider(
        () => {
          throw new Error('unused');
        },
        { origin },
      ),
  ).toThrow(/origin/i);
});

it('reports factory failures and supports unsubscribing errors', async () => {
  const provider = new YouTubeProvider(
    () => {
      throw new Error('SDK unavailable');
    },
    { origin: 'https://example.com' },
  );
  const errors: Error[] = [];
  const unsubscribe = provider.onError((error) => errors.push(error));
  await expect(provider.load('M7lc1UVf-VE', {} as HTMLElement)).rejects.toMatchObject({
    code: 'playback-failed',
  });
  expect(provider.status).toBe('error');
  expect(errors).toHaveLength(1);
  unsubscribe();
  await expect(provider.load('M7lc1UVf-VE', {} as HTMLElement)).rejects.toMatchObject({
    code: 'playback-failed',
  });
  expect(errors).toHaveLength(1);
  provider.dispose();
});

it.each([0, 2])(
  'cancels pending play when the official player stops with state %s',
  async (data) => {
    vi.useFakeTimers();
    const { provider, ready } = setup();
    const player = await ready();
    const pending = expect(provider.play()).rejects.toMatchObject({ code: 'cancelled' });
    player.options.events.onStateChange({ data });
    await pending;
    await vi.advanceTimersByTimeAsync(1500);
    expect(provider.available).toBe(true);
    expect(provider.error).toBeNull();
    provider.dispose();
  },
);

it('rejects load on initialization errors and cannot be revived by a late ready event', async () => {
  const { provider, players, host } = setup();
  const pending = expect(provider.load('M7lc1UVf-VE', host)).rejects.toMatchObject({
    code: 'client-identification',
  });
  players[0].options.events.onError({ data: 153 });
  await pending;
  players[0].options.events.onReady();
  expect(provider.available).toBe(false);
  expect(provider.status).toBe('error');
  provider.dispose();
});

it('rejects a construction failure even if an injected factory reports ready synchronously', async () => {
  const provider = new YouTubeProvider(
    (_host, options) => {
      options.events.onReady();
      throw new Error('Construction failed after callback');
    },
    { origin: 'https://example.com' },
  );
  await expect(provider.load('M7lc1UVf-VE', {} as HTMLElement)).rejects.toMatchObject({
    code: 'playback-failed',
  });
  expect(provider.available).toBe(false);
  provider.dispose();
});

it('turns a disappeared SDK clock into an explicit playback failure', async () => {
  const { provider, ready } = setup();
  const player = await ready();
  vi.mocked(player.getCurrentTime).mockImplementation(() => {
    throw new Error('Iframe unavailable');
  });
  expect(provider.position).toBe(0);
  expect(provider.status).toBe('error');
  expect(provider.error?.code).toBe('playback-failed');
  expect(provider.available).toBe(false);
  provider.dispose();
});
