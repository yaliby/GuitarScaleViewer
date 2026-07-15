import type { MediaSessionUiState } from '../hooks/useMediaSession';

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

export type NormalizedTrack = {
  sourceApp: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  durationSec: number | null;
};

export function normalizeTrack(media: MediaSessionUiState): NormalizedTrack {
  return {
    sourceApp: normalizePart(media.sourceApp),
    title: normalizePart(media.title),
    artist: normalizePart(media.artist),
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

