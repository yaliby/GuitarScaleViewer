import { parseKeyAndMode, parseSpotifyStyleKey, type ParsedKey } from './keyParse';

/**
 * External catalogs used after our verified DB and before the local audio engine.
 *
 * Included:
 * - ReccoBeats (name search + Spotify-style key/mode, no API key)
 * - MusicIWant (title/artist → Spotify ID, then ReccoBeats features)
 * - FreqBlog (title/artist → key, optional API key)
 * - GetSongBPM (title/artist → key, optional API key + attribution)
 *
 * Skipped on purpose:
 * - Spotify audio-features: removed for new apps (Nov 2024)
 * - AcousticBrainz: live API is gone
 * - Tunebat: no official public API
 * - AudD / ACRCloud: identify a recording from audio, they do not return key
 * - MusicBrainz: identity only, no key
 */

export type CatalogProvider = 'reccobeats' | 'musiciwant' | 'freqblog' | 'getsongbpm';

export type CatalogHit = ParsedKey & {
  provider: CatalogProvider;
  title: string;
  artist: string;
  remoteId: string;
};

export type CatalogLookupOptions = {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  freqblogApiKey?: string | null;
  getsongbpmApiKey?: string | null;
};

const RECCO_BASE = 'https://api.reccobeats.com';
const MUSICIWANT_SONG = 'https://musiciwant.com/api/v1/song';
const FREQBLOG_LOOKUP = 'https://api.freqblog.com/lookup';
const GETSONGBPM_SEARCH = 'https://api.getsongbpm.com/search/';

export function catalogProviderLabel(provider: CatalogProvider): string {
  switch (provider) {
    case 'reccobeats':
      return 'ReccoBeats';
    case 'musiciwant':
      return 'MusicIWant + ReccoBeats';
    case 'freqblog':
      return 'FreqBlog';
    case 'getsongbpm':
      return 'GetSongBPM';
  }
}

export async function lookupKeyFromCatalogs(
  title: string,
  artist: string,
  opts: CatalogLookupOptions = {},
): Promise<CatalogHit | null> {
  const titleTrim = title.trim();
  const artistTrim = artist.trim();
  if (!titleTrim || !artistTrim) {
    return null;
  }

  const recco = await lookupReccoBeats(titleTrim, artistTrim, opts);
  if (recco) {
    return recco;
  }

  const viaMusicIWant = await lookupMusicIWantThenRecco(titleTrim, artistTrim, opts);
  if (viaMusicIWant) {
    return viaMusicIWant;
  }

  if (opts.freqblogApiKey?.trim()) {
    const freq = await lookupFreqBlog(titleTrim, artistTrim, opts.freqblogApiKey.trim(), opts);
    if (freq) {
      return freq;
    }
  }

  if (opts.getsongbpmApiKey?.trim()) {
    const bpm = await lookupGetSongBpm(titleTrim, artistTrim, opts.getsongbpmApiKey.trim(), opts);
    if (bpm) {
      return bpm;
    }
  }

  return null;
}

async function lookupReccoBeats(
  title: string,
  artist: string,
  opts: CatalogLookupOptions,
): Promise<CatalogHit | null> {
  const url = new URL(`${RECCO_BASE}/v1/track/search`);
  url.searchParams.set('searchText', title);
  url.searchParams.set('size', '50');
  const data = await getJson(url, opts);
  const tracks = asArray(getProp(data, 'content'));
  const match = pickBestTrack(tracks, title, artist);
  if (!match) {
    return null;
  }
  const parsed = await reccoFeaturesForTrack(match, opts);
  if (!parsed) {
    return null;
  }
  return {
    provider: 'reccobeats',
    title: match.title || title,
    artist: match.artistNames[0] || artist,
    remoteId: match.id,
    ...parsed,
  };
}

async function lookupMusicIWantThenRecco(
  title: string,
  artist: string,
  opts: CatalogLookupOptions,
): Promise<CatalogHit | null> {
  const url = new URL(MUSICIWANT_SONG);
  url.searchParams.set('title', title);
  url.searchParams.set('artist', artist);
  const data = await getJson(url, opts);
  if (!data || getProp(data, 'found') !== true) {
    return null;
  }
  const song = getProp(data, 'song');
  const spotifyId = asString(getProp(song, 'spotify_id'));
  if (!spotifyId) {
    return null;
  }
  const parsed = await reccoFeaturesBySpotifyId(spotifyId, opts);
  if (!parsed) {
    return null;
  }
  return {
    provider: 'musiciwant',
    title: asString(getProp(song, 'title')) || title,
    artist: asString(getProp(song, 'artist')) || artist,
    remoteId: spotifyId,
    ...parsed,
  };
}

async function lookupFreqBlog(
  title: string,
  artist: string,
  apiKey: string,
  opts: CatalogLookupOptions,
): Promise<CatalogHit | null> {
  const url = new URL(FREQBLOG_LOOKUP);
  url.searchParams.set('track', title);
  url.searchParams.set('artist', artist);
  const data = await getJson(url, opts, { 'X-API-Key': apiKey });
  const parsed = parseKeyAndMode(asString(getProp(data, 'key')));
  if (!parsed) {
    return null;
  }
  return {
    provider: 'freqblog',
    title: asString(getProp(data, 'track_name')) || title,
    artist: asString(getProp(data, 'artist_name')) || artist,
    remoteId: asString(getProp(data, 'isrc')) || `${title}|${artist}`,
    ...parsed,
  };
}

