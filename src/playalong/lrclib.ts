import { cleanArtistName, cleanTrackTitle } from '../services/nameNormalize';
import { parseLrc } from './lrc';
import type { PlayAlongLyrics, PlayAlongPayload } from './types';

const LRCLIB = 'https://lrclib.net';

type LrcRow = {
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
};

function lyricsFromRow(row: LrcRow): PlayAlongLyrics {
  const synced = parseLrc(row.syncedLyrics || '');
  return {
    provider: 'lrclib',
    title: row.trackName ?? null,
    artist: row.artistName ?? null,
    plain: row.plainLyrics ?? null,
    synced,
    confidence: synced.length ? 0.9 : 0.7,
  };
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`LRCLIB ${response.status}`);
  }
  return response.json();
}

/**
 * Same lookup ChordSync uses: exact get, then search. Works in the browser
 * because lrclib.net sends Access-Control-Allow-Origin: *.
 */
export async function resolveLrclib(title: string, artist: string): Promise<PlayAlongPayload> {
  const track = cleanTrackTitle(title) || title.trim();
  const who = cleanArtistName(artist) || artist.trim();
  if (!track) {
    return { status: 'none', reason: 'no_title', track: null, lyrics: null, chart: null };
  }

  const exactParams = new URLSearchParams({ track_name: track });
  if (who) exactParams.set('artist_name', who);
  const exact = (await getJson(`${LRCLIB}/api/get?${exactParams}`)) as LrcRow | null;
  if (exact && (exact.syncedLyrics || exact.plainLyrics)) {
    const lyrics = lyricsFromRow(exact);
    return {
      status: lyrics.synced.length ? 'lyrics' : 'plain',
      reason: 'lrclib_exact',
      track: { title: exact.trackName || track, artist: exact.artistName || who || null, album: exact.albumName ?? null },
      lyrics,
      chart: null,
    };
  }

  const q = [who, track].filter(Boolean).join(' ');
  const rows = ((await getJson(`${LRCLIB}/api/search?${new URLSearchParams({ q })}`)) as LrcRow[] | null) ?? [];
  const synced = rows.find((row) => row.syncedLyrics);
  const row = synced ?? rows.find((item) => item.plainLyrics);
  if (!row) {
    return {
      status: 'none',
      reason: 'lrclib_miss',
      track: { title: track, artist: who || null, album: null },
      lyrics: null,
      chart: null,
    };
  }
  const lyrics = lyricsFromRow(row);
  return {
    status: lyrics.synced.length ? 'lyrics' : 'plain',
    reason: 'lrclib_search',
    track: { title: row.trackName || track, artist: row.artistName || who || null, album: row.albumName ?? null },
    lyrics,
    chart: null,
  };
}
