import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';

export type CaptureEngine =
  | 'youtube_direct'
  | 'youtube_search'
  | 'local_file'
  | 'direct_url';

export type CaptureStatus = 'idle' | 'capturing' | 'ready' | 'miss' | 'error';

export type CapturedTrack = {
  id: string;
  path: string;
  audioUrl: string;
  title: string;
  artist: string | null;
  album: string | null;
  engine: CaptureEngine;
  webpageUrl: string | null;
  durationMs: number | null;
  artworkPath: string | null;
  artworkUrl: string | null;
  bytes: number;
  cached: boolean;
  sourceApp: string | null;
  capturedAt: string;
};

export type CaptureQuery = {
  query?: string | null;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  sourceApp?: string | null;
  trackUrl?: string | null;
  force?: boolean;
};

export type CaptureResponse = {
  status: CaptureStatus | string;
  track: CapturedTrack | null;
  tracks?: CapturedTrack[];
  reason?: string | null;
  message?: string | null;
  engine?: string;
  progress?: number;
  stage?: string;
};

type WireTrack = {
  id?: unknown;
  path?: unknown;
  title?: unknown;
  artist?: unknown;
  album?: unknown;
  engine?: unknown;
  webpageUrl?: unknown;
  durationMs?: unknown;
  artworkPath?: unknown;
  bytes?: unknown;
  cached?: unknown;
  sourceApp?: unknown;
  capturedAt?: unknown;
};

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function localMediaUrl(path: string | null, id: string, kind: 'audio' | 'artwork'): string | null {
  if (isTauri() && path) {
    try {
      return convertFileSrc(path);
    } catch {
      /* packaged webview without the asset protocol — fall through to the sidecar */
    }
  }
  if (!id) return path;
  return `/chordsync/${kind}?id=${encodeURIComponent(id)}`;
}

function asEngine(value: unknown): CaptureEngine {
  if (
    value === 'youtube_direct' ||
    value === 'youtube_search' ||
    value === 'local_file' ||
    value === 'direct_url'
  ) {
    return value;
  }
  return 'youtube_search';
}

export function asCapturedTrack(value: unknown): CapturedTrack | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as WireTrack;
  const id = asString(row.id);
  const path = asString(row.path);
  if (!id || !path) return null;
  const artworkPath = asString(row.artworkPath);
  return {
    id,
    path,
    audioUrl: localMediaUrl(path, id, 'audio') ?? path,
    title: asString(row.title) ?? 'Untitled',
    artist: asString(row.artist),
    album: asString(row.album),
    engine: asEngine(row.engine),
    webpageUrl: asString(row.webpageUrl),
    durationMs: asNumber(row.durationMs),
    artworkPath,
    artworkUrl: artworkPath ? localMediaUrl(artworkPath, id, 'artwork') : null,
    bytes: asNumber(row.bytes) ?? 0,
    cached: row.cached === true,
    sourceApp: asString(row.sourceApp),
    capturedAt: asString(row.capturedAt) ?? '',
  };
}

function asResponse(value: unknown): CaptureResponse {
  if (!value || typeof value !== 'object') {
    return { status: 'error', track: null, reason: 'bad_response' };
  }
  const row = value as {
    status?: unknown;
    track?: unknown;
    tracks?: unknown;
    reason?: unknown;
    message?: unknown;
    engine?: unknown;
  };
  const tracks = Array.isArray(row.tracks)
    ? row.tracks.map(asCapturedTrack).filter((item): item is CapturedTrack => item !== null)
    : undefined;
  return {
    status: typeof row.status === 'string' ? row.status : 'error',
    track: asCapturedTrack(row.track),
    tracks,
    reason: asString(row.reason),
    message: asString(row.message),
    engine: asString(row.engine) ?? undefined,
  };
}

async function postChordsync(path: string, body: object): Promise<unknown | null> {
  const response = await fetch(`/chordsync/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) return null;
  return response.json();
}

function invokeArgs(query: CaptureQuery): Record<string, unknown> {
  return {
    query: query.query ?? null,
    title: query.title ?? null,
    artist: query.artist ?? null,
    album: query.album ?? null,
    sourceApp: query.sourceApp ?? null,
    trackUrl: query.trackUrl ?? null,
    force: query.force ?? false,
  };
}

export async function lookupTrackCapture(query: CaptureQuery): Promise<CaptureResponse> {
  try {
    const fromHttp = asResponse(await postChordsync('lookup', { op: 'lookup', ...query }));
    if (fromHttp.status === 'ready' || fromHttp.status === 'miss') return fromHttp;
  } catch {
    /* sidecar not listening */
  }
  if (!isTauri()) {
    return { status: 'miss', track: null };
  }
  try {
    return asResponse(await invoke('lookup_track_capture', invokeArgs(query)));
  } catch (error) {
    return {
      status: 'error',
      track: null,
      reason: 'lookup_failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function listTrackCaptures(): Promise<CaptureResponse> {
  try {
    const response = await fetch('/chordsync/captures');
    if (response.ok) {
      const listed = asResponse(await response.json());
      if (listed.tracks) return listed;
    }
  } catch {
    /* sidecar not listening */
  }
  if (!isTauri()) {
    return { status: 'ok', track: null, tracks: [] };
  }
  try {
    return asResponse(await invoke('list_track_captures'));
  } catch (error) {
    return {
      status: 'error',
      track: null,
      reason: 'list_failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function loadCapturedFile(track: CapturedTrack): Promise<File> {
  const urls = [track.audioUrl, `/chordsync/audio?id=${encodeURIComponent(track.id)}`].filter(
    (url, index, list) => url && list.indexOf(url) === index,
  );
  let lastError: unknown;
  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const blob = await response.blob();
      if (blob.size < 16) continue;
      const ext = track.path.split('.').pop()?.replace(/[^a-z0-9]/gi, '') || 'm4a';
      const base = [track.artist, track.title].filter(Boolean).join(' - ') || track.title;
      const safeName = base.replace(/[<>:"/\\|?*]/g, ' ').trim() || track.id;
      return new File([blob], `${safeName}.${ext}`, {
        type: blob.type || 'audio/mpeg',
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    lastError instanceof Error ? lastError.message : 'Could not read the saved song.',
  );
}

export async function captureTrack(query: CaptureQuery): Promise<CaptureResponse> {
  try {
    const fromHttp = asResponse(await postChordsync('capture', { op: 'capture', ...query }));
    if (fromHttp.status === 'ready' || fromHttp.status === 'error') return fromHttp;
  } catch {
    /* fall through to Tauri */
  }
  if (!isTauri()) {
    return {
      status: 'error',
      track: null,
      reason: 'sidecar_unavailable',
      message: 'The capture sidecar is not running.',
    };
  }
  try {
    return asResponse(await invoke('capture_track', invokeArgs(query)));
  } catch (error) {
    return {
      status: 'error',
      track: null,
      reason: 'capture_failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function engineLabel(engine: CaptureEngine | string | null | undefined): string {
  switch (engine) {
    case 'youtube_direct':
      return 'YouTube';
    case 'youtube_search':
      return 'YouTube match';
    case 'local_file':
      return 'Local file';
    case 'direct_url':
      return 'Direct stream';
    default:
      return 'Capture';
  }
}
