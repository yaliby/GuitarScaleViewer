import type { MediaSessionUiState } from '../hooks/useMediaSession';
import { buildMatchKeys, foldName } from './nameNormalize';

function normalizePart(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const collapsed = value.trim().replace(/\s+/g, ' ');
  if (!collapsed) {
    return null;
  }
  return collapsed.toLowerCase();
}

/** Keeps a folded key, or falls back to the plain form when folding leaves nothing. */
function keyPart(value: string | null | undefined, cleaned: string): string | null {
  if (!value?.trim()) {
    return null;
  }
  return foldName(cleaned) || normalizePart(value);
}

export type NormalizedTrack = {
  sourceApp: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  durationSec: number | null;
};

/**
 * Title and artist go through the shared match keys, not a plain lowercase: the same track
 * re-announced as "Linkin Park - Numb (Official Video)" must land on the cache entry already
 * fetched for "Numb" instead of triggering a second lookup round.
 */
export function normalizeTrack(media: MediaSessionUiState): NormalizedTrack {
  const keys = buildMatchKeys(media.title ?? '', media.artist ?? '');
  return {
    sourceApp: normalizePart(media.sourceApp),
    title: keyPart(media.title, keys.cleanTitle),
    artist: keyPart(media.artist, keys.cleanArtist),
    album: normalizePart(media.album),
    durationSec: media.durationMs ? Math.floor(media.durationMs / 1000) : null,
  };
}

export function buildTrackIdentity(media: MediaSessionUiState): string | null {
  const n = normalizeTrack(media);
  if (!n.sourceApp && !n.title && !n.artist && !n.album) {
    return null;
  }
  return `src=${n.sourceApp ?? ''}|title=${n.title ?? ''}|artist=${n.artist ?? ''}|album=${n.album ?? ''}|dur=${n.durationSec ?? 0}`;
}


/**
 * Everything the cloud-lookup effect actually depends on, reduced to primitives.
 *
 * The media session payload carries `positionMs`, which the backend poller refreshes every
 * 1.5s while a track plays. Depending on the payload object itself restarts the lookup on
 * every tick, so the effect must depend on these values instead.
 */
export type LookupInputs = {
  trackIdentity: string | null;
  title: string;
  artist: string;
  hasSession: boolean;
  playing: boolean;
  paused: boolean;
};

const PAUSED_STATUSES = ['paused', 'stopped', 'closed', 'opened', 'changing'];

export function buildLookupInputs(media: MediaSessionUiState): LookupInputs {
  const status = media.playbackStatus;
  return {
    trackIdentity: buildTrackIdentity(media),
    title: media.title?.trim() ?? '',
    artist: media.artist?.trim() ?? '',
    hasSession: status !== 'none' && status !== 'closed' && status !== 'media_session_unavailable',
    playing: status === 'playing',
    paused: PAUSED_STATUSES.includes(status),
  };
}
