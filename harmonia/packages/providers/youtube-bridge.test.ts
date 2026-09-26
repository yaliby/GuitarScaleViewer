// @ts-nocheck
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { YouTubeProvider, type YouTubePlayerOptions } from './youtube';
import { YouTubeBridgeProvider } from './youtube-bridge';
import { YouTubeBridgeEndpoint } from './youtube-endpoint';
import {
  LEASE_MS,
  MAX_PROVIDER_SECONDS,
  type BridgeEvent,
  type BridgeTransport,
} from './youtube-bridge-protocol';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function fixture(timeoutMs = 15000) {
  const parent = { origin: 'http://tauri.localhost', source: {} };
  const child = { origin: 'http://127.0.0.1:8123', source: {} };
  const parentListeners = new Set<(e: BridgeEvent) => void>();
  const childListeners = new Set<(e: BridgeEvent) => void>();
  const sent: Array<{ to: 'parent' | 'child'; data: string; origin: string }> = [];
  const wire = { toParent: true, toChild: true };
  const parentPort: BridgeTransport = {
    send(data, origin) {
      sent.push({ to: 'child', data, origin });
      if (wire.toChild) for (const receive of childListeners) receive({ data, ...parent });
    },
    subscribe(receive) {
      parentListeners.add(receive);
      return () => {
        parentListeners.delete(receive);
      };
    },
  };
  const childPort: BridgeTransport = {
    send(data, origin) {
      sent.push({ to: 'parent', data, origin });
      if (wire.toParent) for (const receive of parentListeners) receive({ data, ...child });
    },
    subscribe(receive) {
      childListeners.add(receive);
      return () => {
        childListeners.delete(receive);
      };
    },
  };
  const players: Array<{
    options: YouTubePlayerOptions;
    playVideo: ReturnType<typeof vi.fn>;
    pauseVideo: ReturnType<typeof vi.fn>;
    seekTo: ReturnType<typeof vi.fn>;
    getCurrentTime: ReturnType<typeof vi.fn>;
    getDuration: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }> = [];
  const proxy = new YouTubeBridgeProvider(parentPort, { peer: child, timeoutMs });
  const endpoint = new YouTubeBridgeEndpoint(
    childPort,
    { peer: parent, session: proxy.session },
    () => ({
      host: {} as HTMLElement,
      provider: new YouTubeProvider(
        (_host, options) => {
          const player = {
            options,
            playVideo: vi.fn(),
            pauseVideo: vi.fn(),
            seekTo: vi.fn(),
            getCurrentTime: vi.fn(() => 3),
            getDuration: vi.fn(() => 90),
            destroy: vi.fn(),
          };
          players.push(player);
          return player;
        },
        { origin: child.origin },
      ),
    }),
  );
  const inject = (side: 'parent' | 'child', data: unknown, override: Partial<BridgeEvent> = {}) => {
    for (const receive of side === 'parent' ? parentListeners : childListeners)
      receive({ ...(side === 'parent' ? child : parent), data, ...override });
  };
  async function ready() {
    const load = proxy.load('https://youtu.be/M7lc1UVf-VE');
    const player = players.at(-1)!;
    player.options.events.onReady();
    await load;
    return player;
  }
  const close = () => {
    proxy.dispose();
    endpoint.dispose();
  };
  return {
    proxy,
    endpoint,
    ready,
    players,
    sent,
    wire,
    inject,
    close,
    parentListeners,
    childListeners,
    parent,
    child,
  };
}

