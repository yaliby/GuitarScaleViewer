import { describe, expect, it } from 'vitest';
import {
  artistsMatch,
  buildMatchKeys,
  canonicalArtistKey,
  canonicalTitleKey,
  cleanArtistName,
  compactFold,
  cleanTrackTitle,
  foldName,
  legacyNormalize,
  primaryArtist,
  sameArtistName,
  titlesLooselyMatch,
  titlesMatch,
} from './nameNormalize';

describe('cleanTrackTitle', () => {
  it('drops upload noise in brackets', () => {
    expect(cleanTrackTitle('Numb (Official Video)')).toBe('Numb');
    expect(cleanTrackTitle('Numb [Official Music Video] [HD]')).toBe('Numb');
    expect(cleanTrackTitle('Bohemian Rhapsody (2011)')).toBe('Bohemian Rhapsody');
  });

  it('drops trailing dash-delimited noise only', () => {
    expect(cleanTrackTitle("Don't Stop Me Now - Remastered 2011")).toBe("Don't Stop Me Now");
    expect(cleanTrackTitle('Black - Official Audio')).toBe('Black');
    expect(cleanTrackTitle('Love Me Do - Mono / Remastered')).toBe('Love Me Do');
  });

  it('keeps meaningful dashes and parentheses', () => {
    expect(cleanTrackTitle('Marie - A Little Bit')).toBe('Marie - A Little Bit');
    expect(cleanTrackTitle('Sing (Sing a Song)')).toBe('Sing (Sing a Song)');
  });

  it('drops a trailing featured artist', () => {
    expect(cleanTrackTitle('Stay (feat. Justin Bieber)')).toBe('Stay');
    expect(cleanTrackTitle('Stay feat. Justin Bieber')).toBe('Stay');
  });

  it('never returns an empty title', () => {
    expect(cleanTrackTitle('(Official Video)')).toBe('(Official Video)');
    expect(cleanTrackTitle('   ')).toBe('');
  });
});

describe('cleanArtistName', () => {
  it('strips YouTube channel decorations', () => {
    expect(cleanArtistName('Pearl Jam - Topic')).toBe('Pearl Jam');
    expect(cleanArtistName('EminemVEVO')).toBe('Eminem');
    expect(cleanArtistName('Eminem VEVO')).toBe('Eminem');
    expect(cleanArtistName('Queen - Official')).toBe('Queen');
    expect(cleanArtistName('Queen Official')).toBe('Queen');
    expect(cleanArtistName('Queen Official - Topic')).toBe('Queen');
    expect(cleanArtistName('Linkin Park - Official Channel')).toBe('Linkin Park');
  });
});

describe('foldName', () => {
  it('folds accents, punctuation, ampersands and a leading "the"', () => {
    expect(foldName('Beyoncé')).toBe(foldName('Beyonce'));
    expect(foldName("Don't Stop Me Now")).toBe('dont stop me now');
    expect(foldName('Simon & Garfunkel')).toBe(foldName('Simon and Garfunkel'));
    expect(foldName('The Beatles')).toBe('beatles');
    expect(foldName('AC/DC')).toBe('ac dc');
  });
});

describe('legacyNormalize', () => {
  it('reproduces the pre-existing column format exactly', () => {
    expect(legacyNormalize('  Numb   (Official) ')).toBe('numb (official)');
  });
});

