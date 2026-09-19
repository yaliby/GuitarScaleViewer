import { afterEach, describe, expect, it } from 'vitest';
import { lookupVerifiedKey, setVerifiedEntriesForTest } from './verifiedKeyDictionary';

afterEach(() => {
  setVerifiedEntriesForTest();
});

const table = [
  { title: 'Sultans of Swing', artist: 'Dire Straits', key: 'D', mode: 'minor' as const },
  { title: 'Numb', artist: 'Linkin Park', key: 'F#', mode: 'minor' as const },
  { title: 'Hallelujah', artist: 'Jeff Buckley', key: 'C', mode: 'major' as const },
];

describe('lookupVerifiedKey', () => {
  it('finds a row by the title and artist the player reports', () => {
    setVerifiedEntriesForTest(table);
    expect(lookupVerifiedKey('Sultans of Swing', 'Dire Straits')).toMatchObject({
      key: 'D',
      mode: 'minor',
    });
  });

  it('finds a row through the noise a player adds to a title', () => {
    setVerifiedEntriesForTest(table);
    for (const title of ['Numb - Official Video', 'Linkin Park - Numb', 'NUMB']) {
      expect(lookupVerifiedKey(title, 'Linkin Park'), title).toMatchObject({ key: 'F#' });
    }
  });

  it('does not answer for a song nobody has entered', () => {
    setVerifiedEntriesForTest(table);
    expect(lookupVerifiedKey('Money for Nothing', 'Dire Straits')).toBeNull();
  });

  it('does not answer for the right title by the wrong artist', () => {
    // A cover must fall through to the estimating legs rather than inherit the original's key.
    setVerifiedEntriesForTest(table);
    expect(lookupVerifiedKey('Hallelujah', 'Leonard Cohen')).toBeNull();
  });

  it('skips a hand-edited row whose key cannot be read, instead of breaking the neck', () => {
    setVerifiedEntriesForTest([
      { title: 'Broken Row', artist: 'Nobody', key: 'H#', mode: 'minor' },
      ...table,
    ]);
    expect(lookupVerifiedKey('Broken Row', 'Nobody')).toBeNull();
    expect(lookupVerifiedKey('Numb', 'Linkin Park')).toMatchObject({ key: 'F#' });
  });

  it('normalises a flat spelling rather than trusting the file', () => {
    setVerifiedEntriesForTest([{ title: 'Flat Song', artist: 'Someone', key: 'B♭', mode: 'major' }]);
    expect(lookupVerifiedKey('Flat Song', 'Someone')).toMatchObject({ key: 'Bb', mode: 'major' });
  });

  it('answers null for an empty table without touching the index', () => {
    setVerifiedEntriesForTest([]);
    expect(lookupVerifiedKey('Anything', 'Anyone')).toBeNull();
  });

  it('finds Stairway to Heaven from a YouTube live-video session title', () => {
    expect(
      lookupVerifiedKey(
        "Led Zeppelin - Stairway To Heaven (Live at Earl's Court 1975) [Official Video]",
        'Led Zeppelin',
      ),
    ).toMatchObject({ key: 'A', mode: 'minor' });
  });
});
