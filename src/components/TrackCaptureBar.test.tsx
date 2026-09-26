import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TrackCaptureBar } from './TrackCaptureBar';
import { resetChordJobsForTests, setChordJob } from '../harmonia/chordJobs';
import type { TrackCaptureApi } from '../hooks/useTrackCapture';
import { asCapturedTrack, engineLabel, listTrackCaptures } from '../services/trackCapture';

afterEach(() => {
  cleanup();
  resetChordJobsForTests();
});

function api(over: Partial<TrackCaptureApi> = {}): TrackCaptureApi {
  return {
    status: 'idle',
    progressPct: null,
    stage: null,
    track: null,
    error: null,
    query: '',
    autoEnabled: true,
    playing: false,
    setQuery: vi.fn(),
    setAutoEnabled: vi.fn(),
    captureNow: vi.fn(),
    captureQuery: vi.fn(),
    togglePlayback: vi.fn(),
    ...over,
  };
}

describe('track capture helpers', () => {
  it('labels the two engines the UI actually ships', () => {
    expect(engineLabel('youtube_direct')).toBe('YouTube');
    expect(engineLabel('youtube_search')).toBe('YouTube match');
  });

  it('builds a sidecar audio URL from a cache id', () => {
    const track = asCapturedTrack({
      id: 'yt-dQw4w9WgXcQ',
      path: '/tmp/yt-dQw4w9WgXcQ.mp3',
      title: 'Never Gonna Give You Up',
      artist: 'Rick Astley',
      engine: 'youtube_direct',
      bytes: 12,
      cached: true,
    });
    expect(track?.audioUrl).toContain('id=yt-dQw4w9WgXcQ');
    expect(track?.title).toBe('Never Gonna Give You Up');
  });

  it('lists captured tracks from the sidecar catalog', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          status: 'ok',
          tracks: [
            {
              id: 'yt-abc',
              path: '/tmp/yt-abc.m4a',
              title: 'Fast Car',
              artist: 'Tracy Chapman',
              engine: 'youtube_search',
              bytes: 8,
              cached: true,
            },
          ],
        }),
      })),
    );
    const listed = await listTrackCaptures();
    expect(listed.tracks?.[0]?.title).toBe('Fast Car');
    vi.unstubAllGlobals();
  });
});

describe('TrackCaptureBar', () => {
  it('saves a pasted link and the song that is playing', () => {
    const capture = api({ query: 'https://youtu.be/dQw4w9WgXcQ' });
    render(<TrackCaptureBar capture={capture} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(capture.captureQuery).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'This song' }));
    expect(capture.captureNow).toHaveBeenCalled();
  });

  it('plays a captured file and shows which engine saved it', () => {
    const capture = api({
      status: 'ready',
      track: asCapturedTrack({
        id: 'meta-1',
        path: '/tmp/meta-1.mp3',
        title: 'Numb',
        artist: 'Linkin Park',
        engine: 'youtube_search',
        bytes: 99,
        cached: true,
      }),
    });
    render(<TrackCaptureBar capture={capture} />);
    expect(screen.getByTestId('track-capture-status').textContent).toMatch(/Saved/i);
    expect(screen.getByTestId('track-capture-status').textContent).toMatch(/YouTube match/i);
    fireEvent.click(screen.getByRole('button', { name: 'Play captured audio' }));
    expect(capture.togglePlayback).toHaveBeenCalled();
  });

  it('makes a background download obvious: stage, percent, and a live meter', () => {
    const capture = api({
      status: 'capturing',
      progressPct: 47,
      stage: 'download',
    });
    render(<TrackCaptureBar capture={capture} />);
    const face = screen.getByTestId('track-capture-status');
    expect(face.textContent).toMatch(/Downloading/i);
    expect(face.textContent).toMatch(/in the background/i);
    expect(face.textContent).toMatch(/47%/);
    const meter = screen.getByRole('progressbar', { name: 'Capture progress' });
    expect(meter).toHaveAttribute('aria-valuenow', '47');
  });

  it('says when a saved song is having its chords read', () => {
    setChordJob('meta-1', { stage: 'Recognizing harmony', progress: 0.2 });
    const capture = api({
      status: 'ready',
      track: asCapturedTrack({
        id: 'meta-1',
        path: '/tmp/meta-1.mp3',
        title: 'Numb',
        artist: 'Linkin Park',
        engine: 'youtube_search',
        bytes: 99,
        cached: false,
      }),
    });
    render(<TrackCaptureBar capture={capture} />);
    expect(screen.getByTestId('track-capture-status').textContent).toMatch(
      /Reading chords in the background/i,
    );
  });
});
