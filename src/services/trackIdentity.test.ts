import { describe, expect, it } from 'vitest';
import type { MediaSessionUiState } from '../hooks/useMediaSession';
import { buildLookupInputs, buildTrackIdentity, normalizeTrack } from './trackIdentity';

function media(partial: Partial<MediaSessionUiState>): MediaSessionUiState {
  return {
    status: 'ok',
    playbackStatus: 'playing',
    sourceApp: null,
    title: null,
    artist: null,
    album: null,
    durationMs: null,
    positionMs: null,
    ...partial,
  } as MediaSessionUiState;
}

describe('normalizeTrack', () => {
  it('reduces title and artist to their shared match keys', () => {
    expect(normalizeTrack(media({ title: '  Numb   (Official) ', artist: 'Linkin  Park' }))).toMatchObject({
      title: 'numb',
      artist: 'linkin park',
    });
  });

  it('gives the same identity to a track re-announced with player noise', () => {
    const plain = buildTrackIdentity(media({ title: 'Numb', artist: 'Linkin Park' }));
    const noisy = buildTrackIdentity(
      media({ title: 'Linkin Park - Numb (Official Video)', artist: 'Linkin Park - Topic' }),
    );
    expect(noisy).toBe(plain);
  });

  it('still lowercases and collapses whitespace on the remaining fields', () => {
    expect(normalizeTrack(media({ sourceApp: ' Spotify ', album: 'Meteora  Deluxe' }))).toMatchObject({
      sourceApp: 'spotify',
      album: 'meteora deluxe',
    });
  });

  it('treats blank and whitespace-only fields as absent', () => {
    expect(normalizeTrack(media({ title: '', artist: '   ' }))).toMatchObject({
      title: null,
      artist: null,
    });
  });

  it('converts duration to whole seconds', () => {
    expect(normalizeTrack(media({ durationMs: 185_400 })).durationSec).toBe(185);
    expect(normalizeTrack(media({ durationMs: null })).durationSec).toBeNull();
  });
});

describe('buildTrackIdentity', () => {
  it('returns null when no metadata field is populated', () => {
    expect(buildTrackIdentity(media({}))).toBeNull();
    expect(buildTrackIdentity(media({ durationMs: 1000 }))).toBeNull();
  });

  it('is stable across casing, padding and position changes', () => {
    const a = buildTrackIdentity(media({ title: 'Numb', artist: 'Linkin Park', positionMs: 1000 }));
    const b = buildTrackIdentity(media({ title: ' numb ', artist: 'LINKIN PARK', positionMs: 90_000 }));
    expect(a).toBe(b);
  });

  it('changes when the track changes', () => {
    const a = buildTrackIdentity(media({ title: 'Numb', artist: 'Linkin Park' }));
    const b = buildTrackIdentity(media({ title: 'Black', artist: 'Pearl Jam' }));
    expect(a).not.toBe(b);
  });

  it('distinguishes two tracks that share a title but not an artist', () => {
    const a = buildTrackIdentity(media({ title: 'Alive', artist: 'Pearl Jam' }));
    const b = buildTrackIdentity(media({ title: 'Alive', artist: 'Sia' }));
    expect(a).not.toBe(b);
  });
});

describe('buildLookupInputs', () => {
  const playing = media({ title: 'Numb', artist: 'Linkin Park', positionMs: 1_000 });

  /**
   * The backend poller re-emits the session every 1.5s with a fresh `positionMs`. If any of
   * these values changed with it, the cloud lookup effect would abort and restart itself on
   * every tick and never finish a lookup.
   */
  it('is value-identical across position ticks of the same track', () => {
    const first = buildLookupInputs(playing);
    const later = buildLookupInputs({ ...playing, positionMs: 92_500 });
    expect(later).toEqual(first);
  });

  it('reports session, playing and paused states from the playback status', () => {
    expect(buildLookupInputs(playing)).toMatchObject({ hasSession: true, playing: true, paused: false });
    expect(buildLookupInputs(media({ playbackStatus: 'paused' }))).toMatchObject({
      hasSession: true,
      playing: false,
      paused: true,
    });
    expect(buildLookupInputs(media({ playbackStatus: 'none' }))).toMatchObject({ hasSession: false });
    expect(buildLookupInputs(media({ playbackStatus: 'closed' }))).toMatchObject({ hasSession: false });
    expect(buildLookupInputs(media({ playbackStatus: 'media_session_unavailable' }))).toMatchObject({
      hasSession: false,
    });
  });

  it('trims the title and artist it hands to the lookup', () => {
    expect(buildLookupInputs(media({ title: '  Numb ', artist: ' Linkin Park  ' }))).toMatchObject({
      title: 'Numb',
      artist: 'Linkin Park',
    });
  });
});
