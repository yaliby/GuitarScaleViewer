import { describe, expect, it } from 'vitest';
import { parseKeyAndMode, parseSpotifyStyleKey, pitchClassToKey } from './keyParse';

describe('pitchClassToKey', () => {
  it('maps the twelve valid pitch classes', () => {
    expect(pitchClassToKey(0)).toBe('C');
    expect(pitchClassToKey(1)).toBe('C#');
    expect(pitchClassToKey(11)).toBe('B');
  });

  it('rejects out-of-range and non-integer input', () => {
    expect(pitchClassToKey(-1)).toBeNull();
    expect(pitchClassToKey(12)).toBeNull();
    expect(pitchClassToKey(3.5)).toBeNull();
  });
});

describe('parseKeyAndMode', () => {
  it('parses the plain "<tonic> <mode>" forms catalogs return', () => {
    expect(parseKeyAndMode('C major')).toEqual({ key: 'C', mode: 'major' });
    expect(parseKeyAndMode('a minor')).toEqual({ key: 'A', mode: 'minor' });
    expect(parseKeyAndMode('F# Minor')).toEqual({ key: 'F#', mode: 'minor' });
    expect(parseKeyAndMode('G maj')).toEqual({ key: 'G', mode: 'major' });
  });

  it('keeps the flat spelling the source used', () => {
    expect(parseKeyAndMode('Bb major')).toEqual({ key: 'Bb', mode: 'major' });
    expect(parseKeyAndMode('Eb minor')).toEqual({ key: 'Eb', mode: 'minor' });
    expect(parseKeyAndMode('Db major')).toEqual({ key: 'Db', mode: 'major' });
  });

  it('resolves tonics the fretboard has no root for', () => {
    expect(parseKeyAndMode('Cb major')).toEqual({ key: 'B', mode: 'major' });
    expect(parseKeyAndMode('Fb major')).toEqual({ key: 'E', mode: 'major' });
    expect(parseKeyAndMode('E# minor')).toEqual({ key: 'F', mode: 'minor' });
  });

  it('accepts unicode accidentals and en/em dashes', () => {
    expect(parseKeyAndMode('F♯ minor')).toEqual({ key: 'F#', mode: 'minor' });
    expect(parseKeyAndMode('B♭ major')).toEqual({ key: 'Bb', mode: 'major' });
    expect(parseKeyAndMode('C — major')).toEqual({ key: 'C', mode: 'major' });
  });

  it('accepts the shorthand minor form', () => {
    expect(parseKeyAndMode('Am')).toEqual({ key: 'A', mode: 'minor' });
    expect(parseKeyAndMode('C#m')).toEqual({ key: 'C#', mode: 'minor' });
    expect(parseKeyAndMode('Bbm')).toEqual({ key: 'Bb', mode: 'minor' });
  });

  it('returns null rather than guessing on unusable input', () => {
    expect(parseKeyAndMode('')).toBeNull();
    expect(parseKeyAndMode('   ')).toBeNull();
    expect(parseKeyAndMode('unknown')).toBeNull();
    expect(parseKeyAndMode('H major')).toBeNull();
    expect(parseKeyAndMode('123')).toBeNull();
  });
});

describe('parseSpotifyStyleKey', () => {
  it('reads the numeric pitch-class + mode pair', () => {
    expect(parseSpotifyStyleKey(0, 1)).toEqual({ key: 'C', mode: 'major' });
    expect(parseSpotifyStyleKey(9, 0)).toEqual({ key: 'A', mode: 'minor' });
  });

  it('reads the same pair when the provider stringifies it', () => {
    expect(parseSpotifyStyleKey('9', '0')).toEqual({ key: 'A', mode: 'minor' });
    expect(parseSpotifyStyleKey('5', 'major')).toEqual({ key: 'F', mode: 'major' });
  });

  it('reads a textual key with a separate mode field', () => {
    expect(parseSpotifyStyleKey('Bb', 'minor')).toEqual({ key: 'Bb', mode: 'minor' });
  });

  /**
   * The pitch class alone does not determine the spelling: 10 is Bb in both modes, but 1 is
   * Db as a major key and C# as a minor one.
   */
  it('spells a numeric pitch class the way that key is written', () => {
    expect(parseSpotifyStyleKey(10, 0)).toEqual({ key: 'Bb', mode: 'minor' });
    expect(parseSpotifyStyleKey(10, 1)).toEqual({ key: 'Bb', mode: 'major' });
    expect(parseSpotifyStyleKey(1, 1)).toEqual({ key: 'Db', mode: 'major' });
    expect(parseSpotifyStyleKey(1, 0)).toEqual({ key: 'C#', mode: 'minor' });
    expect(parseSpotifyStyleKey(8, 1)).toEqual({ key: 'Ab', mode: 'major' });
    expect(parseSpotifyStyleKey(8, 0)).toEqual({ key: 'G#', mode: 'minor' });
    expect(parseSpotifyStyleKey(3, 1)).toEqual({ key: 'Eb', mode: 'major' });
  });

  it('falls back to the key string when the mode field is unusable', () => {
    expect(parseSpotifyStyleKey('D minor', undefined)).toEqual({ key: 'D', mode: 'minor' });
  });

  it('returns null when the tonic cannot be resolved', () => {
    expect(parseSpotifyStyleKey(-1, 1)).toBeNull();
    expect(parseSpotifyStyleKey(99, 1)).toBeNull();
    expect(parseSpotifyStyleKey(null, 1)).toBeNull();
    expect(parseSpotifyStyleKey('nonsense', 1)).toBeNull();
  });
});
