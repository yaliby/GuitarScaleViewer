import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { clearTraceBuffer, trace } from '../services/debugLog';
import { DevDrawer, type DevDrawerProps } from './DevDrawer';

afterEach(() => {
  cleanup();
  clearTraceBuffer();
});

const props: DevDrawerProps = {
  open: true,
  onClose: vi.fn(),
  mediaSession: {
    title: 'Numb',
    artist: 'Linkin Park',
    album: null,
    sourceApp: 'spotify',
    playbackStatus: 'playing',
    positionMs: 0,
    durationMs: 180_000,
  },
  detected: {
    primaryKey: 'A',
    primaryScale: 'minor',
    displayName: 'A minor',
    confidence: 0.7,
    stability: 0.8,
    alternatives: [],
    source: 'audio_analysis',
    captureMode: 'process_loopback',
    targetApp: 'spotify',
    enoughAudio: true,
    bufferSeconds: 12,
    windowCount: 4,
    ambiguous: false,
    reason: null,
    state: 'likely_key',
    readyToApply: true,
  },
  detectedKeyAb: null,
  cloudResolution: {
    cloudState: 'hit',
    cloudError: null,
    cloudHit: { verified: true, sourceLabel: 'Verified library', source: 'verified_library' },
    resolutionState: 'cloud_hit',
    sourceBadge: 'Verified library key',
    trackIdentity: 'numb',
  },
  activeDisplayName: 'A minor',
  fused: {
    root: 'A',
    scale: 'minor',
    displayName: 'A minor',
    source: 'verified',
    certainty: 'verified',
    confidencePct: 100,
    notesSettled: true,
    tonicSettled: true,
    relativeAlternative: null,
    trackIdentity: 'numb',
    why: 'human_entered',
  },
  locked: false,
  devMockEnabled: false,
  onDevMockEnabledChange: vi.fn(),
  devMockTitle: '',
  onDevMockTitleChange: vi.fn(),
  devMockArtist: '',
  onDevMockArtistChange: vi.fn(),
};

describe('Engineering pipeline log reader', () => {
  it('opens a full reader from the Read log button and shows payloads', () => {
    trace(
      'cloud',
      'lookup.hit',
      'Lookup hit: A minor from Verified library',
      { key: 'A', mode: 'minor', source: 'verified_library' },
      'ok',
    );
    render(<DevDrawer {...props} />);

    fireEvent.click(screen.getByRole('button', { name: 'Read log' }));

    expect(screen.getByRole('dialog', { name: 'Pipeline log' })).toBeTruthy();
    expect(screen.getByText('Lookup hit: A minor from Verified library')).toBeTruthy();
    expect(screen.getByText(/"source": "verified_library"/)).toBeTruthy();
  });

  it('returns to the engineering panel from Back', () => {
    render(<DevDrawer {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Read log' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('dialog', { name: 'Engineering panel' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Read log' })).toBeTruthy();
  });
});
