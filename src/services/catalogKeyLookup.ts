import { parseKeyAndMode, parseSpotifyStyleKey, type ParsedKey } from './keyParse';
import { artistsMatch, buildMatchKeys, titlesLooselyMatch, titlesMatch } from './nameNormalize';

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

/**
 * "No key for this track" and "nobody answered" are different answers and must not collapse
 * into one: the caller caches a miss, so a throttled lookup would pin a track as keyless for
 * as long as the cache entry lives.
 */
export type CatalogLookupResult = {
  hit: CatalogHit | null;
  /**
   * No provider answered at all — every one of them was throttled, timed out or unreachable.
   * A single catalog saying "not in my database" is a real answer and does not count here:
   * one permanently rate-limited provider would otherwise mark every genuine miss unanswered
   * and put the caller in a retry loop it never leaves.
   */
  incomplete: boolean;
};

export type CatalogTraceFn = (
  event: string,
  message: string,
  detail?: Record<string, unknown>,
) => void;

export type CatalogLookupOptions = {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Ceiling for the whole provider chain, retries and backoff included. */
  budgetMs?: number;
  /** Internal: the absolute deadline derived from `budgetMs`, shared by every provider. */
  deadlineAt?: number;
  /** Internal: tallies how each request ended, shared by every provider in the chain. */
  outcomes?: { answered: number; transient: number };
  freqblogApiKey?: string | null;
  getsongbpmApiKey?: string | null;
  /**
   * Optional diagnostic hook. Shared by the frontend and the Worker — do not import
   * window-only loggers here. The chain swallows tracer errors so a log cannot break a lookup.
   */
  onTrace?: CatalogTraceFn;
};

/**
 * ReccoBeats answers 429 under load — a burst of 48 requests came back 25/23 split between
 * 200 and 429. Treating that as "this song has no key" is wrong twice over: it is not an
 * answer about the song, and it poisons the cache entry the caller keeps.
 */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
// A key that arrives after the listener has moved on is worth nothing, so the whole chain —
// four providers, retries and backoff included — is bounded by this.
const DEFAULT_BUDGET_MS = 8_000;

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

function emitTrace(
  opts: CatalogLookupOptions,
  event: string,
  message: string,
  detail?: Record<string, unknown>,
): void {
  try {
    opts.onTrace?.(event, message, detail);
  } catch {
    // Tracing must never break a lookup.
  }
}

/** Drop secrets from logged URLs. GetSongBPM puts the API key in the query string. */
function safeUrl(url: string | URL): string {
  try {
    const parsed = new URL(url.toString());
    for (const key of [...parsed.searchParams.keys()]) {
      if (/key|token|secret|auth/i.test(key)) {
        parsed.searchParams.set(key, '***');
      }
    }
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return String(url);
  }
}

