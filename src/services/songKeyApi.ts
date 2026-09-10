import {
  catalogProviderLabel,
  lookupKeyFromCatalogs,
  type CatalogProvider,
} from './catalogKeyLookup';

const DEFAULT_API_BASE = 'https://chordsync-api.yali-chordsync.workers.dev';
const API_BASE_OVERRIDE_KEY = 'gsv_api_base_override';
const FREQBLOG_KEY_STORAGE = 'gsv_freqblog_api_key';
const GETSONGBPM_KEY_STORAGE = 'gsv_getsongbpm_api_key';

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
  mode: string;
  verified: boolean;
  source: KeyLookupSource;
  sourceLabel: string;
};

export type LookupSongResult =
  | { found: true; song: LookupSongHit }
  | { found: false; song: null; catalogsTried: boolean };

export type SuggestionInput = {
  title: string;
  artist: string;
  key: string;
  mode: 'major' | 'minor';
  user?: string;
};

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
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
  catalog: NonNullable<Awaited<ReturnType<typeof lookupKeyFromCatalogs>>>,
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

  try {
    const res = await fetch(url.toString(), { method: 'GET', signal });
    if (!res.ok) {
      return 'network_error';
    }
    const data = (await res.json()) as unknown;
    if (!data || typeof data !== 'object') {
      return 'network_error';
    }
    const found = (data as { found?: unknown }).found;
    const catalogsTried = Boolean((data as { catalogsTried?: unknown }).catalogsTried);
    if (found === false) {
      return { found: false, song: null, catalogsTried };
    }
    if (found !== true) {
      return 'network_error';
    }
    const song = (data as { song?: unknown }).song;
    if (!song || typeof song !== 'object') {
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
      id: assertString((song as { id?: unknown }).id, 'song.id'),
      title: assertString((song as { title?: unknown }).title, 'song.title'),
      artist: assertString((song as { artist?: unknown }).artist, 'song.artist'),
      musical_key: assertString((song as { musical_key?: unknown }).musical_key, 'song.musical_key'),
      mode: assertString((song as { mode?: unknown }).mode, 'song.mode'),
      verified: source === 'verified_db' || Boolean((song as { verified?: unknown }).verified),
      source,
      sourceLabel:
        asOptionalString((data as { sourceLabel?: unknown }).sourceLabel) ||
        (source === 'verified_db' ? 'Verified database' : catalogProviderLabel(source)),
    };
    return { found: true, song: hit };
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    return 'network_error';
  }
}

function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function lookupSongKey(input: LookupSongInput, signal?: AbortSignal): Promise<LookupSongResult> {
  const title = input.title.trim();
  const artist = input.artist.trim();
  if (!title || !artist) {
    return { found: false, song: null, catalogsTried: true };
  }

  const own = await lookupOwnDatabase({ title, artist }, signal);
  if (own !== 'network_error') {
    if (own.found) {
      return own;
    }
    if (own.catalogsTried) {
      return own;
    }
  }

  const catalog = await lookupKeyFromCatalogs(title, artist, {
    signal,
    freqblogApiKey: getFreqblogApiKeyForDev(),
    getsongbpmApiKey: getGetSongBpmApiKeyForDev(),
  });
  if (catalog) {
    return { found: true, song: hitFromCatalog(title, artist, catalog) };
  }
  return { found: false, song: null, catalogsTried: true };
}

export async function submitSongKeySuggestion(input: SuggestionInput): Promise<void> {
  const payload = {
    title: input.title.trim(),
    artist: input.artist.trim(),
    key: input.key.trim().toUpperCase(),
    mode: input.mode,
    user: input.user?.trim() || 'anonymous',
  };
  const res = await fetch(`${currentApiBase()}/submit-suggestion`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`submit-suggestion failed: HTTP ${res.status}`);
  }
}
