/**
 * One name-normalization pipeline for every place a title or artist is matched: the verified
 * database in the worker, the external catalogs, and the local track identity/cache key.
 *
 * Three levels, least to most aggressive:
 *
 * - `legacyNormalize` — lowercase + collapsed whitespace. This is the exact shape of the
 *   `normalized_title` / `normalized_artist` columns written before this module existed, so
 *   lookups must keep probing it or they stop matching rows already in the table.
 * - `cleanTrackTitle` / `cleanArtistName` — strip player noise ("(Official Video)", "- Topic",
 *   "feat. X", "- Remastered 2011") while keeping a human-readable name.
 * - `foldName` — match-only key: accents, punctuation and a leading "the" are gone. This is
 *   what new rows store, and what catalog results are compared against.
 */

/**
 * Words that only ever describe the *upload*, not the song. A bracketed or dash-delimited
 * segment containing one of these is dropped whole.
 */
const NOISE_TOKEN =
  /\b(?:official|officiel|oficial|video|videoclip|vid[eé]o|audio|lyrics?|lyric|letra|visuali[sz]er|hd|hq|4k|8k|mv|explicit|clean|uncensored|remaster(?:ed)?|remasteris[ée]|re-?master|anniversary|edition|deluxe|bonus|mono|stereo|radio edit|album version|single version|extended|original mix|live|acoustic|instrumental|cover|karaoke|audio only|full album|hq audio)\b/i;

/** A segment that is only a year — "(2011)", "- 2019". */
const YEAR_ONLY = /^\(?\s*(?:19|20)\d{2}\s*\)?$/;

const FEAT = /\s*[([]?\s*\b(?:feat|ft|featuring)\b\.?\s+[^)\]]*[)\]]?\s*$/i;

/**
 * Channel decorations on the artist side. Applied repeatedly, because a single channel name
 * stacks several of them ("Queen Official - Topic").
 */
const ARTIST_SUFFIX_NOISE = [
  /\s*[-\u2013\u2014]?\s*topic\s*$/i,
  /\s*[-\u2013\u2014]?\s*\bofficial(?:\s+(?:channel|music|videos?|audio|artist|page))?\s*$/i,
  // No word boundary: YouTube glues it on, as in "EminemVEVO".
  /\s*[-\u2013\u2014]?\s*vevo\s*$/i,
  /\s*[-\u2013\u2014]\s*music\s*$/i,
];

const PRIMARY_ARTIST_SPLIT = /\s*(?:,|&|\bx\b|\bvs\.?\b|\band\b|\bwith\b|\bfeat\b\.?|\bft\b\.?|\bfeaturing\b|\/)\s*/i;

function unifyPunctuation(value: string): string {
  return value
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lowercase + collapsed whitespace — the shape of the existing `normalized_*` columns. */
export function legacyNormalize(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, ' ');
}

function dropNoiseBrackets(value: string): string {
  let out = value;
  let previous: string;
  do {
    previous = out;
    out = out.replace(/\s*[([{]([^()[\]{}]*)[)\]}]/g, (whole, inner: string) =>
      NOISE_TOKEN.test(inner) || YEAR_ONLY.test(inner.trim()) ? ' ' : whole,
    );
  } while (out !== previous);
  return out;
}

/**
 * Drops trailing " - Remastered 2011" / " - Official Video" style segments. Only trailing
 * segments are considered: a leading "Artist - " is handled by `buildMatchKeys`, which can
 * check it against the real artist instead of guessing.
 */
function dropNoiseDashSuffix(value: string): string {
  const parts = value.split(/\s+-\s+/);
  while (parts.length > 1) {
    const last = parts[parts.length - 1] ?? '';
    if (NOISE_TOKEN.test(last) || YEAR_ONLY.test(last.trim())) {
      parts.pop();
      continue;
    }
    break;
  }
  return parts.join(' - ');
}

export function cleanTrackTitle(raw: string): string {
  const unified = unifyPunctuation(raw);
  if (!unified) {
    return '';
  }
  const cleaned = dropNoiseDashSuffix(dropNoiseBrackets(unified))
    .replace(FEAT, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—|:,]+|[\s\-–—|:,]+$/g, '')
    .trim();
  // Never hand back an empty title: a title made only of noise words is still better than nothing.
  return cleaned || unified;
}

export function cleanArtistName(raw: string): string {
  const unified = unifyPunctuation(raw);
  if (!unified) {
    return '';
  }
  let cleaned = dropNoiseBrackets(unified);
  let previous: string;
  do {
    previous = cleaned;
    for (const pattern of ARTIST_SUFFIX_NOISE) {
      cleaned = cleaned.replace(pattern, '');
    }
  } while (cleaned !== previous);
  cleaned = cleaned
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—|:,]+|[\s\-–—|:,]+$/g, '')
    .trim();
  return cleaned || unified;
}

/**
 * Match-only key. Two names that fold to the same string are the same name for lookup
 * purposes: "Beyoncé" / "Beyonce", "Don't Stop Me Now" / "Dont Stop Me Now",
 * "Simon & Garfunkel" / "Simon and Garfunkel", "The Beatles" / "Beatles".
 */
