import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  lookupSongKey,
  setSongKeyApiBaseForDev,
  submitSongKeySuggestion,
} from './songKeyApi';

const VALID_HIT = {
  found: true,
  song: {
    id: 'song-1',
    title: 'Blue in Green',
    artist: 'Miles Davis',
    musical_key: 'Bb',
    mode: 'major',
    verified: true,
  },
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setSongKeyApiBaseForDev(null);
});

describe('lookupSongKey', () => {
  it('preserves a valid flat accidental from a verified cloud record', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(VALID_HIT)));

    await expect(lookupSongKey({ title: 'Blue in Green', artist: 'Miles Davis' })).resolves.toEqual(
      VALID_HIT,
    );
  });

  it.each([
    ['an unsupported key', { ...VALID_HIT.song, musical_key: 'H' }],
    ['an unsupported mode', { ...VALID_HIT.song, mode: 'dorian' }],
    ['an unverified record', { ...VALID_HIT.song, verified: false }],
    ['an empty identifier', { ...VALID_HIT.song, id: '' }],
  ])('rejects %s in a cloud hit', async (_name, song) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ found: true, song })));

    await expect(lookupSongKey({ title: 'Blue in Green', artist: 'Miles Davis' })).rejects.toThrow(
      /Invalid|verified/,
    );
  });

  it('aborts a lookup that exceeds its deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        }),
      ),
    );

    const lookup = lookupSongKey({ title: 'Blue in Green', artist: 'Miles Davis' });
    const rejection = expect(lookup).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(8_000);
    await rejection;
  });

  it('retains the existing non-window lookup support', async () => {
    vi.stubGlobal('window', undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ found: false, song: null })),
    );

    await expect(lookupSongKey({ title: 'Song', artist: 'Artist' })).resolves.toEqual({
      found: false,
      song: null,
    });
  });
});

describe('submitSongKeySuggestion', () => {
  it('serializes a valid flat without destroying its accidental case', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ success: true }));
    vi.stubGlobal('fetch', fetchMock);

    await submitSongKeySuggestion({
      title: 'Blue in Green',
      artist: 'Miles Davis',
      key: 'bb',
      mode: 'major',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ key: 'Bb', mode: 'major' });
  });
});
