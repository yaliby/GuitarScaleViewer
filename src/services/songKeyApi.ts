const DEFAULT_API_BASE = 'https://chordsync-api.yali-chordsync.workers.dev';
const API_BASE_OVERRIDE_KEY = 'gsv_api_base_override';
const REQUEST_TIMEOUT_MS = 8_000;

function currentApiBase(): string {
  if (typeof window === 'undefined') {
    return DEFAULT_API_BASE;
  }
  const override = window.localStorage.getItem(API_BASE_OVERRIDE_KEY)?.trim();
  return override || DEFAULT_API_BASE;
}

export function getSongKeyApiBaseForDev(): string {
  return currentApiBase();
}

export function setSongKeyApiBaseForDev(nextBase: string | null): void {
  if (typeof window === 'undefined') {
    return;
  }
  const trimmed = (nextBase ?? '').trim();
  if (!trimmed) {
    window.localStorage.removeItem(API_BASE_OVERRIDE_KEY);
  } else {
    window.localStorage.setItem(API_BASE_OVERRIDE_KEY, trimmed);
  }
}

export type LookupSongInput = {
  title: string;
  artist: string;
};

export type LookupSongHit = {
  id: string;
  title: string;
  artist: string;
  musical_key: string;
  mode: 'major' | 'minor';
  verified: boolean;
};

export type LookupSongResult =
  | { found: true; song: LookupSongHit }
  | { found: false; song: null };

export type SuggestionInput = {
  title: string;
  artist: string;
  key: string;
  mode: 'major' | 'minor';
  user?: string;
};

function assertString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`Invalid ${field} in API response`);
  }
  return value;
}

export function normalizeMusicalKey(value: string): string {
  const match = value.trim().replaceAll('♭', 'b').replaceAll('♯', '#').match(/^([A-Ga-g])([#b]?)$/);
  if (!match) {
    throw new Error('Invalid musical key');
  }
  return `${match[1]!.toUpperCase()}${match[2] ?? ''}`;
}

function normalizeMode(value: unknown): 'major' | 'minor' {
  if (typeof value !== 'string') {
    throw new Error('Invalid song.mode in API response');
  }
  const mode = value.trim().toLowerCase();
  if (mode !== 'major' && mode !== 'minor') {
    throw new Error('Invalid song.mode in API response');
  }
  return mode;
}

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

export async function lookupSongKey(input: LookupSongInput, signal?: AbortSignal): Promise<LookupSongResult> {
  const title = input.title.trim();
  const artist = input.artist.trim();
  if (!title || !artist) {
    return { found: false, song: null };
  }
  const url = new URL('/lookup-song', currentApiBase());
  url.searchParams.set('title', title);
  url.searchParams.set('artist', artist);

  const res = await fetchWithDeadline(url.toString(), { method: 'GET', signal });
  if (!res.ok) {
    throw new Error(`lookup-song failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as unknown;
  if (!data || typeof data !== 'object') {
    throw new Error('lookup-song malformed response');
  }
  const found = (data as { found?: unknown }).found;
  if (found === false) {
    if ((data as { song?: unknown }).song !== null) {
      throw new Error('lookup-song malformed miss response');
    }
    return { found: false, song: null };
  }
  if (found !== true) {
    throw new Error('lookup-song response missing found boolean');
  }
  const song = (data as { song?: unknown }).song;
  if (!song || typeof song !== 'object') {
    throw new Error('lookup-song response missing song payload');
  }
  const hit: LookupSongHit = {
    id: assertString((song as { id?: unknown }).id, 'song.id', 128),
    title: assertString((song as { title?: unknown }).title, 'song.title', 300),
    artist: assertString((song as { artist?: unknown }).artist, 'song.artist', 200),
    musical_key: normalizeMusicalKey(
      assertString((song as { musical_key?: unknown }).musical_key, 'song.musical_key', 3),
    ),
    mode: normalizeMode((song as { mode?: unknown }).mode),
    verified: (song as { verified?: unknown }).verified === true,
  };
  if (!hit.verified) {
    throw new Error('Cloud song record is not verified');
  }
  return { found: true, song: hit };
}

export async function submitSongKeySuggestion(input: SuggestionInput): Promise<void> {
  const payload = {
    title: input.title.trim(),
    artist: input.artist.trim(),
    key: normalizeMusicalKey(input.key),
    mode: input.mode,
    user: input.user?.trim() || 'anonymous',
  };
  const res = await fetchWithDeadline(`${currentApiBase()}/submit-suggestion`, {
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