export function foldName(value: string): string {
  return unifyPunctuation(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[&＆]/g, ' and ')
    // Dropped, not spaced: "Don't"/"Dont" and "R.E.M."/"REM" have to fold together.
    .replace(/['.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^the\s+/, '')
    .replace(/\s+/g, ' ');
}

/**
 * Same key with the word breaks removed. YouTube channel names glue them together
 * ("GunsNRosesVEVO"), so a space-separated fold never lines up with the catalog's spelling.
 */
export function compactFold(value: string): string {
  return foldName(value).replace(/\s+/g, '');
}

/** The value new `normalized_title` / `normalized_artist` rows store. */
export function canonicalTitleKey(raw: string): string {
  return foldName(cleanTrackTitle(raw));
}

export function canonicalArtistKey(raw: string): string {
  return foldName(cleanArtistName(raw));
}

/** "Red Hot Chili Peppers" → "rhcp": how acronym channels ("RHCPVEVO") spell the same band. */
function initials(value: string): string {
  const words = foldName(value).split(' ').filter(Boolean);
  return words.length >= 3 ? words.map((w) => w[0]).join('') : '';
}

/** Channel suffixes we do not strip by name but will tolerate as a short unmatched tail. */
const MAX_CHANNEL_TAIL = 5;

/**
 * Whether two spellings name the same artist. Channels write the name any way they like —
 * glued ("GunsNRosesVEVO"), suffixed ("MetallicaTV"), or as initials ("RHCPVEVO") — while
 * catalogs use the canonical spelling, so equality alone is not enough.
 */
export function sameArtistName(a: string, b: string): boolean {
  const fa = canonicalArtistKey(a);
  const fb = canonicalArtistKey(b);
  if (!fa || !fb) {
    return false;
  }
  if (fa === fb) {
    return true;
  }
  const ca = compactFold(fa);
  const cb = compactFold(fb);
  if (ca === cb) {
    return true;
  }
  // Only a short unmatched tail counts, or "Queen" would swallow "Queens of the Stone Age".
  const [shortC, longC] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
  if (longC.startsWith(shortC) && longC.length - shortC.length <= MAX_CHANNEL_TAIL) {
    return true;
  }
  const ia = initials(fa);
  const ib = initials(fb);
  return (Boolean(ia) && ia === cb) || (Boolean(ib) && ib === ca);
}

/** "The Weeknd, Daft Punk" → "the weeknd". Catalogs disagree constantly about the tail. */
export function primaryArtist(raw: string): string {
  const cleaned = cleanArtistName(raw);
  const [first] = cleaned.split(PRIMARY_ARTIST_SPLIT);
  return (first ?? '').trim() || cleaned;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.length > 0))];
}

export type MatchKeys = {
  /** Display-ready name with player noise removed. */
  cleanTitle: string;
  cleanArtist: string;
  /** Every stored form a row for this track could plausibly carry, most exact first. */
  titleKeys: string[];
  artistKeys: string[];
};

/**
 * Builds the candidate keys a database lookup should probe. Both the legacy (lowercase-only)
 * and folded spaces are included because the table holds rows written under both schemes.
 */
export function buildMatchKeys(title: string, artist: string): MatchKeys {
  const cleanArtist = cleanArtistName(artist);
  const artistFold = foldName(cleanArtist);

  let workingTitle = unifyPunctuation(title);
  // YouTube-style "Artist - Song" / "Artist: Song": only strip the prefix when it really is
  // the artist, so a title that just happens to contain a separator survives intact.
  const headMatch = /^(.+?)(\s+[-\u2013\u2014|]\s+|\s*:\s+)(.+)$/.exec(workingTitle);
  const rawHead = headMatch?.[1];
  const rest = headMatch?.[3];
  if (rawHead && rest && artistFold) {
    const head = foldName(rawHead);
    // Either direction: the channel may carry a tail the title drops ("Queen Official"), or
    // the title may list collaborators the artist field does not ("Linkin Park & Jay-Z - ...").
    const headIsArtist =
      sameArtistName(rawHead, cleanArtist) ||
      artistFold.startsWith(`${head} `) ||
      head.startsWith(`${artistFold} `);
    if (head && headIsArtist) {
      workingTitle = rest;
    }
  }
  const cleanTitle = cleanTrackTitle(workingTitle);

  return {
    cleanTitle,
    cleanArtist,
    titleKeys: dedupe([
      legacyNormalize(title),
      legacyNormalize(cleanTitle),
      foldName(title),
      foldName(cleanTitle),
    ]),
    artistKeys: dedupe([
      legacyNormalize(artist),
      legacyNormalize(cleanArtist),
      foldName(artist),
      foldName(cleanArtist),
      foldName(primaryArtist(artist)),
    ]),
  };
}

/** Titles must agree exactly once folded — "One" is not "One More Time". */
export function titlesMatch(a: string, b: string): boolean {
  const fa = canonicalTitleKey(a);
  const fb = canonicalTitleKey(b);
  return Boolean(fa) && (fa === fb || compactFold(fa) === compactFold(fb));
}

/**
 * Fallback for providers that decorate titles in ways `cleanTrackTitle` does not know about.
 * Containment only, and only when the shorter name carries enough signal to be meaningful.
 */
export function titlesLooselyMatch(a: string, b: string): boolean {
  const fa = canonicalTitleKey(a);
  const fb = canonicalTitleKey(b);
  if (!fa || !fb) {
    return false;
  }
  const [shorter, longer] = fa.length <= fb.length ? [fa, fb] : [fb, fa];
  if (shorter.length < 6) {
    return false;
  }
  return longer.startsWith(`${shorter} `) || longer.includes(` ${shorter} `) || longer.endsWith(` ${shorter}`) || longer === shorter;
}

/** Artists may legitimately differ by a collaborator tail, so a primary-artist hit counts. */
export function artistsMatch(a: string, b: string): boolean {
  if (sameArtistName(a, b)) {
    return true;
  }
  const pa = primaryArtist(a);
  const pb = primaryArtist(b);
  if (!foldName(pa)) {
    return false;
  }
  return sameArtistName(pa, pb) || sameArtistName(pa, b) || sameArtistName(a, pb);
}