it('loads through the real adapter and acknowledges play only after its PLAYING event', async () => {
  const f = fixture();
  expect(f.proxy.available).toBe(false);
  expect(f.proxy.capabilities.rawAnalysisAvailable).toBe(false);
  expect(f.proxy.capabilities.offlineAvailable).toBe(false);
  const player = await f.ready();
  expect(f.proxy.available).toBe(true);
  expect(f.proxy.position).toBe(3);
  const play = f.proxy.play();
  let done = false;
  void play.then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  player.options.events.onStateChange({ data: 1 });
  await play;
  expect(f.proxy.playing).toBe(true);
  player.getCurrentTime.mockReturnValue(4);
  await vi.advanceTimersByTimeAsync(250);
  expect(f.proxy.position).toBe(4);
  f.proxy.pause();
  player.options.events.onStateChange({ data: 2 });
  await vi.advanceTimersByTimeAsync(250);
  expect(f.proxy.status).toBe('paused');
  f.proxy.seek(5);
  expect(player.seekTo).toHaveBeenCalledWith(5, true);
  expect(
    f.sent.every(
      (packet) => packet.origin === (packet.to === 'parent' ? f.parent.origin : f.child.origin),
    ),
  ).toBe(true);
  f.close();
});

it.each(['origin', 'source', 'session', 'generation'] as const)(
  'rejects a forged proxy reply with the wrong %s',
  async (field) => {
    const f = fixture();
    f.wire.toParent = false;
    const load = f.proxy.load('M7lc1UVf-VE');
    f.players[0].options.events.onReady();
    await Promise.resolve();
    const packet = JSON.parse(f.sent.find((packet) => packet.to === 'parent')!.data);
    const event: Partial<BridgeEvent> = {};
    if (field === 'origin') event.origin = 'https://attacker.example';
    else if (field === 'source') event.source = {};
    else packet[field] = crypto.randomUUID();
    f.inject('parent', JSON.stringify(packet), event);
    expect(f.proxy.available).toBe(false);
    f.inject('parent', f.sent.find((packet) => packet.to === 'parent')!.data);
    await load;
    expect(f.proxy.available).toBe(true);
    f.close();
  },
);

it.each(['origin', 'source', 'session'] as const)(
  'endpoint rejects a forged load from the wrong %s',
  async (field) => {
    const f = fixture();
    f.wire.toChild = false;
    const failure = expect(f.proxy.load('M7lc1UVf-VE')).rejects.toMatchObject({
      code: 'cancelled',
    });
    const packet = JSON.parse(f.sent[0].data);
    const event: Partial<BridgeEvent> = {};
    if (field === 'origin') event.origin = 'https://attacker.example';
    else if (field === 'source') event.source = {};
    else packet.session = crypto.randomUUID();
    f.inject('child', JSON.stringify(packet), event);
    expect(f.players).toHaveLength(0);
    f.close();
    await failure;
  },
);

it('rejects old generations after replacement and cancels an outstanding play', async () => {
  const f = fixture();
  const old = await f.ready();
  const oldReply = f.sent.find((packet) => packet.to === 'parent')!.data;
  const cancelled = expect(f.proxy.play()).rejects.toMatchObject({ code: 'cancelled' });
  const load = f.proxy.load('dQw4w9WgXcQ');
  await cancelled;
  expect(old.destroy).toHaveBeenCalledOnce();
  old.options.events.onStateChange({ data: 1 });
  f.inject('parent', oldReply);
  expect(f.proxy.available).toBe(false);
  f.players[1].options.events.onReady();
  await load;
  expect(f.proxy.status).toBe('ready');
  f.close();
});

it('ignores duplicate request IDs and out-of-order snapshots without rolling the clock back', async () => {
  const f = fixture();
  const player = await f.ready();
  const oldReply = f.sent.find((packet) => packet.to === 'parent')!.data;
  f.proxy.seek(5);
  const seek = f.sent.filter((packet) => packet.to === 'child').at(-1)!.data;
  f.inject('child', seek);
  expect(player.seekTo).toHaveBeenCalledTimes(1);
  player.getCurrentTime.mockReturnValue(8);
  await vi.advanceTimersByTimeAsync(250);
  expect(f.proxy.position).toBe(8);
  f.inject('parent', oldReply);
  expect(f.proxy.position).toBe(8);
  f.close();
});

it('does not dispatch arbitrary methods, oversized strings or malformed packets', async () => {
  const f = fixture();
  const player = await f.ready();
  const load = JSON.parse(f.sent[0].data);
  f.inject('child', JSON.stringify({ ...load, id: 999, op: 'invoke', command: 'delete_track' }));
  f.inject('child', 'x'.repeat(2049));
  f.inject('child', '{');
  f.proxy.seek(4);
  expect(player.seekTo).toHaveBeenCalledOnce();
  expect(f.players).toHaveLength(1);
  f.close();
});

