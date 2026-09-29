import { describe, expect, it } from 'vitest';
import { canAutoCaptureMedia } from './useTrackCapture';
import type { MediaSessionUiState } from './useMediaSession';

const base: MediaSessionUiState = {
  title: 'Dream On',
  artist: 'Aerosmith',
  album: null,
  sourceApp: 'Chrome',
  playbackStatus: 'playing',
  positionMs: 1000,
  durationMs: 268000,
  trackUrl: null,
  artworkUrl: null,
};

describe('canAutoCaptureMedia', () => {
  it('can save an identified paused song without making lyric timing run', () => {
    expect(canAutoCaptureMedia({ ...base, playbackStatus: 'paused' })).toBe(true);
  });

  it('does not save a stopped or unidentified session', () => {
    expect(canAutoCaptureMedia({ ...base, playbackStatus: 'stopped' })).toBe(false);
    expect(canAutoCaptureMedia({ ...base, title: null, trackUrl: null })).toBe(false);
  });
});