export async function lookupKeyFromCatalogs(
  title: string,
  artist: string,
  options: CatalogLookupOptions = {},
): Promise<CatalogLookupResult> {
  // Every provider searches by free text, so player noise ("(Official Video)", "- Topic",
  // "- Remastered 2011") has to come off before the query, not after the results come back.
  const { cleanTitle, cleanArtist } = buildMatchKeys(title, artist);
  const titleTrim = cleanTitle.trim();
  const artistTrim = cleanArtist.trim();
  if (!titleTrim || !artistTrim) {
    emitTrace(options, 'chain.skip', 'No usable title+artist after cleaning player noise — cannot look up a key', {
      title,
      artist,
      cleanTitle,
      cleanArtist,
      why: 'empty_after_normalize',
    });
    return { hit: null, incomplete: false };
  }
  // One deadline for the chain, not one per request: four providers each retrying on their
  // own budget would let a fully throttled lookup run for the better part of a minute.
  const outcomes = options.outcomes ?? { answered: 0, transient: 0 };
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const opts: CatalogLookupOptions = {
    ...options,
    outcomes,
    deadlineAt: options.deadlineAt ?? Date.now() + budgetMs,
  };
  const done = (hit: CatalogHit | null): CatalogLookupResult => {
    const result: CatalogLookupResult = {
      hit,
      incomplete: hit === null && outcomes.transient > 0 && outcomes.answered === 0,
    };
    emitTrace(
      opts,
      hit ? 'chain.hit' : 'chain.miss',
      hit
        ? `Catalog chain hit via ${hit.provider}: ${hit.key} ${hit.mode}`
        : result.incomplete
          ? 'Catalog chain ended with no answer — every provider was throttled, timed out or unreachable'
          : 'Catalog chain ended with a real miss — at least one provider answered and none had this track',
      {
        provider: hit?.provider ?? null,
        key: hit?.key ?? null,
        mode: hit?.mode ?? null,
        incomplete: result.incomplete,
        answered: outcomes.answered,
        transient: outcomes.transient,
        why: hit ? 'hit' : result.incomplete ? 'all_transient' : 'answered_miss',
      },
    );
    return result;
  };

  emitTrace(opts, 'chain.start', 'Walking ReccoBeats → MusicIWant → FreqBlog → GetSongBPM', {
    title: titleTrim,
    artist: artistTrim,
    rawTitle: title,
    rawArtist: artist,
    budgetMs,
    hasFreqblogKey: Boolean(opts.freqblogApiKey?.trim()),
    hasGetSongBpmKey: Boolean(opts.getsongbpmApiKey?.trim()),
  });

  const recco = await lookupReccoBeats(titleTrim, artistTrim, opts);
  if (recco) {
    return done(recco);
  }

  const viaMusicIWant = await lookupMusicIWantThenRecco(titleTrim, artistTrim, opts);
  if (viaMusicIWant) {
    return done(viaMusicIWant);
  }

  if (opts.freqblogApiKey?.trim()) {
    const freq = await lookupFreqBlog(titleTrim, artistTrim, opts.freqblogApiKey.trim(), opts);
    if (freq) {
      return done(freq);
    }
  } else {
    emitTrace(opts, 'provider.skip', 'FreqBlog skipped — no API key configured', {
      provider: 'freqblog',
      why: 'no_api_key',
    });
  }

  if (opts.getsongbpmApiKey?.trim()) {
    const bpm = await lookupGetSongBpm(titleTrim, artistTrim, opts.getsongbpmApiKey.trim(), opts);
    if (bpm) {
      return done(bpm);
    }
  } else {
    emitTrace(opts, 'provider.skip', 'GetSongBPM skipped — no API key configured', {
      provider: 'getsongbpm',
      why: 'no_api_key',
    });
  }

  return done(null);
}

/**
 * One page of results, deliberately. ReccoBeats searches on the title alone — putting the
 * artist in `searchText` returns nothing at all — and for a generic title it answers with a
 * rotating sample of its two hundred matches rather than a stable ranking, so consecutive
 * searches disagree about whether the right artist is present. Reading further pages was
 * measured and does not fix that; it only adds seconds to every miss. Generic titles are
 * resolved by the exact title+artist providers later in the chain instead.
 */
