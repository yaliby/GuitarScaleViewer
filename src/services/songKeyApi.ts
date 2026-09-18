import { parseSpotifyStyleKey, type ParsedKey } from './keyParse';
import {
  catalogProviderLabel,
  lookupKeyFromCatalogs,
  type CatalogProvider,
} from './catalogKeyLookup';
import { trace } from './debugLog';

const DEFAULT_API_BASE = 'https://chordsync-api.yali-chordsync.workers.dev';
const API_BASE_OVERRIDE_KEY = 'gsv_api_base_override';
const FREQBLOG_KEY_STORAGE = 'gsv_freqblog_api_key';
const GETSONGBPM_KEY_STORAGE = 'gsv_getsongbpm_api_key';
const REQUEST_TIMEOUT_MS = 8_000;

/**
 * A request that never settles is worse than a miss: the lookup effect stays pending
 * for the whole track. Bound every call, while still honouring the caller's own signal
 * so a track change aborts immediately rather than waiting out the deadline.
 */
async function fetchWithDeadline(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const sourceSignal = init.signal;
  let timedOut = false;
  const abortFromSource = () => controller.abort(sourceSignal?.reason);
  if (sourceSignal?.aborted) {
    abortFromSource();
  } else {
    sourceSignal?.addEventListener('abort', abortFromSource, { once: true });
  }
  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('Request timed out', 'TimeoutError'));
  }, REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    sourceSignal?.removeEventListener('abort', abortFromSource);
  }
}

function currentApiBase(): string {
  if (typeof window === 'undefined') {
    return DEFAULT_API_BASE;
  }
  const override = window.localStorage.getItem(API_BASE_OVERRIDE_KEY)?.trim();
  return override || DEFAULT_API_BASE;
}

function readStorage(key: string): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return window.localStorage.getItem(key)?.trim() || null;
}

function writeStorage(key: string, value: string | null): void {
  if (typeof window === 'undefined') {
    return;
  }
  const trimmed = (value ?? '').trim();
  if (!trimmed) {
    window.localStorage.removeItem(key);
  } else {
    window.localStorage.setItem(key, trimmed);
  }
}

export function getSongKeyApiBaseForDev(): string {
  return currentApiBase();
}

export function setSongKeyApiBaseForDev(nextBase: string | null): void {
  writeStorage(API_BASE_OVERRIDE_KEY, nextBase);
}

export function getFreqblogApiKeyForDev(): string {
  return readStorage(FREQBLOG_KEY_STORAGE) ?? '';
}

export function setFreqblogApiKeyForDev(nextKey: string | null): void {
  writeStorage(FREQBLOG_KEY_STORAGE, nextKey);
}

export function getGetSongBpmApiKeyForDev(): string {
  return readStorage(GETSONGBPM_KEY_STORAGE) ?? '';
}

export function setGetSongBpmApiKeyForDev(nextKey: string | null): void {
  writeStorage(GETSONGBPM_KEY_STORAGE, nextKey);
}

export type KeyLookupSource = 'verified_db' | CatalogProvider;

export type LookupSongInput = {
  title: string;
  artist: string;
};

export type LookupSongHit = {
  id: string;
  title: string;
  artist: string;
  musical_key: string;
  /**
   * Left loose on purpose: catalogs answer with '', '0', 'Minor' and Spotify-style
   * integers. `normalizeLookupKey` is the single place that decides whether a record
   * is readable, and an unreadable one is reported as a miss rather than throwing.
   */
  mode: string;
  verified: boolean;
  source: KeyLookupSource;
  sourceLabel: string;
};

export type LookupSongResult =
  | { found: true; song: LookupSongHit }
  | {
      found: false;
      song: null;
      catalogsTried: boolean;
      /**
       * The catalogs were asked but never answered — throttled, timed out or unreachable.
       * This is not "the song has no key", and the caller must not cache it as one.
       */
      incomplete?: boolean;
    };

export type SuggestionInput = {
  title: string;
  artist: string;
  key: string;
  mode: 'major' | 'minor';
  user?: string;
};

/** Bounds on fields accepted from the API, matching the Worker's own input limits. */
const MAX_TITLE_LENGTH = 300;
const MAX_ARTIST_LENGTH = 200;
const MAX_ID_LENGTH = 200;
const MAX_KEY_LENGTH = 32;

function assertString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`Invalid ${field} in API response`);
  }
  return value;
}

function isCatalogProvider(value: string): value is CatalogProvider {
  return value === 'reccobeats' || value === 'musiciwant' || value === 'freqblog' || value === 'getsongbpm';
}

