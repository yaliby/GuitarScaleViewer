import type { KeyMode } from '../keyFusion';

/**
 * Songs whose key is not in dispute, and the shapes a real player reports them in.
 *
 * This is the corpus M8 asks for: something to measure the pipeline against that is not the
 * pipeline's own output. Every row here is a recording whose key is agreed by published sheet
 * music, and the `truth` field is the key *of the recording as it sounds* — which is the only
 * thing a fretboard can be right or wrong about. Where a band tuned down and the charts are
 * written a semitone up (Guns N' Roses, Nirvana), the sounding key is the one stored, and the
 * written one is carried in `notes` so a failure is readable rather than mysterious.
 *
 * Songs whose key is genuinely arguable are not here. A corpus that measures accuracy has to
 * be more certain than the thing it measures, so anything modal, anything that opens in one
 * key and lives in another, and anything the charts disagree about was left out. The few
 * deliberate exceptions — a mid-song modulation, a half-step-down tuning — are marked with
 * `modulates` or `notes` and are scored separately as edge cases rather than as accuracy.
 *
 * `players` are the literal strings an OS media session hands us. They are not decoration:
 * every miss the pipeline has in the field starts as a title it could not match, and the
 * YouTube-style rows ("Artist - Title (Official Video)", channel "ArtistVEVO") are the exact
 * spellings `buildMatchKeys` exists to fold.
 */

export type PlayerMetadata = {
  /** What the media session reports as the title. */
  title: string;
  /** What the media session reports as the artist. */
  artist: string;
  sourceApp: string;
  /** Why this spelling is in the corpus, for failure messages. */
  shape: 'canonical' | 'youtube' | 'remaster' | 'feature' | 'unicode' | 'live-noise';
};

export type GroundTruthSong = {
  title: string;
  artist: string;
  truth: { key: string; mode: KeyMode };
  players: PlayerMetadata[];
  /** Set when the recording changes key part way through; excluded from accuracy scoring. */
  modulates?: boolean;
  notes?: string;
};

function canonical(title: string, artist: string, sourceApp = 'spotify'): PlayerMetadata {
  return { title, artist, sourceApp, shape: 'canonical' };
}

/** The shape YouTube/Chrome hands over: artist in the title, channel name as the artist. */
function youtube(title: string, artist: string, channel: string): PlayerMetadata {
  return {
    title: `${artist} - ${title} (Official Video)`,
    artist: channel,
    sourceApp: 'chrome',
    shape: 'youtube',
  };
}

function remaster(title: string, artist: string, year: number): PlayerMetadata {
  return {
    title: `${title} - Remastered ${year}`,
    artist,
    sourceApp: 'spotify',
    shape: 'remaster',
  };
}

/**
 * The scored corpus. Minor and major are deliberately close to balanced: a pipeline with a
 * relative-major bias scores well on a major-heavy corpus for the wrong reason.
 */