async function lookupReccoBeats(
  title: string,
  artist: string,
  opts: CatalogLookupOptions,
): Promise<CatalogHit | null> {
  const url = new URL(`${RECCO_BASE}/v1/track/search`);
  url.searchParams.set('searchText', title);
  url.searchParams.set('size', '50');
  emitTrace(opts, 'provider.start', 'ReccoBeats: search by title, then pick the best artist match', {
    provider: 'reccobeats',
    title,
    artist,
  });
  const data = await getJson(url, opts);
  const rows = asArray(getProp(data, 'content'));
  const match = pickBestTrack(rows, title, artist);
  if (!match) {
    emitTrace(opts, 'match.miss', 'ReccoBeats search had no title+artist match', {
      provider: 'reccobeats',
      title,
      artist,
      rowCount: rows.length,
      why: rows.length === 0 ? 'empty_search' : 'no_title_artist_match',
    });
    return null;
  }
  emitTrace(opts, 'match.hit', `ReccoBeats matched "${match.title}" by ${match.artistNames.join(', ')}`, {
    provider: 'reccobeats',
    id: match.id,
    title: match.title,
    artists: match.artistNames,
    popularity: match.popularity,
    hasSpotifyId: Boolean(match.spotifyId),
  });
  const parsed = await reccoFeaturesForTrack(match, opts);
  if (!parsed) {
    emitTrace(opts, 'parse.fail', 'ReccoBeats matched the track but audio-features had no readable key/mode', {
      provider: 'reccobeats',
      id: match.id,
      why: 'unparsable_features',
    });
    return null;
  }
  emitTrace(opts, 'provider.hit', `ReccoBeats key ${parsed.key} ${parsed.mode}`, {
    provider: 'reccobeats',
    ...parsed,
  });
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
  emitTrace(opts, 'provider.start', 'MusicIWant: resolve title+artist to a Spotify id, then ReccoBeats features', {
    provider: 'musiciwant',
    title,
    artist,
  });
  const data = await getJson(url, opts);
  if (!data || getProp(data, 'found') !== true) {
    emitTrace(opts, 'provider.miss', 'MusicIWant did not find this title+artist', {
      provider: 'musiciwant',
      why: data ? 'found_false' : 'no_body',
    });
    return null;
  }
  const song = getProp(data, 'song');
  const spotifyId = asString(getProp(song, 'spotify_id'));
  if (!spotifyId) {
    emitTrace(opts, 'provider.miss', 'MusicIWant found the song but returned no Spotify id', {
      provider: 'musiciwant',
      why: 'missing_spotify_id',
    });
    return null;
  }
  const parsed = await reccoFeaturesBySpotifyId(spotifyId, opts);
  if (!parsed) {
    emitTrace(opts, 'parse.fail', 'MusicIWant Spotify id had no readable ReccoBeats key/mode', {
      provider: 'musiciwant',
      spotifyId,
      why: 'unparsable_features',
    });
    return null;
  }
  emitTrace(opts, 'provider.hit', `MusicIWant + ReccoBeats key ${parsed.key} ${parsed.mode}`, {
    provider: 'musiciwant',
    spotifyId,
    ...parsed,
  });
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
  emitTrace(opts, 'provider.start', 'FreqBlog: title+artist lookup', { provider: 'freqblog', title, artist });
  const data = await getJson(url, opts, { 'X-API-Key': apiKey });
  const parsed = parseKeyAndMode(asString(getProp(data, 'key')));
  if (!parsed) {
    emitTrace(opts, 'parse.fail', 'FreqBlog answered but the key string could not be read', {
      provider: 'freqblog',
      rawKey: asString(getProp(data, 'key')),
      why: data ? 'unparsable_key' : 'no_body',
    });
    return null;
  }
  emitTrace(opts, 'provider.hit', `FreqBlog key ${parsed.key} ${parsed.mode}`, { provider: 'freqblog', ...parsed });
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
  emitTrace(opts, 'provider.start', 'GetSongBPM: title+artist search', { provider: 'getsongbpm', title, artist });
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
      return (
        (titlesMatch(rowTitle, title) || titlesLooselyMatch(rowTitle, title)) &&
        artistsMatch(rowArtist, artist)
      );
    }) ?? (rows.length === 1 ? rows[0] : undefined);
  if (!match || typeof match !== 'object') {
    emitTrace(opts, 'match.miss', 'GetSongBPM search had no title+artist match', {
      provider: 'getsongbpm',
      rowCount: rows.length,
      why: rows.length === 0 ? 'empty_search' : 'no_title_artist_match',
    });
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
    emitTrace(opts, 'parse.fail', 'GetSongBPM matched the track but the key fields could not be read', {
      provider: 'getsongbpm',
      rawKey: keyRaw,
      rawMode: modeRaw,
      why: 'unparsable_key',
    });
    return null;
  }
  emitTrace(opts, 'provider.hit', `GetSongBPM key ${parsed.key} ${parsed.mode}`, {
    provider: 'getsongbpm',
    ...parsed,
  });
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
  const exact = parsed.filter((t) => titlesMatch(t.title, title));
  // Falling back to the whole result set let "One" take the key of "One More Time": the
  // artist filter alone does not separate two songs by the same artist.
  const pool = exact.length > 0 ? exact : parsed.filter((t) => titlesLooselyMatch(t.title, title));
  const withArtist = pool.filter((t) => t.artistNames.some((name) => artistsMatch(name, artist)));
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

/**
 * Honours `Retry-After` when the provider sends one, otherwise backs off exponentially from
 * 400ms with jitter. The jitter is not decoration: without it every caller that was throttled
 * in the same window retries in the same millisecond and throttles itself again.
 */