function hitFromCatalog(
  title: string,
  artist: string,
  catalog: NonNullable<Awaited<ReturnType<typeof lookupKeyFromCatalogs>>['hit']>,
): LookupSongHit {
  return {
    id: `${catalog.provider}:${catalog.remoteId}`,
    title: catalog.title || title,
    artist: catalog.artist || artist,
    musical_key: catalog.key,
    mode: catalog.mode,
    verified: false,
    source: catalog.provider,
    sourceLabel: catalogProviderLabel(catalog.provider),
  };
}

async function lookupOwnDatabase(
  input: LookupSongInput,
  signal?: AbortSignal,
): Promise<LookupSongResult | 'network_error'> {
  const title = input.title.trim();
  const artist = input.artist.trim();
  const url = new URL('/lookup-song', currentApiBase());
  url.searchParams.set('title', title);
  url.searchParams.set('artist', artist);

  const started = Date.now();
  try {
    trace('cloud', 'own_db.send', `Asking verified DB at ${url.origin}`, {
      url: url.toString(),
      title,
      artist,
    }, 'start');
    const res = await fetchWithDeadline(url.toString(), { method: 'GET', signal });
    const elapsedMs = Date.now() - started;
    if (!res.ok) {
      trace('cloud', 'own_db.http_fail', `Worker returned HTTP ${res.status} — not a song miss; falling through to client catalogs`, {
        status: res.status,
        elapsedMs,
        why: 'http_not_ok',
      }, 'fail');
      return 'network_error';
    }
    const data = (await res.json()) as unknown;
    if (!data || typeof data !== 'object') {
      trace('cloud', 'own_db.bad_body', 'Worker returned a non-object body — treating as network_error', {
        elapsedMs,
        why: 'invalid_json_shape',
      }, 'fail');
      return 'network_error';
    }
    const found = (data as { found?: unknown }).found;
    const catalogsTried = Boolean((data as { catalogsTried?: unknown }).catalogsTried);
    if (found === false) {
      trace('cloud', 'own_db.miss', catalogsTried
        ? 'Worker already walked catalogs and found nothing'
        : 'Verified DB miss; Worker did not try catalogs (client will)', {
        catalogsTried,
        elapsedMs,
        why: catalogsTried ? 'worker_complete_miss' : 'worker_db_miss',
      }, 'skip');
      return { found: false, song: null, catalogsTried };
    }
    if (found !== true) {
      trace('cloud', 'own_db.bad_found', `Worker 'found' field was ${String(found)} — treating as network_error`, {
        elapsedMs,
        why: 'invalid_found_field',
      }, 'fail');
      return 'network_error';
    }
    const song = (data as { song?: unknown }).song;
    if (!song || typeof song !== 'object') {
      trace('cloud', 'own_db.bad_song', 'Worker said found=true but sent no song object', {
        elapsedMs,
        why: 'missing_song',
      }, 'fail');
      return 'network_error';
    }
    const rawSource = asOptionalString((song as { source?: unknown }).source) ?? asOptionalString((data as { source?: unknown }).source);
    const source: KeyLookupSource =
      rawSource === 'verified_db' || (rawSource ? isCatalogProvider(rawSource) : false)
        ? (rawSource as KeyLookupSource)
        : Boolean((song as { verified?: unknown }).verified)
          ? 'verified_db'
          : 'reccobeats';
    const hit: LookupSongHit = {
      id: assertString((song as { id?: unknown }).id, 'song.id', MAX_ID_LENGTH),
      title: assertString((song as { title?: unknown }).title, 'song.title', MAX_TITLE_LENGTH),
      artist: assertString((song as { artist?: unknown }).artist, 'song.artist', MAX_ARTIST_LENGTH),
      musical_key: assertString(
        (song as { musical_key?: unknown }).musical_key,
        'song.musical_key',
        MAX_KEY_LENGTH,
      ),
      mode: assertString((song as { mode?: unknown }).mode, 'song.mode', MAX_KEY_LENGTH),
      verified: source === 'verified_db' || Boolean((song as { verified?: unknown }).verified),
      source,
      sourceLabel:
        asOptionalString((data as { sourceLabel?: unknown }).sourceLabel) ||
        (source === 'verified_db' ? 'Verified database' : catalogProviderLabel(source)),
    };
    trace('cloud', 'own_db.hit', `Verified/Worker hit: ${hit.musical_key} ${hit.mode} from ${hit.sourceLabel}`, {
      source: hit.source,
      verified: hit.verified,
      musical_key: hit.musical_key,
      mode: hit.mode,
      elapsedMs: Date.now() - started,
    }, 'ok');
    return { found: true, song: hit };
  } catch (error) {
    if (signal?.aborted) {
      trace('cloud', 'own_db.aborted', 'Verified DB lookup cancelled', { why: 'caller_aborted' }, 'skip');
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    trace('cloud', 'own_db.transport', `Worker fetch failed (${message}) — falling through to client catalogs`, {
      why: 'fetch_threw',
      error: message,
    }, 'fail');
    return 'network_error';
  }
}

function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Verified rows come straight out of the database, so the key may be hand-entered as "Bb",
 * "F# minor" or a Spotify-style pitch class. Returns the key spelled the way it is written —
 * flats stay flat — or null when the stored value cannot be read as a key at all.
 */
export function normalizeLookupKey(song: Pick<LookupSongHit, 'musical_key' | 'mode'>): ParsedKey | null {
  return parseSpotifyStyleKey(song.musical_key, song.mode);
}

export async function lookupSongKey(input: LookupSongInput, signal?: AbortSignal): Promise<LookupSongResult> {
  const title = input.title.trim();
  const artist = input.artist.trim();
  if (!title || !artist) {
    trace('cloud', 'lookup.skip', 'Empty title or artist — no request will be sent', {
      title,
      artist,
      why: 'empty_metadata',
    }, 'skip');
    return { found: false, song: null, catalogsTried: true };
  }

  trace('cloud', 'lookup.start', `Resolving key for "${title}" — ${artist}`, {
    title,
    artist,
    apiBase: currentApiBase(),
  }, 'start');

  const own = await lookupOwnDatabase({ title, artist }, signal);
  if (own !== 'network_error') {
    if (own.found) {
      return own;
    }
    if (own.catalogsTried) {
      trace('cloud', 'lookup.done', 'Worker already finished the catalog walk — not repeating it on the client', {
        why: 'worker_catalogs_tried',
      }, 'skip');
      return own;
    }
    trace('cloud', 'lookup.fallback', 'Verified DB miss and Worker skipped catalogs — walking client catalogs', {
      why: 'worker_db_miss_no_catalogs',
    }, 'decide');
  } else {
    trace('cloud', 'lookup.fallback', 'Worker unreachable — walking client catalogs', {
      why: 'worker_network_error',
    }, 'decide');
  }

  const catalog = await lookupKeyFromCatalogs(title, artist, {
    signal,
    freqblogApiKey: getFreqblogApiKeyForDev(),
    getsongbpmApiKey: getGetSongBpmApiKeyForDev(),
    onTrace: (event, message, detail) => {
      const level =
        event.endsWith('.fail') || event === 'http.exhausted' || event === 'http.transport'
          ? 'fail'
          : event.endsWith('.hit') || event === 'http.ok'
            ? 'ok'
            : event.endsWith('.skip') || event.endsWith('.miss') || event === 'http.retry'
              ? 'skip'
              : event === 'chain.start' || event === 'provider.start' || event === 'http.send'
                ? 'start'
                : 'info';
      trace('catalog', event, message, detail, level);
    },
  });
  if (catalog.hit) {
    return { found: true, song: hitFromCatalog(title, artist, catalog.hit) };
  }
  trace('cloud', 'lookup.done', catalog.incomplete
    ? 'Client catalogs never answered — caller must not cache this as a miss'
    : 'Client catalogs answered and none had a key', {
    incomplete: catalog.incomplete,
    why: catalog.incomplete ? 'incomplete' : 'complete_miss',
  }, catalog.incomplete ? 'fail' : 'skip');
  return { found: false, song: null, catalogsTried: true, incomplete: catalog.incomplete };
}

export async function submitSongKeySuggestion(input: SuggestionInput): Promise<void> {
  const payload = {
    title: input.title.trim(),
    artist: input.artist.trim(),
    // Same trap as the lookup path: `.toUpperCase()` alone turns "Bb" into "BB".
    key: parseSpotifyStyleKey(input.key, input.mode)?.key ?? input.key.trim(),
    mode: input.mode,
    user: input.user?.trim() || 'anonymous',
  };
  trace('cloud', 'suggest.send', `Submitting ${payload.key} ${payload.mode} for "${payload.title}"`, {
    title: payload.title,
    artist: payload.artist,
    key: payload.key,
    mode: payload.mode,
  }, 'start');
  const res = await fetchWithDeadline(`${currentApiBase()}/submit-suggestion`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    trace('cloud', 'suggest.fail', `submit-suggestion failed: HTTP ${res.status}`, {
      status: res.status,
      why: 'http_not_ok',
    }, 'fail');
    throw new Error(`submit-suggestion failed: HTTP ${res.status}`);
  }
  trace('cloud', 'suggest.ok', 'Suggestion accepted by the Worker', undefined, 'ok');
}