describe('buildMatchKeys', () => {
  it('probes both the legacy and the folded spaces', () => {
    const keys = buildMatchKeys('Numb (Official Video)', 'Linkin Park');
    expect(keys.cleanTitle).toBe('Numb');
    expect(keys.titleKeys).toContain('numb (official video)');
    expect(keys.titleKeys).toContain('numb');
    expect(keys.artistKeys).toContain('linkin park');
  });

  it('strips an "Artist - " prefix only when it is the artist', () => {
    expect(buildMatchKeys('Linkin Park - Numb (Official Video)', 'Linkin Park').cleanTitle).toBe('Numb');
    expect(buildMatchKeys('Marie - A Little Bit', 'Linkin Park').cleanTitle).toBe('Marie - A Little Bit');
  });

  it('strips the prefix when the channel carries a tail the title drops', () => {
    const keys = buildMatchKeys('Queen \u2013 Don\'t Stop Me Now (Official Video)', 'Queen Official');
    expect(keys.cleanTitle).toBe("Don't Stop Me Now");
    expect(keys.cleanArtist).toBe('Queen');
  });

  it('handles a glued channel name as the title prefix', () => {
    const keys = buildMatchKeys(
      "Guns N' Roses - Sweet Child O' Mine (Official Music Video)",
      'GunsNRosesVEVO',
    );
    expect(keys.cleanTitle).toBe("Sweet Child O' Mine");
    expect(compactFold(keys.cleanArtist)).toBe('gunsnroses');
  });

  it('strips a colon-separated artist prefix', () => {
    const keys = buildMatchKeys('Metallica: Enter Sandman (Official Music Video)', 'MetallicaTV');
    expect(keys.cleanTitle).toBe('Enter Sandman');
  });

  it('strips an acronym-channel prefix', () => {
    const keys = buildMatchKeys(
      'Red Hot Chili Peppers - Under The Bridge [Official Music Video]',
      'RHCPVEVO',
    );
    expect(keys.cleanTitle).toBe('Under The Bridge');
  });

  it('adds the primary artist as a candidate', () => {
    expect(buildMatchKeys('Stay', 'The Kid LAROI, Justin Bieber').artistKeys).toContain('kid laroi');
  });
});

describe('canonical keys', () => {
  it('collapse player noise and spelling differences to one key', () => {
    expect(canonicalTitleKey('Numb (Official Video)')).toBe(canonicalTitleKey('Numb'));
    expect(canonicalTitleKey("Don't Stop Me Now - Remastered 2011")).toBe(
      canonicalTitleKey('Dont Stop Me Now'),
    );
    expect(canonicalArtistKey('Beyoncé - Topic')).toBe(canonicalArtistKey('Beyonce'));
  });
});

describe('matching', () => {
  it('requires titles to agree exactly once folded', () => {
    expect(titlesMatch('One', 'One More Time')).toBe(false);
    expect(titlesMatch('Numb (Official Video)', 'Numb')).toBe(true);
  });

  it('allows a guarded containment fallback', () => {
    expect(titlesLooselyMatch('One', 'One More Time')).toBe(false);
    expect(titlesLooselyMatch('Bohemian Rhapsody', 'Bohemian Rhapsody Reprise')).toBe(true);
  });

  it('matches artists across collaborator tails', () => {
    expect(artistsMatch('The Weeknd', 'The Weeknd, Daft Punk')).toBe(true);
    expect(artistsMatch('The Weeknd', 'Daft Punk')).toBe(false);
  });

  it('matches a glued channel name against the catalog spelling', () => {
    expect(artistsMatch('GunsNRosesVEVO', "Guns N' Roses")).toBe(true);
    expect(artistsMatch('GunsNRosesVEVO', 'Nirvana')).toBe(false);
  });

  it('recognises glued, suffixed and acronym channel spellings', () => {
    expect(sameArtistName('GunsNRosesVEVO', "Guns N' Roses")).toBe(true);
    expect(sameArtistName('MetallicaTV', 'Metallica')).toBe(true);
    expect(sameArtistName('RHCPVEVO', 'Red Hot Chili Peppers')).toBe(true);
  });

  it('does not let a short name swallow a longer one', () => {
    expect(sameArtistName('Queen', 'Queens of the Stone Age')).toBe(false);
    expect(sameArtistName('Kiss', 'Kissing the Pink')).toBe(false);
    expect(sameArtistName('MetallicaTV', 'Nirvana')).toBe(false);
  });

  it('keeps the primary artist helper stable', () => {
    expect(primaryArtist('The Kid LAROI, Justin Bieber')).toBe('The Kid LAROI');
  });
});