async function lookupGetSongBpm(
  title: string,
  artist: string,
  apiKey: string,
  opts: CatalogLookupOptions,
): Promise<CatalogHit | null> {
  const url = new URL(GETSONGBPM_SEARCH);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('type', 'both');
  url.searchParams.set('lookup', `song:${title} artist:${artist}`);
  const data = await getJson(url, opts, { 'X-API-KEY': apiKey });
  const rows = firstNonEmptyArray(
    getProp(data, 'search'),
    getProp(data, 'songs'),
    getProp(data, 'results'),
  );
  const match =
    rows.find((row) => {
      const rowTitle = asString(getProp(row, 'song_title') ?? getProp(row, 'title'));
      const rowArtist = asString(
        getProp(getProp(row, 'artist'), 'name') ?? getProp(row, 'artist') ?? getProp(row, 'artist_name'),
      );
      return namesMatch(rowTitle, title) && namesMatch(rowArtist, artist);
    }) ?? (rows.length === 1 ? rows[0] : undefined);
  if (!match || typeof match !== 'object') {
    return null;
  }
  const keyRaw = asString(
    getProp(match, 'key_of') ?? getProp(match, 'key') ?? getProp(getProp(match, 'music_key'), 'key_of'),
  );
  const modeRaw = asString(
    getProp(match, 'mode') ?? getProp(getProp(match, 'music_key'), 'mode'),
  );
  const parsed =
    parseSpotifyStyleKey(getProp(match, 'key_of') ?? getProp(match, 'key'), modeRaw) ??
    parseKeyAndMode([keyRaw, modeRaw].filter(Boolean).join(' '));
  if (!parsed) {
    return null;
  }
  return {
    provider: 'getsongbpm',
    title: asString(getProp(match, 'song_title') ?? getProp(match, 'title')) || title,
    artist:
      asString(getProp(getProp(match, 'artist'), 'name') ?? getProp(match, 'artist')) || artist,
    remoteId: asString(getProp(match, 'id')) || `${title}|${artist}`,
    ...parsed,
  };
}

type ReccoTrack = {
  id: string;
  title: string;
  artistNames: string[];
  popularity: number;
  spotifyId: string | null;
};

async function reccoFeaturesForTrack(
  track: ReccoTrack,
  opts: CatalogLookupOptions,
): Promise<ParsedKey | null> {
  if (track.spotifyId) {
    const bySpotify = await reccoFeaturesBySpotifyId(track.spotifyId, opts);
    if (bySpotify) {
      return bySpotify;
    }
  }
  const data = await getJson(`${RECCO_BASE}/v1/track/${encodeURIComponent(track.id)}/audio-features`, opts);
  return parseSpotifyStyleKey(getProp(data, 'key'), getProp(data, 'mode'));
}

async function reccoFeaturesBySpotifyId(
  spotifyId: string,
  opts: CatalogLookupOptions,
): Promise<ParsedKey | null> {
  const url = new URL(`${RECCO_BASE}/v1/audio-features`);
  url.searchParams.set('ids', spotifyId);
  const data = await getJson(url, opts);
  const row = asArray(getProp(data, 'content'))[0] ?? data;
  return parseSpotifyStyleKey(getProp(row, 'key'), getProp(row, 'mode'));
}

function pickBestTrack(rows: unknown[], title: string, artist: string): ReccoTrack | null {
  const parsed = rows.map(readReccoTrack).filter((t): t is ReccoTrack => t !== null);
  const titled = parsed.filter((t) => namesMatch(t.title, title));
  const pool = titled.length > 0 ? titled : parsed;
  const withArtist = pool.filter((t) => t.artistNames.some((name) => namesMatch(name, artist)));
  if (withArtist.length === 0) {
    return null;
  }
  return withArtist.sort((a, b) => b.popularity - a.popularity)[0] ?? null;
}

function readReccoTrack(row: unknown): ReccoTrack | null {
  if (!row || typeof row !== 'object') {
    return null;
  }
  const id = asString(getProp(row, 'id'));
  if (!id) {
    return null;
  }
  const artists = asArray(getProp(row, 'artists'));
  const artistNames = artists
    .map((a) => asString(getProp(a, 'name')))
    .filter((name): name is string => Boolean(name));
  const href = asString(getProp(row, 'href'));
  const spotifyId = href.match(/open\.spotify\.com\/track\/([A-Za-z0-9]+)/)?.[1] ?? null;
  const popularityRaw = getProp(row, 'popularity');
  return {
    id,
    title: asString(getProp(row, 'trackTitle') ?? getProp(row, 'title')),
    artistNames,
    popularity: typeof popularityRaw === 'number' ? popularityRaw : 0,
    spotifyId,
  };
}

function namesMatch(a: string, b: string): boolean {
  const fa = foldName(a);
  const fb = foldName(b);
  if (!fa || !fb) {
    return false;
  }
  return fa === fb || fa.includes(fb) || fb.includes(fa);
}

function foldName(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^the\s+/, '');
}

async function getJson(
  url: string | URL,
  opts: CatalogLookupOptions,
  headers?: Record<string, string>,
): Promise<unknown> {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await doFetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...headers,
      },
      signal: ac.signal,
    });
    if (!res.ok) {
      return null;
    }
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

function getProp(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstNonEmptyArray(...candidates: unknown[]): unknown[] {
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      return candidate;
    }
  }
  return [];
}
