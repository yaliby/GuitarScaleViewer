import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SourceStrip, type SourceStripProps } from './SourceStrip';
import { METER_SEGMENTS } from './gear';
import { CERTAINTY_PCT } from '../services/keyFusion';

afterEach(cleanup);

function renderStrip(over: Partial<SourceStripProps> = {}) {
  const onApplyThresholdChange = vi.fn();
  const props: SourceStripProps = {
    mediaSession: {
      title: 'Numb',
      artist: 'Linkin Park',
      album: null,
      sourceApp: 'spotify',
      playbackStatus: 'playing',
      positionMs: 30_000,
      durationMs: 185_000,
    } as SourceStripProps['mediaSession'],
    detected: { state: 'likely_key' } as SourceStripProps['detected'],
    resolutionState: 'idle',
    keyName: 'D minor',
    certainty: 'lone',
    confidencePct: CERTAINTY_PCT.hedged,
    notesSettled: false,
    tonicSettled: true,
    relativeAlternative: null,
    applyDetected: true,
    onToggleApply: vi.fn(),
    applyThreshold: 0,
    onApplyThresholdChange,
    ...over,
  };
  const view = render(<SourceStrip {...props} />);
  return { ...view, onApplyThresholdChange };
}

/** The rectangles the gate is asking for: drawn but not yet lit by the reading. */
const owedBars = (container: HTMLElement) => container.querySelectorAll('[data-owed]').length;
const litBars = (container: HTMLElement) => container.querySelectorAll('[data-lit]').length;

const gateSlider = () => screen.getByRole('slider', { name: 'Apply confidence gate' });

describe('SourceStrip Apply gate', () => {
  it('ships open, so nothing is held back and no bars are owed', () => {
    const { container } = renderStrip();
    expect((gateSlider() as HTMLInputElement).value).toBe('0');
    expect(screen.getByText('Open — the neck takes whatever is heard')).toBeInTheDocument();
    expect(owedBars(container)).toBe(0);
  });

  it('reports the percentage the player picked back as rectangles on the meter', () => {
    const { onApplyThresholdChange } = renderStrip();
    fireEvent.change(gateSlider(), { target: { value: '70' } });
    expect(onApplyThresholdChange).toHaveBeenCalledWith(70);
  });

  it('draws the bars the gate wants but the reading has not reached', () => {
    // 35% of fourteen bars is five lit; a 70% gate wants ten, so five are owed.
    const { container } = renderStrip({ applyThreshold: 70 });
    expect(litBars(container)).toBe(5);
    expect(owedBars(container)).toBe(5);
    expect(screen.getByText(/10 of 14 bars/)).toBeInTheDocument();
  });

  it('owes nothing once the reading has climbed through the gate', () => {
    // 85% lights twelve of the fourteen, which is past the ten the gate asked for.
    const { container } = renderStrip({ applyThreshold: 70, confidencePct: CERTAINTY_PCT.loneMax });
    expect(litBars(container)).toBe(12);
    expect(owedBars(container)).toBe(0);
    expect(screen.getByText(/this reading is through/)).toBeInTheDocument();
  });

  it('says the neck is being held while the reading is short of the gate', () => {
    renderStrip({ applyThreshold: 70 });
    expect(screen.getByText(/holding: this reading is short/)).toBeInTheDocument();
  });

  it('does not claim to be holding anything while Apply itself is off', () => {
    renderStrip({ applyThreshold: 70, applyDetected: false });
    expect(screen.getByText(/Apply is off, so nothing is being taken/)).toBeInTheDocument();
  });

  it('counts every rectangle at the top of the scale', () => {
    const { container } = renderStrip({ applyThreshold: 100, confidencePct: 0 });
    expect(owedBars(container)).toBe(METER_SEGMENTS);
    expect(screen.getByText(/14 of 14 bars/)).toBeInTheDocument();
  });

  it('speaks the gate in both units, so the slider is usable without seeing the meter', () => {
    renderStrip({ applyThreshold: 70 });
    expect(gateSlider()).toHaveAttribute('aria-valuetext', '70%, 10 of 14 bars');
  });
});

describe('SourceStrip save lamp', () => {
  it('lights Save while a song is downloading in the background', () => {
    renderStrip({
      capture: {
        status: 'capturing',
        progressPct: 22,
        stage: 'download',
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
      },
    });
    expect(screen.getByRole('img', { name: 'Save: Saving in the background' })).toBeInTheDocument();
    expect(screen.getByTestId('track-capture-status').textContent).toMatch(/Downloading/i);
  });
});
