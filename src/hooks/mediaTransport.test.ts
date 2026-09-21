import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriMocks.invoke,
  isTauri: tauriMocks.isTauri,
}));

import { controlMediaPlayback, seekMedia } from './mediaTransport';

const SNAPSHOT = {
  title: 'Karma Police',
  artist: 'Radiohead',
  album: 'OK Computer',
  source_app: 'Spotify',
  playback_status: 'paused',
  position_ms: 45_000,
  duration_ms: 240_000,
};

describe('mediaTransport', () => {
  beforeEach(() => {
    tauriMocks.invoke.mockReset();
    tauriMocks.isTauri.mockReturnValue(false);
  });

  it('is a no-op outside Tauri so the browser shell never talks to an OS player', async () => {
    await expect(controlMediaPlayback('pause')).resolves.toBeNull();
    await expect(seekMedia(12_000)).resolves.toBeNull();
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it('asks Rust to pause and to seek with camelCase arguments', async () => {
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.invoke.mockResolvedValue(SNAPSHOT);
    await expect(controlMediaPlayback('pause')).resolves.toMatchObject({
      playbackStatus: 'paused',
      positionMs: 45_000,
    });
    await expect(seekMedia(45_000.4)).resolves.toMatchObject({ positionMs: 45_000 });
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(1, 'control_media_playback', { action: 'pause' });
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(2, 'seek_media', { positionMs: 45_000 });
  });

  it('keeps only the latest seek while one request is in flight', async () => {
    tauriMocks.isTauri.mockReturnValue(true);
    let release!: (value: unknown) => void;
    tauriMocks.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    tauriMocks.invoke.mockResolvedValue(SNAPSHOT);

    const first = seekMedia(10_000);
    const second = seekMedia(20_000);
    const third = seekMedia(30_000);
    release(SNAPSHOT);
    await Promise.all([first, second, third]);

    const seeks = tauriMocks.invoke.mock.calls.filter(([command]) => command === 'seek_media');
    expect(seeks.map(([, args]) => args)).toEqual([{ positionMs: 10_000 }, { positionMs: 30_000 }]);
  });
});