function retryDelayMs(res: Response | null, attempt: number): number {
  const header = res?.headers?.get('retry-after');
  const seconds = header ? Number(header) : Number.NaN;
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, 4_000);
  }
  const base = 400 * 2 ** attempt;
  return Math.round(base * (0.5 + Math.random()));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // Same trap as in `getJson`: a listener added to an already-aborted signal never fires,
    // so the backoff would run to completion after the caller had given up.
    if (signal?.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchOnce(
  url: string | URL,
  opts: CatalogLookupOptions,
  headers: Record<string, string> | undefined,
  deadline: number,
): Promise<{ res: Response | null; body: unknown; retryable: boolean }> {
  const doFetch = opts.fetch ?? fetch;
  // Never wait past the chain deadline, however generous the per-attempt timeout is.
  const timeoutMs = Math.max(1, Math.min(opts.timeoutMs ?? 5_000, deadline - Date.now()));
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
      return { res, body: null, retryable: RETRYABLE_STATUSES.has(res.status) };
    }
    return { res, body: await res.json(), retryable: false };
  } catch (error) {
    // A provider that fails or times out is just a miss for that provider. A caller-side abort
    // is not: swallowing it would report "no key for this track" for a lookup that never ran.
    if (opts.signal?.aborted) {
      emitTrace(opts, 'http.aborted', 'Lookup cancelled while a provider request was in flight', {
        url: safeUrl(url),
        why: 'caller_aborted',
      });
      throw error;
    }
    emitTrace(opts, 'http.transport', 'Request failed or timed out — will retry if budget remains', {
      url: safeUrl(url),
      why: 'timeout_or_network',
    });
    // A timeout or a dropped connection is worth one more try, same as a 429.
    return { res: null, body: null, retryable: true };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

async function getJson(
  url: string | URL,
  opts: CatalogLookupOptions,
  headers?: Record<string, string>,
): Promise<unknown> {
  const loggedUrl = safeUrl(url);
  // An `abort` listener never fires for a signal that is already aborted, so check up front:
  // otherwise a cancelled lookup keeps walking the provider chain.
  if (opts.signal?.aborted) {
    emitTrace(opts, 'http.aborted', 'Lookup cancelled before the request was sent', {
      url: loggedUrl,
      why: 'caller_aborted',
    });
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
  const deadline = opts.deadlineAt ?? Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
  if (Date.now() >= deadline) {
    if (opts.outcomes) {
      opts.outcomes.transient += 1;
    }
    emitTrace(opts, 'http.budget', 'Chain budget exhausted — skipping this request', {
      url: loggedUrl,
      why: 'budget_exhausted',
    });
    return null;
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const timeoutMs = Math.max(1, Math.min(opts.timeoutMs ?? 5_000, deadline - Date.now()));
    emitTrace(opts, 'http.send', `GET ${loggedUrl} (attempt ${attempt + 1}/${MAX_ATTEMPTS})`, {
      url: loggedUrl,
      attempt: attempt + 1,
      attempts: MAX_ATTEMPTS,
      timeoutMs,
      remainingBudgetMs: Math.max(0, deadline - Date.now()),
    });
    const started = Date.now();
    const { res, body, retryable } = await fetchOnce(url, opts, headers, deadline);
    const elapsedMs = Date.now() - started;
    if (!retryable) {
      // Both a payload and a definitive rejection ("not in my catalog") count as an answer.
      if (opts.outcomes) {
        opts.outcomes.answered += 1;
      }
      if (res && !res.ok) {
        emitTrace(opts, 'http.reject', `Definite rejection HTTP ${res.status} — this provider does not have the track`, {
          url: loggedUrl,
          status: res.status,
          elapsedMs,
          why: 'http_not_ok',
        });
      } else {
        emitTrace(opts, 'http.ok', `HTTP ${res?.status ?? '?'} — provider answered`, {
          url: loggedUrl,
          status: res?.status ?? null,
          elapsedMs,
          hasBody: body != null,
        });
      }
      return body;
    }
    const delay = retryDelayMs(res, attempt);
    const status = res?.status ?? null;
    if (attempt === MAX_ATTEMPTS - 1 || Date.now() + delay >= deadline) {
      // Out of retries on something that was never an answer — the caller has to know.
      if (opts.outcomes) {
        opts.outcomes.transient += 1;
      }
      emitTrace(opts, 'http.exhausted', `Giving up after ${attempt + 1} attempt(s) — ${status ?? 'timeout/network'} is not an answer about the song`, {
        url: loggedUrl,
        status,
        elapsedMs,
        attempt: attempt + 1,
        why: 'retry_exhausted',
      });
      return null;
    }
    emitTrace(opts, 'http.retry', `HTTP ${status ?? 'timeout/network'} — retrying in ${delay}ms`, {
      url: loggedUrl,
      status,
      elapsedMs,
      delayMs: delay,
      attempt: attempt + 1,
      why: 'retryable',
    });
    await sleep(delay, opts.signal);
  }
  return null;
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