it('times out a pending operation, disposes its remote player, and ignores late SDK events', async () => {
  const f = fixture(300);
  const player = await f.ready();
  const failure = expect(f.proxy.play()).rejects.toMatchObject({ code: 'timeout' });
  await vi.advanceTimersByTimeAsync(301);
  await failure;
  expect(player.destroy).toHaveBeenCalledOnce();
  player.options.events.onStateChange({ data: 1 });
  expect(f.proxy.available).toBe(false);
  expect(f.proxy.error?.code).toBe('timeout');
  f.close();
});

it('expires the endpoint lease and destroys pending loading work when parent messages stop', async () => {
  const f = fixture();
  const failure = expect(f.proxy.load('M7lc1UVf-VE')).rejects.toMatchObject({ code: 'offline' });
  f.wire.toChild = false;
  await vi.advanceTimersByTimeAsync(LEASE_MS + 1250);
  await failure;
  expect(f.players[0].destroy).toHaveBeenCalledOnce();
  expect(f.proxy.available).toBe(false);
  f.close();
});

it('marks a dead child connection offline and rejects pending play', async () => {
  const f = fixture();
  const player = await f.ready();
  f.wire.toParent = false;
  f.wire.toChild = false;
  const failure = expect(f.proxy.play()).rejects.toMatchObject({ code: 'offline' });
  await vi.advanceTimersByTimeAsync(LEASE_MS + 1250);
  await failure;
  expect(f.proxy.error?.message).toMatch(/connection|reopen/i);
  expect(player.destroy).toHaveBeenCalledOnce();
  f.close();
});

it('preserves autoplay-blocked recovery and maps fatal SDK errors without forwarding arbitrary text', async () => {
  const f = fixture();
  const player = await f.ready();
  const blocked = expect(f.proxy.play()).rejects.toMatchObject({ code: 'autoplay-blocked' });
  player.options.events.onAutoplayBlocked();
  await blocked;
  expect(f.proxy.status).toBe('blocked');
  expect(f.proxy.available).toBe(true);
  const retry = f.proxy.play();
  player.options.events.onStateChange({ data: 1 });
  await retry;
  expect(f.proxy.error).toBeNull();
  player.options.events.onError({ data: 153 });
  expect(f.proxy.error?.code).toBe('client-identification');
  expect(f.proxy.available).toBe(false);
  f.close();
});

it('bounds clock and seek values and rejects impossible remote state', async () => {
  const f = fixture();
  const player = await f.ready();
  for (const seconds of [NaN, Infinity, -1, MAX_PROVIDER_SECONDS + 1])
    expect(() => f.proxy.seek(seconds)).toThrow();
  expect(player.seekTo).not.toHaveBeenCalled();
  player.getCurrentTime.mockReturnValue(100);
  await vi.advanceTimersByTimeAsync(250);
  expect(f.proxy.error?.code).toBe('playback-failed');
  expect(f.proxy.available).toBe(false);
  expect(player.destroy).toHaveBeenCalledOnce();
  f.close();
});

it('bounds pending requests and keeps disposal idempotent', async () => {
  const f = fixture();
  const player = await f.ready();
  f.wire.toParent = false;
  const errors: string[] = [];
  f.proxy.onError((error) => errors.push(error.code));
  for (let i = 0; i < 20; i++) f.proxy.seek(i);
  await Promise.resolve();
  expect(errors).toContain('rate-limit');
  expect(player.seekTo.mock.calls.length).toBeLessThanOrEqual(8);
  f.close();
  f.close();
  expect(f.parentListeners.size).toBe(0);
  expect(f.childListeners.size).toBe(0);
  expect(player.destroy).toHaveBeenCalledOnce();
});

