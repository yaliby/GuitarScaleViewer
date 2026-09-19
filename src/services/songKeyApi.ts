import { parseSpotifyStyleKey, type ParsedKey } from './keyParse';
import { lookupVerifiedKey } from './verifiedKeyDictionary';
import { trace } from './debugLog';

/**
 * The only cloud-shaped lookup left: a human-entered row bundled with the app.
 * There is no server. A miss means the local engine is the remaining leg.
 */

export type KeyLookupSource = 'verified_library';

export type LookupSongInput = {
  title: string;
  artist: string;
};

export type LookupSongHit = {
  id: string;
  title: string;
  artist: string;
  musical_key: string;
  mode: string;
  verified: true;
  source: KeyLookupSource;
  sourceLabel: string;
};

export type LookupSongResult =
  | { found: true; song: LookupSongHit }
  | { found: false; song: null };

/**
 * Verified rows may be stored as "Bb", "F# minor" or a pitch class. Returns the key spelled
 * the way it is written — flats stay flat — or null when the value cannot be read as a key.
 */
export function normalizeLookupKey(song: Pick<LookupSongHit, 'musical_key' | 'mode'>): ParsedKey | null {
  return parseSpotifyStyleKey(song.musical_key, song.mode);
}

export function lookupSongKey(input: LookupSongInput): LookupSongResult {
  const title = input.title.trim();
  const artist = input.artist.trim();
  if (!title || !artist) {
    trace('cloud', 'lookup.skip', 'Empty title or artist — no library lookup', {
      title,
      artist,
      why: 'empty_metadata',
    }, 'skip');
    return { found: false, song: null };
  }

  const bundled = lookupVerifiedKey(title, artist);
  if (!bundled) {
    trace('cloud', 'lookup.miss', `Not in the verified library: "${title}" — ${artist}`, {
      title,
      artist,
      why: 'library_miss',
    }, 'skip');
    return { found: false, song: null };
  }

  trace('cloud', 'lookup.hit', `Library key ${bundled.key} ${bundled.mode} for "${title}"`, {
    title,
    artist,
    key: bundled.key,
    mode: bundled.mode,
    why: 'bundled_dictionary',
  }, 'ok');
  return {
    found: true,
    song: {
      id: `verified:${title}|${artist}`,
      title,
      artist,
      musical_key: bundled.key,
      mode: bundled.mode,
      verified: true,
      source: 'verified_library',
      sourceLabel: 'Verified library',
    },
  };
}
