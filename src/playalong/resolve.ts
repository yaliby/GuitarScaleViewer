import { invoke, isTauri } from '@tauri-apps/api/core';
import { resolveLrclib } from './lrclib';
import type { DevSourcePanel, PlayAlongPayload, TimedLyricLine } from './types';

export type ResolveQuery = {
  title: string;
  artist: string;
  album?: string | null;
  durationMs?: number | null;
  sourceApp?: string | null;
  gen?: number;
};

export type FollowQuery = {
  title?: string;
  artist?: string;
  album?: string | null;
  durationMs?: number | null;
  positionMs?: number | null;
  sourceApp?: string | null;
  playbackStatus?: string | null;
  playing?: boolean;
  dev?: boolean;
};

export type FollowTick = {
  status?: string;
  lyricIndex: number | null;
  chartIndex: number | null;
  positionMs?: number | null;
  adjPosMs?: number | null;
  lrcOffsetMs?: number | null;
  lrcOffsetSource?: string | null;
  singingSource?: 'lrc' | 'captions' | 'live' | 'none' | null;
  syncHint?: string | null;
  reason?: string | null;
  youtube?: DevSourcePanel | null;
  whisper?: DevSourcePanel | null;
};

function asPayload(value: unknown): PlayAlongPayload | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as PlayAlongPayload;
  if (!row.status) return null;
  return row;
}

function asTimedLines(value: unknown): TimedLyricLine[] {
  if (!Array.isArray(value)) return [];
  const out: TimedLyricLine[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const item = row as { timeMs?: unknown; text?: unknown; index?: unknown };
    const timeMs = typeof item.timeMs === 'number' ? item.timeMs : Number(item.timeMs);
    const index = typeof item.index === 'number' ? item.index : Number(item.index);
    if (!Number.isFinite(timeMs) || !Number.isFinite(index)) continue;
    out.push({
      timeMs,
      text: typeof item.text === 'string' ? item.text : '',
      index,
    });
  }
  return out;
}

function asDevPanel(value: unknown): DevSourcePanel | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as {
    status?: unknown;
    reason?: unknown;
    videoId?: unknown;
    language?: unknown;
    activeIndex?: unknown;
    lines?: unknown;
  };
  return {
    status: typeof row.status === 'string' ? row.status : 'idle',
    reason: typeof row.reason === 'string' ? row.reason : null,
    videoId: typeof row.videoId === 'string' ? row.videoId : null,
    language: typeof row.language === 'string' ? row.language : null,
    activeIndex: typeof row.activeIndex === 'number' ? row.activeIndex : null,
    lines: asTimedLines(row.lines),
  };
}

function asFollow(value: unknown): FollowTick | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as FollowTick;
  return {
    status: row.status,
    lyricIndex: typeof row.lyricIndex === 'number' ? row.lyricIndex : null,
    chartIndex: typeof row.chartIndex === 'number' ? row.chartIndex : null,
    positionMs: typeof row.positionMs === 'number' ? row.positionMs : null,
    adjPosMs: typeof row.adjPosMs === 'number' ? row.adjPosMs : null,
    lrcOffsetMs: typeof row.lrcOffsetMs === 'number' ? row.lrcOffsetMs : null,
    lrcOffsetSource: typeof row.lrcOffsetSource === 'string' ? row.lrcOffsetSource : null,
    singingSource: row.singingSource ?? null,
    syncHint: typeof row.syncHint === 'string' ? row.syncHint : null,
    reason: row.reason ?? null,
    youtube: asDevPanel(row.youtube),
    whisper: asDevPanel(row.whisper),
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

/**
 * ChordSync resolve: HTTP sidecar (live package) → Tauri invoke → LRCLIB in the browser.
 */
export async function resolvePlayalong(
  query: ResolveQuery,
  onPartial?: (payload: PlayAlongPayload) => void,
): Promise<PlayAlongPayload> {
  try {
    const fromHttp = asPayload(await postChordsync('resolve', query));
    if (fromHttp && fromHttp.status !== 'error') return fromHttp;
  } catch {
    /* sidecar not listening — try Tauri, then lyrics-only */
  }

  try {
    if (isTauri()) {
      const fromTauri = asPayload(
        await invoke('resolve_playalong', {
          title: query.title,
          artist: query.artist,
          album: query.album,
          durationMs: query.durationMs,
          sourceApp: query.sourceApp,
          gen: query.gen,
        }),
      );
      if (fromTauri && fromTauri.status !== 'error') return fromTauri;
    }
  } catch {
    /* not the desktop app, or sidecar spawn failed */
  }

  try {
    const fallback = await resolveLrclib(query.title, query.artist);
    onPartial?.(fallback);
    return fallback;
  } catch {
    return {
      status: 'error',
      reason: 'chordsync_unavailable',
      track: { title: query.title, artist: query.artist || null, album: null },
      lyrics: null,
      chart: null,
    };
  }
}

export async function followPlayalong(query: FollowQuery): Promise<FollowTick | null> {
  try {
    const fromHttp = asFollow(await postChordsync('follow', query));
    if (fromHttp) return fromHttp;
  } catch {
    /* fall through */
  }
  if (!isTauri()) return null;
  try {
    return asFollow(
      await invoke('follow_playalong', {
        title: query.title,
        artist: query.artist,
        album: query.album,
        durationMs: query.durationMs,
        positionMs: query.positionMs,
        sourceApp: query.sourceApp,
        playbackStatus: query.playbackStatus,
        playing: query.playing,
        dev: query.dev,
      }),
    );
  } catch {
    return null;
  }
}
