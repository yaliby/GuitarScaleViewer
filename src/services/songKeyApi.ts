const DEFAULT_API_BASE = 'https://chordsync-api.yali-chordsync.workers.dev';
const API_BASE_OVERRIDE_KEY = 'gsv_api_base_override';

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
  mode: string;
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

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${field} in API response`);
  }
  return value;
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

  const res = await fetch(url.toString(), { method: 'GET', signal });
  if (!res.ok) {
    throw new Error(`lookup-song failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as unknown;
  if (!data || typeof data !== 'object') {
    throw new Error('lookup-song malformed response');
  }
  const found = (data as { found?: unknown }).found;
  if (found === false) {
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
    id: assertString((song as { id?: unknown }).id, 'song.id'),
    title: assertString((song as { title?: unknown }).title, 'song.title'),
    artist: assertString((song as { artist?: unknown }).artist, 'song.artist'),
    musical_key: assertString((song as { musical_key?: unknown }).musical_key, 'song.musical_key'),
    mode: assertString((song as { mode?: unknown }).mode, 'song.mode'),
    verified: Boolean((song as { verified?: unknown }).verified),
  };
  return { found: true, song: hit };
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