it('rejects out-of-order unsolicited snapshots and replies with unknown request identity', async () => {
  const f = fixture();
  const player = await f.ready();
  await vi.advanceTimersByTimeAsync(250);
  const old = f.sent.filter((p) => JSON.parse(p.data).kind === 'snapshot').at(-1)!.data;
  player.getCurrentTime.mockReturnValue(8);
  await vi.advanceTimersByTimeAsync(250);
  f.inject('parent', old);
  expect(f.proxy.position).toBe(8);
  const forged = {
    ...JSON.parse(old),
    kind: 'reply',
    id: 999,
    op: 'play',
    error: null,
    snapshot: { ...JSON.parse(old).snapshot, sequence: 999, status: 'playing', position: 9 },
  };
  f.inject('parent', JSON.stringify(forged));
  expect(f.proxy.position).toBe(8);
  expect(f.proxy.playing).toBe(false);
  f.close();
});

it('rejects replayed generation commands without poisoning the current request counter', async () => {
  const f = fixture();
  await f.ready();
  const old = JSON.parse(f.sent[0].data);
  const replacement = f.proxy.load('dQw4w9WgXcQ');
  f.players[1].options.events.onReady();
  await replacement;
  f.inject(
    'child',
    JSON.stringify({
      protocol: old.protocol,
      session: old.session,
      generation: old.generation,
      kind: 'request',
      id: 999,
      op: 'seek',
      seconds: 4,
    }),
  );
  f.proxy.seek(5);
  expect(f.players[1].seekTo).toHaveBeenCalledExactlyOnceWith(5, true);
  f.close();
});

it('bounds endpoint pending operations even when the trusted transport sends raw valid requests', async () => {
  const f = fixture();
  await f.ready();
  const load = JSON.parse(f.sent[0].data);
  for (let id = 2; id <= 14; id++)
    f.inject(
      'child',
      JSON.stringify({
        protocol: load.protocol,
        session: load.session,
        generation: load.generation,
        kind: 'request',
        id,
        op: 'play',
      }),
    );
  await Promise.resolve();
  expect(
    f.sent
      .filter((packet) => packet.to === 'parent')
      .map((packet) => JSON.parse(packet.data).error),
  ).toContain('rate-limit');
  f.close();
});

it('cancels pending play immediately when the proxy pauses', async () => {
  const f = fixture();
  const player = await f.ready();
  const cancelled = expect(f.proxy.play()).rejects.toMatchObject({ code: 'cancelled' });
  f.proxy.pause();
  await cancelled;
  expect(player.pauseVideo).toHaveBeenCalledOnce();
  f.close();
});

it('acknowledges a confirmed play even when the native player pauses before its reply is sent', async () => {
  const f = fixture();
  const player = await f.ready();
  const play = f.proxy.play();
  player.options.events.onStateChange({ data: 1 });
  player.options.events.onStateChange({ data: 2 });
  let completed = false;
  void play.then(() => {
    completed = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(completed).toBe(true);
  expect(f.proxy.status).toBe('paused');
  f.close();
});

it('disposes pending initialization and cannot be revived by late readiness', async () => {
  const f = fixture();
  const cancelled = expect(f.proxy.load('M7lc1UVf-VE')).rejects.toMatchObject({
    code: 'cancelled',
  });
  f.proxy.dispose();
  await cancelled;
  f.players[0].options.events.onReady();
  expect(f.proxy.available).toBe(false);
  expect(f.proxy.status).toBe('disposed');
  expect(f.players[0].destroy).toHaveBeenCalledOnce();
  await expect(f.proxy.load('M7lc1UVf-VE')).rejects.toMatchObject({ code: 'disposed' });
  f.close();
});

it('keeps the current player intact when a replacement source is invalid', async () => {
  const f = fixture();
  const player = await f.ready();
  await expect(f.proxy.load('https://attacker.example/watch?v=M7lc1UVf-VE')).rejects.toMatchObject({
    code: 'invalid-source',
  });
  expect(f.proxy.available).toBe(true);
  expect(player.destroy).not.toHaveBeenCalled();
  expect(f.players).toHaveLength(1);
  f.close();
});
