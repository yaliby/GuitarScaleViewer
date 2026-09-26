// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import type { DetectedKeyState } from './hooks/useDetectedKey';

/**
 * What the gate slider is for: the neck moves when the pipeline is as sure as the player asked
 * it to be, and not before. The engine is mocked here because the question under test is what
 * the deck does with a reading of a given confidence, not how it arrives at one.
 */
const detection = vi.hoisted(() => ({ state: null as DetectedKeyState | null }));

vi.mock('./hooks/useDetectedKey', () => ({
  useDetectedKey: () => ({
    detectedKey: detection.state,
    detectedKeyAb: null,
    resetDetection: vi.fn(),
  }),
}));

import LiveJamScreen from './LiveJamScreen';
import { DEFAULT_SESSION, type PracticeSession } from './practice/session';
import { resetNeckFollowForTests } from './neckFollow';

/** An E minor reading the engine cannot separate from its relative: `tonic_open`, priced at 70. */
const HEARD: DetectedKeyState = {
  primaryKey: 'E',
  primaryScale: 'minor',
  displayName: 'E minor',
  confidence: 0.74,
  stability: 0.8,
  alternatives: [{ key: 'G', scale: 'major', displayName: 'G major' } as never],
  source: 'audio_analysis',
  captureMode: 'process_loopback',
  targetApp: 'Spotify',
  enoughAudio: true,
  bufferSeconds: 14,
  windowCount: 4,
  ambiguous: true,
  reason: null,
  state: 'ambiguous',
  readyToApply: true,
};

function Harness({ applyThreshold }: { applyThreshold: number }) {
  const [session, setSession] = useState<PracticeSession>({
    ...DEFAULT_SESSION,
    root: 'A',
    scaleType: 'minor',
    applyThreshold,
  });
  return (
    <LiveJamScreen
      menuOpen={false}
      onToggleMenu={() => {}}
      root={session.root}
      scaleType={session.scaleType}
      tuningId={session.tuningId}
      capo={session.capo}
      applyThreshold={session.applyThreshold}
      onChange={(patch) => setSession((current) => ({ ...current, ...patch }))}
    />
  );
}

const neckKey = () => (screen.getByPlaceholderText('A') as HTMLInputElement).value;
const gateSlider = () => screen.getByRole('slider', { name: 'Apply confidence gate' });

beforeEach(() => {
  resetNeckFollowForTests();
  detection.state = HEARD;
});
afterEach(cleanup);

describe('the Apply gate', () => {
  it('takes the reading at the gate the app ships with — still zero touches for a scale', () => {
    render(<Harness applyThreshold={0} />);
    expect(neckKey()).toBe('E');
  });

  it('leaves the neck alone while the reading is under the gate', () => {
    render(<Harness applyThreshold={85} />);
    expect(neckKey()).toBe('A');
    expect(screen.getByText(/holding: this reading is short/)).toBeInTheDocument();
  });

  it('takes it the moment the player lowers the gate onto it', () => {
    render(<Harness applyThreshold={85} />);
    expect(neckKey()).toBe('A');

    fireEvent.change(gateSlider(), { target: { value: '70' } });
    expect(neckKey()).toBe('E');
  });

  it('holds a reading back at a gate one notch above it, and takes it on the nose', () => {
    render(<Harness applyThreshold={75} />);
    expect(neckKey()).toBe('A');

    fireEvent.change(gateSlider(), { target: { value: '70' } });
    expect(neckKey()).toBe('E');
  });

  it('owes an Apply re-enable until the gate lets something through', () => {
    /* The Stairway case, under a gate. The neck has taken E minor, is then hand-set to C — which
       drops Apply — and Apply comes back on while the gate is above the reading. Nothing may move
       yet. When the gate comes down, "follow the song again" is still owed: the reading is the
       same E minor the neck already logged, so the revision margin has nothing to act on and only
       the owed re-enable can get C off the board. */
    render(<Harness applyThreshold={0} />);
    expect(neckKey()).toBe('E');

    fireEvent.change(screen.getByPlaceholderText('A'), { target: { value: 'C' } });
    expect(neckKey()).toBe('C');

    fireEvent.change(gateSlider(), { target: { value: '85' } });
    fireEvent.click(screen.getByRole('button', { name: /Apply/ }));
    expect(neckKey()).toBe('C');

    fireEvent.change(gateSlider(), { target: { value: '70' } });
    expect(neckKey()).toBe('E');
  });

  it('never gates out a reading the player asked for by hand', () => {
    render(<Harness applyThreshold={100} />);
    fireEvent.change(screen.getByPlaceholderText('A'), { target: { value: 'C' } });
    expect(neckKey()).toBe('C');
  });

  it('keeps a resisted reading when live jam is left and opened again', () => {
    function Room() {
      const [open, setOpen] = useState(true);
      const [session, setSession] = useState<PracticeSession>({
        ...DEFAULT_SESSION,
        root: 'A',
        scaleType: 'minor',
        applyThreshold: 0,
      });
      return (
        <>
          <button type="button" onClick={() => setOpen((value) => !value)}>
            Leave room
          </button>
          {open ? (
            <LiveJamScreen
              menuOpen={false}
              onToggleMenu={() => {}}
              root={session.root}
              scaleType={session.scaleType}
              tuningId={session.tuningId}
              capo={session.capo}
              applyThreshold={session.applyThreshold}
              onChange={(patch) => setSession((current) => ({ ...current, ...patch }))}
            />
          ) : null}
        </>
      );
    }

    render(<Room />);
    expect(neckKey()).toBe('E');

    fireEvent.click(screen.getByRole('button', { name: 'Leave room' }));
    detection.state = {
      ...HEARD,
      primaryKey: 'G',
      primaryScale: 'major',
      displayName: 'G major',
      ambiguous: false,
      alternatives: [],
      confidence: 1,
    };
    fireEvent.click(screen.getByRole('button', { name: 'Leave room' }));

    expect(neckKey()).toBe('E');
  });
});