export const GROUND_TRUTH_SONGS: GroundTruthSong[] = [
  // ---------------------------------------------------------------- minor keys
  {
    title: 'Smells Like Teen Spirit',
    artist: 'Nirvana',
    truth: { key: 'F', mode: 'minor' },
    notes: 'Guitars tuned a half step down; charted as F minor, sounds F minor.',
    players: [
      canonical('Smells Like Teen Spirit', 'Nirvana'),
      youtube('Smells Like Teen Spirit', 'Nirvana', 'NirvanaVEVO'),
    ],
  },
  {
    title: 'Billie Jean',
    artist: 'Michael Jackson',
    truth: { key: 'F#', mode: 'minor' },
    players: [
      canonical('Billie Jean', 'Michael Jackson'),
      youtube('Billie Jean', 'Michael Jackson', 'michaeljacksonVEVO'),
    ],
  },
  {
    title: 'Hotel California',
    artist: 'Eagles',
    truth: { key: 'B', mode: 'minor' },
    notes: 'Recorded with a capo at fret 7; sounds in B minor.',
    players: [
      canonical('Hotel California', 'Eagles'),
      remaster('Hotel California', 'Eagles', 2013),
    ],
  },
  {
    title: 'Stairway to Heaven',
    artist: 'Led Zeppelin',
    truth: { key: 'A', mode: 'minor' },
    players: [
      canonical('Stairway to Heaven', 'Led Zeppelin'),
      remaster('Stairway to Heaven', 'Led Zeppelin', 1990),
    ],
  },
  {
    title: 'Nothing Else Matters',
    artist: 'Metallica',
    truth: { key: 'E', mode: 'minor' },
    players: [canonical('Nothing Else Matters', 'Metallica'), youtube('Nothing Else Matters', 'Metallica', 'MetallicaTV')],
  },
  {
    title: 'Enter Sandman',
    artist: 'Metallica',
    truth: { key: 'E', mode: 'minor' },
    players: [canonical('Enter Sandman', 'Metallica')],
  },
  {
    title: 'Smoke on the Water',
    artist: 'Deep Purple',
    truth: { key: 'G', mode: 'minor' },
    players: [canonical('Smoke on the Water', 'Deep Purple')],
  },
  {
    title: 'Another One Bites the Dust',
    artist: 'Queen',
    truth: { key: 'E', mode: 'minor' },
    players: [
      canonical('Another One Bites the Dust', 'Queen'),
      { title: 'Another One Bites the Dust - Remastered 2011', artist: 'Queen Official', sourceApp: 'chrome', shape: 'remaster' },
    ],
  },
  {
    title: 'Rolling in the Deep',
    artist: 'Adele',
    truth: { key: 'C', mode: 'minor' },
    players: [canonical('Rolling in the Deep', 'Adele'), youtube('Rolling in the Deep', 'Adele', 'AdeleVEVO')],
  },
  {
    title: 'Hello',
    artist: 'Adele',
    truth: { key: 'F', mode: 'minor' },
    notes: 'Title collides with Lionel Richie "Hello" (A minor) — the artist leg is what separates them.',
    players: [canonical('Hello', 'Adele')],
  },
  {
    title: 'Shape of You',
    artist: 'Ed Sheeran',
    truth: { key: 'C#', mode: 'minor' },
    players: [canonical('Shape of You', 'Ed Sheeran'), youtube('Shape of You', 'Ed Sheeran', 'Ed Sheeran')],
  },
  {
    title: 'Blinding Lights',
    artist: 'The Weeknd',
    truth: { key: 'F', mode: 'minor' },
    players: [canonical('Blinding Lights', 'The Weeknd'), canonical('Blinding Lights', 'Weeknd')],
  },
  {
    title: 'Uptown Funk',
    artist: 'Mark Ronson',
    truth: { key: 'D', mode: 'minor' },
    players: [
      canonical('Uptown Funk', 'Mark Ronson'),
      { title: 'Uptown Funk (feat. Bruno Mars)', artist: 'Mark Ronson, Bruno Mars', sourceApp: 'spotify', shape: 'feature' },
    ],
  },
  {
    title: 'bad guy',
    artist: 'Billie Eilish',
    truth: { key: 'G', mode: 'minor' },
    players: [canonical('bad guy', 'Billie Eilish'), canonical('Bad Guy', 'Billie Eilish')],
  },
  {
    title: 'Numb',
    artist: 'Linkin Park',
    truth: { key: 'F#', mode: 'minor' },
    players: [
      canonical('Numb', 'Linkin Park'),
      youtube('Numb', 'Linkin Park', 'LinkinParkVEVO'),
      { title: 'Numb [Official Music Video]', artist: 'Linkin Park - Topic', sourceApp: 'chrome', shape: 'youtube' },
    ],
  },
  {
    title: 'In the End',
    artist: 'Linkin Park',
    truth: { key: 'E', mode: 'minor' },
    players: [canonical('In the End', 'Linkin Park')],
  },
  {
    title: 'Zombie',
    artist: 'The Cranberries',
    truth: { key: 'E', mode: 'minor' },
    players: [canonical('Zombie', 'The Cranberries'), canonical('Zombie', 'Cranberries')],
  },
  {
    title: 'Seven Nation Army',
    artist: 'The White Stripes',
    truth: { key: 'E', mode: 'minor' },
    players: [canonical('Seven Nation Army', 'The White Stripes')],
  },
  {
    title: 'Boulevard of Broken Dreams',
    artist: 'Green Day',
    truth: { key: 'F', mode: 'minor' },
    players: [canonical('Boulevard of Broken Dreams', 'Green Day'), youtube('Boulevard of Broken Dreams', 'Green Day', 'GreenDayVEVO')],
  },
  {
    title: 'Californication',
    artist: 'Red Hot Chili Peppers',
    truth: { key: 'A', mode: 'minor' },
    players: [
      canonical('Californication', 'Red Hot Chili Peppers'),
      { title: 'Californication', artist: 'RHCPVEVO', sourceApp: 'chrome', shape: 'youtube' },
    ],
  },
  {
    title: 'Losing My Religion',
    artist: 'R.E.M.',
    truth: { key: 'A', mode: 'minor' },
    players: [canonical('Losing My Religion', 'R.E.M.'), canonical('Losing My Religion', 'REM')],
  },
  {
    title: 'Comfortably Numb',
    artist: 'Pink Floyd',
    truth: { key: 'B', mode: 'minor' },
    players: [canonical('Comfortably Numb', 'Pink Floyd')],
  },
  {
    title: 'Money',
    artist: 'Pink Floyd',
    truth: { key: 'B', mode: 'minor' },
    notes: 'Title is a single common word — the loose-title fallback must not fire on it.',
    players: [canonical('Money', 'Pink Floyd')],
  },
  {
    title: 'Another Brick in the Wall, Pt. 2',
    artist: 'Pink Floyd',
    truth: { key: 'D', mode: 'minor' },
    players: [canonical('Another Brick in the Wall, Pt. 2', 'Pink Floyd')],
  },
  {
    title: 'Hurt',
    artist: 'Johnny Cash',
    truth: { key: 'A', mode: 'minor' },
    notes: 'Cover of Nine Inch Nails. A catalog that lands on the NIN original must be rejected.',
    players: [canonical('Hurt', 'Johnny Cash')],
  },
  {
    title: 'Roxanne',
    artist: 'The Police',
    truth: { key: 'G', mode: 'minor' },
    players: [canonical('Roxanne', 'The Police'), canonical('Roxanne', 'Police')],
  },
  {
    title: 'Sweet Dreams (Are Made of This)',
    artist: 'Eurythmics',
    truth: { key: 'C', mode: 'minor' },
    players: [canonical('Sweet Dreams (Are Made of This)', 'Eurythmics')],
  },
  {
    title: 'Thriller',
    artist: 'Michael Jackson',
    truth: { key: 'C#', mode: 'minor' },
    players: [canonical('Thriller', 'Michael Jackson')],
  },
  {
    title: 'Beat It',
    artist: 'Michael Jackson',
    truth: { key: 'Eb', mode: 'minor' },
    notes: 'Flat-spelled tonic — the "Bb becomes BB" class of bug shows up here first.',
    players: [canonical('Beat It', 'Michael Jackson')],
  },
  {
    title: 'Superstition',
    artist: 'Stevie Wonder',
    truth: { key: 'Eb', mode: 'minor' },
    players: [canonical('Superstition', 'Stevie Wonder')],
  },
  {
    title: 'I Will Survive',
    artist: 'Gloria Gaynor',
    truth: { key: 'A', mode: 'minor' },
    players: [canonical('I Will Survive', 'Gloria Gaynor')],
  },
  {
    title: "Stayin' Alive",
    artist: 'Bee Gees',
    truth: { key: 'F', mode: 'minor' },
    notes: 'Apostrophe in the title — folds to "stayin alive".',
    players: [canonical("Stayin' Alive", 'Bee Gees'), canonical('Stayin’ Alive', 'Bee Gees')],
  },
  {
    title: 'Crazy in Love',
    artist: 'Beyoncé',
    truth: { key: 'D', mode: 'minor' },
    players: [
      canonical('Crazy in Love', 'Beyoncé'),
      { title: 'Crazy In Love ft. JAY Z', artist: 'Beyonce', sourceApp: 'chrome', shape: 'unicode' },
    ],
  },
  {
    title: 'Poker Face',
    artist: 'Lady Gaga',
    truth: { key: 'G#', mode: 'minor' },
    notes: 'Sharp-spelled minor tonic; its relative major is B, spelled without accidentals.',
    players: [canonical('Poker Face', 'Lady Gaga')],
  },
  {
    title: 'Bad Romance',
    artist: 'Lady Gaga',
    truth: { key: 'A', mode: 'minor' },
    players: [canonical('Bad Romance', 'Lady Gaga')],
  },
  {
    title: 'Radioactive',
    artist: 'Imagine Dragons',
    truth: { key: 'B', mode: 'minor' },
    players: [canonical('Radioactive', 'Imagine Dragons')],
  },
  {
    title: 'Counting Stars',
    artist: 'OneRepublic',
    truth: { key: 'C#', mode: 'minor' },
    players: [canonical('Counting Stars', 'OneRepublic')],
  },
  {
    title: 'Wonderwall',
    artist: 'Oasis',
    truth: { key: 'F#', mode: 'minor' },
    notes: 'Played in Em shapes with a capo at 2; sounds F# minor. Capo songs are where the local engine beats every catalog.',
    players: [canonical('Wonderwall', 'Oasis'), remaster('Wonderwall', 'Oasis', 2014)],
  },
  {
    title: 'Sultans of Swing',
    artist: 'Dire Straits',
    truth: { key: 'D', mode: 'minor' },
    players: [canonical('Sultans of Swing', 'Dire Straits')],
  },
  {
    title: 'Eye of the Tiger',
    artist: 'Survivor',
    truth: { key: 'C', mode: 'minor' },
    players: [canonical('Eye of the Tiger', 'Survivor')],
  },
  {
    title: 'Despacito',
    artist: 'Luis Fonsi',
    truth: { key: 'B', mode: 'minor' },
    players: [
      canonical('Despacito', 'Luis Fonsi'),
      { title: 'Despacito ft. Daddy Yankee', artist: 'Luis Fonsi', sourceApp: 'chrome', shape: 'feature' },
    ],
  },

  // ---------------------------------------------------------------- major keys
  {
    title: 'Let It Be',
    artist: 'The Beatles',
    truth: { key: 'C', mode: 'major' },
    players: [canonical('Let It Be', 'The Beatles'), canonical('Let It Be', 'Beatles'), remaster('Let It Be', 'The Beatles', 2009)],
  },
  {
    title: 'Hey Jude',
    artist: 'The Beatles',
    truth: { key: 'F', mode: 'major' },
    players: [canonical('Hey Jude', 'The Beatles')],
  },
  {
    title: 'Back in Black',
    artist: 'AC/DC',
    truth: { key: 'E', mode: 'major' },
    notes: 'The slash in "AC/DC" is also the collaborator separator the artist folder splits on.',
    players: [canonical('Back in Black', 'AC/DC'), youtube('Back In Black', 'AC/DC', 'acdcVEVO')],
  },
  {
    title: 'Highway to Hell',
    artist: 'AC/DC',
    truth: { key: 'A', mode: 'major' },
    players: [canonical('Highway to Hell', 'AC/DC')],
  },
  {
    title: 'Sweet Home Alabama',
    artist: 'Lynyrd Skynyrd',
    truth: { key: 'D', mode: 'major' },
    players: [canonical('Sweet Home Alabama', 'Lynyrd Skynyrd')],
  },
  {
    title: 'Imagine',
    artist: 'John Lennon',
    truth: { key: 'C', mode: 'major' },
    players: [canonical('Imagine', 'John Lennon')],
  },
  {
    title: 'Bohemian Rhapsody',
    artist: 'Queen',
    truth: { key: 'Bb', mode: 'major' },
    modulates: true,
    notes: 'Opens in Bb major and travels; scored as an edge case, not as accuracy.',
    players: [canonical('Bohemian Rhapsody', 'Queen')],
  },
  {
    title: "Don't Stop Me Now",
    artist: 'Queen',
    truth: { key: 'F', mode: 'major' },
    players: [canonical("Don't Stop Me Now", 'Queen'), canonical('Dont Stop Me Now', 'Queen')],
  },
  {
    title: 'Someone Like You',
    artist: 'Adele',
    truth: { key: 'A', mode: 'major' },
    players: [canonical('Someone Like You', 'Adele')],
  },
  {
    title: 'Thinking Out Loud',
    artist: 'Ed Sheeran',
    truth: { key: 'D', mode: 'major' },
    players: [canonical('Thinking Out Loud', 'Ed Sheeran')],
  },
  {
    title: 'Creep',
    artist: 'Radiohead',
    truth: { key: 'G', mode: 'major' },
    players: [canonical('Creep', 'Radiohead')],
  },
  {
    title: 'Everybody Hurts',
    artist: 'R.E.M.',
    truth: { key: 'D', mode: 'major' },
    players: [canonical('Everybody Hurts', 'R.E.M.')],
  },
  {
    title: 'With or Without You',
    artist: 'U2',
    truth: { key: 'D', mode: 'major' },
    players: [canonical('With or Without You', 'U2')],
  },
  {
    title: 'Wish You Were Here',
    artist: 'Pink Floyd',
    truth: { key: 'G', mode: 'major' },
    players: [canonical('Wish You Were Here', 'Pink Floyd')],
  },
  {
    title: 'Hallelujah',
    artist: 'Leonard Cohen',
    truth: { key: 'C', mode: 'major' },
    players: [canonical('Hallelujah', 'Leonard Cohen')],
  },
  {
    title: "Knockin' on Heaven's Door",
    artist: 'Bob Dylan',
    truth: { key: 'G', mode: 'major' },
    players: [canonical("Knockin' on Heaven's Door", 'Bob Dylan')],
  },
  {
    title: 'Take On Me',
    artist: 'a-ha',
    truth: { key: 'A', mode: 'major' },
    notes: 'Hyphenated lowercase artist — folds to "a ha", not "aha".',
    players: [canonical('Take On Me', 'a-ha')],
  },
  {
    title: 'Every Breath You Take',
    artist: 'The Police',
    truth: { key: 'Ab', mode: 'major' },
    players: [canonical('Every Breath You Take', 'The Police')],
  },
  {
    title: 'Dancing Queen',
    artist: 'ABBA',
    truth: { key: 'A', mode: 'major' },
    players: [canonical('Dancing Queen', 'ABBA')],
  },
  {
    title: 'Viva la Vida',
    artist: 'Coldplay',
    truth: { key: 'Ab', mode: 'major' },
    players: [canonical('Viva la Vida', 'Coldplay'), youtube('Viva La Vida', 'Coldplay', 'ColdplayVEVO')],
  },
  {
    title: 'Yellow',
    artist: 'Coldplay',
    truth: { key: 'B', mode: 'major' },
    players: [canonical('Yellow', 'Coldplay')],
  },
  {
    title: 'Clocks',
    artist: 'Coldplay',
    truth: { key: 'Eb', mode: 'major' },
    players: [canonical('Clocks', 'Coldplay')],
  },
  {
    title: 'Halo',
    artist: 'Beyoncé',
    truth: { key: 'A', mode: 'major' },
    players: [canonical('Halo', 'Beyoncé'), canonical('Halo', 'Beyonce')],
  },
  {
    title: 'Shallow',
    artist: 'Lady Gaga',
    truth: { key: 'G', mode: 'major' },
    players: [
      canonical('Shallow', 'Lady Gaga'),
      { title: 'Shallow', artist: 'Lady Gaga, Bradley Cooper', sourceApp: 'spotify', shape: 'feature' },
    ],
  },
  {
    title: 'Let Her Go',
    artist: 'Passenger',
    truth: { key: 'G', mode: 'major' },
    players: [canonical('Let Her Go', 'Passenger')],
  },
  {
    title: 'Ho Hey',
    artist: 'The Lumineers',
    truth: { key: 'C', mode: 'major' },
    players: [canonical('Ho Hey', 'The Lumineers')],
  },
  {
    title: 'Nothing Compares 2 U',
    artist: "Sinéad O'Connor",
    truth: { key: 'F', mode: 'major' },
    notes: 'Accent and apostrophe in one artist name.',
    players: [canonical('Nothing Compares 2 U', "Sinéad O'Connor"), canonical('Nothing Compares 2 U', "Sinead O'Connor")],
  },
  {
    title: 'Hotel Yorba',
    artist: 'The White Stripes',
    truth: { key: 'G', mode: 'major' },
    notes: 'Shares a title prefix with Hotel California — the loose-title fallback must not confuse them.',
    players: [canonical('Hotel Yorba', 'The White Stripes')],
  },
  {
    title: "Sweet Child O' Mine",
    artist: "Guns N' Roses",
    truth: { key: 'Db', mode: 'major' },
    notes:
      'Tuned a half step down. Charts are written in D major; the recording sounds in Db. A catalog that reports the written key is a semitone wrong for a player with a guitar in standard tuning.',
    players: [
      canonical("Sweet Child O' Mine", "Guns N' Roses"),
      { title: "Sweet Child O' Mine", artist: 'GunsNRosesVEVO', sourceApp: 'chrome', shape: 'youtube' },
    ],
  },
  {
    title: "Livin' on a Prayer",
    artist: 'Bon Jovi',
    truth: { key: 'E', mode: 'minor' },
    modulates: true,
    notes: 'Opens in E minor and jumps to G minor for the last chorus; scored as an edge case.',
    players: [canonical("Livin' on a Prayer", 'Bon Jovi')],
  },
];

/** The rows accuracy is scored on: one key from start to finish. */
export const STABLE_SONGS = GROUND_TRUTH_SONGS.filter((song) => !song.modulates);

export const MODULATING_SONGS = GROUND_TRUTH_SONGS.filter((song) => song.modulates);
