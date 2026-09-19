import { afterEach, describe, expect, it, vi } from 'vitest';
import { lookupSongKey, normalizeLookupKey } from './songKeyApi';
import { setVerifiedEntriesForTest } from './verifiedKeyDictionary';

afterEach(() => {
  vi.restoreAllMocks();
  setVerifiedEntriesForTest();
});

describe('lookupSongKey', () => {
  it('misses immediately when the metadata is empty', () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const result = lookupSongKey({ title: '  ', artist: '' });
    expect(result).toEqual({ found: false, song: null });
    expect(spy).not.toHaveBeenCalled();
  });

  it('misses a song that is not in the bundled library, without opening a socket', () => {
    setVerifiedEntriesForTest([]);
    const spy = vi.spyOn(globalThis, 'fetch');
    const result = lookupSongKey({ title: 'Nonsense Song', artist: 'Nobody At All' });
    expect(result).toEqual({ found: false, song: null });
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns the bundled verified key and never opens a socket', () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const result = lookupSongKey({
      title: "Led Zeppelin - Stairway To Heaven (Live at Earl's Court 1975) [Official Video]",
      artist: 'Led Zeppelin',
    });
    expect(result.found).toBe(true);
    expect(result.song).toMatchObject({
      verified: true,
      musical_key: 'A',
      mode: 'minor',
      source: 'verified_library',
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('normalizeLookupKey', () => {
  it('keeps a flat key readable instead of upper-casing it into nonsense', () => {
    expect(normalizeLookupKey({ musical_key: 'Bb', mode: 'minor' })).toEqual({ key: 'Bb', mode: 'minor' });
  });

  it('reads a key that already carries its mode, and a Spotify-style pitch class', () => {
    expect(normalizeLookupKey({ musical_key: 'F# minor', mode: '' })).toEqual({ key: 'F#', mode: 'minor' });
    expect(normalizeLookupKey({ musical_key: '9', mode: '0' })).toEqual({ key: 'A', mode: 'minor' });
  });

  it('returns null for a value that is not a key at all', () => {
    expect(normalizeLookupKey({ musical_key: 'unknown', mode: 'major' })).toBeNull();
  });
});
