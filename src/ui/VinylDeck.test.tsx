import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { VinylDeck, type VinylDeckProps } from './VinylDeck';
import { platterRotationDeg, VINYL_MS_PER_REVOLUTION } from './vinylMath';

afterEach(cleanup);

const STAGE = { left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, x: 0, y: 0, toJSON: () => {} };

function renderDeck(
  over: Partial<VinylDeckProps> = {},
): ReturnType<typeof render> & {
  onPause: ReturnType<typeof vi.fn>;
  onPlay: ReturnType<typeof vi.fn>;
  onSeek: ReturnType<typeof vi.fn>;
  onCue: ReturnType<typeof vi.fn>;
  rerenderDeck: (next?: Partial<VinylDeckProps>) => void;
} {
  const onPause = vi.fn();
  const onPlay = vi.fn();
  const onSeek = vi.fn();
  const onCue = vi.fn();
  const props: VinylDeckProps = {
    playing: true,
    playbackStatus: 'playing',
    positionMs: 12_000,
    durationMs: 180_000,
    interactive: true,
    onPause,
    onPlay,
    onSeek,
    onCue,
    ...over,
  };
  const view = render(<VinylDeck {...props} />);
  const mockStage = () => {
    const stage = view.container.querySelector('.lab-vinyl-stage') as HTMLElement | null;
    if (stage) {
      vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue(STAGE as DOMRect);
    }
  };
  mockStage();
  const rerenderDeck = (next: Partial<VinylDeckProps> = {}) => {
    view.rerender(<VinylDeck {...props} {...next} />);
    mockStage();
  };
  return { ...view, onPause, onPlay, onSeek, onCue, rerenderDeck };
}

describe('VinylDeck', () => {
  it('reveals pause on hover and sends it when clicked', () => {
    const { onPause } = renderDeck();
    const stage = screen.getByRole('slider', { name: 'Song position' });
    fireEvent.pointerEnter(stage);
    fireEvent.click(screen.getByRole('button', { name: 'Pause current track' }));
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it('shows play instead of pause when the track is already paused', () => {
    const { onPlay } = renderDeck({ playing: false, playbackStatus: 'paused' });
    fireEvent.click(screen.getByRole('button', { name: 'Play current track' }));
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  it('treats a click on the platter as pause instead of a tiny cue', () => {
    const { onPause, onSeek } = renderDeck();
    const stage = screen.getByRole('slider', { name: 'Song position' });
    fireEvent.pointerDown(stage, { pointerId: 1, button: 0, clientX: 200, clientY: 100 });
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 200, clientY: 100 });
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(onSeek).not.toHaveBeenCalled();
  });

  it('treats a counterclockwise quarter-turn as a rewind', () => {
    const { onSeek } = renderDeck();
    const stage = screen.getByRole('slider', { name: 'Song position' });
    fireEvent.pointerDown(stage, { pointerId: 1, button: 0, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 100, clientY: 0 });
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 100, clientY: 0 });
    const last = onSeek.mock.calls.at(-1)?.[0] as number;
    expect(last).toBeCloseTo(12_000 - VINYL_MS_PER_REVOLUTION / 4, 0);
  });

  it('cues forward when the record is dragged clockwise', () => {
    const { onPause, onSeek, onCue } = renderDeck();
    const stage = screen.getByRole('slider', { name: 'Song position' });
    fireEvent.pointerDown(stage, { pointerId: 1, button: 0, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 100, clientY: 200 });
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 100, clientY: 200 });
    expect(onSeek).toHaveBeenCalled();
    const last = onSeek.mock.calls.at(-1)?.[0] as number;
    expect(last).toBeCloseTo(12_000 + VINYL_MS_PER_REVOLUTION / 4, 0);
    expect(onCue).toHaveBeenCalled();
    const lastCue = onCue.mock.calls.at(-1)?.[0] as number;
    expect(lastCue).toBeCloseTo(12_000 + VINYL_MS_PER_REVOLUTION / 4, 0);
    expect(onPause).not.toHaveBeenCalled();
  });

  it('stays decorative when there is no OS session to control', () => {
    renderDeck({ interactive: false, playing: false, playbackStatus: 'none' });
    expect(screen.queryByRole('button', { name: /current track/i })).toBeNull();
    expect(screen.queryByRole('slider', { name: 'Song position' })).toBeNull();
  });

  it('keeps the grooves at the cued angle instead of snapping back', () => {
    const { container } = renderDeck({ playing: false, playbackStatus: 'paused' });
    const stage = screen.getByRole('slider', { name: 'Song position' });
    fireEvent.pointerDown(stage, { pointerId: 1, button: 0, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 100, clientY: 200 });
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 100, clientY: 200 });
    const platter = container.querySelector('.lab-vinyl-platter') as HTMLElement;
    expect(platterRotationDeg(platter.style.transform)).toBeCloseTo(90, 0);
  });

  it('flips to play immediately even if the OS session is still playing', () => {
    const { container, onPause, rerenderDeck } = renderDeck();
    fireEvent.click(screen.getByRole('button', { name: 'Pause current track' }));
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Play current track' })).toBeTruthy();
    expect(container.querySelector('.lab-record')?.classList.contains('spinning')).toBe(false);
    rerenderDeck({ playing: true, playbackStatus: 'playing' });
    expect(screen.getByRole('button', { name: 'Play current track' })).toBeTruthy();
    expect(container.querySelector('.lab-record')?.classList.contains('spinning')).toBe(false);
  });

  it('starts spinning immediately when play is pressed', () => {
    const { container, onPlay } = renderDeck({ playing: false, playbackStatus: 'paused' });
    fireEvent.click(screen.getByRole('button', { name: 'Play current track' }));
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Pause current track' })).toBeTruthy();
    expect(container.querySelector('.lab-record')?.classList.contains('spinning')).toBe(true);
  });
});
