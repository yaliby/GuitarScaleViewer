// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import LiveJamScreen from './LiveJamScreen';
import type { PracticeSession } from './practice/session';
import { DEFAULT_SESSION } from './practice/session';
import { resetJamPanelForTests } from './jamPanel';
import { resetNeckFollowForTests } from './neckFollow';

/* The song sheet's analysis stack is Harmonia's; the sheet only needs its library here. */
vi.mock('./harmonia/composition', () => {
  const state = { library: [] };
  return {
    getHarmoniaSession: async () => ({
      subscribe: () => () => undefined,
      snapshot: () => state,
    }),
  };
});

/**
 * Smoke test for the Live Jam chassis: type-check and build both pass on a tree that throws on
 * mount, so something has to actually render it. Outside Tauri every backend hook falls back,
 * which is also what the browser dev server shows.
 */
beforeEach(() => {
  resetNeckFollowForTests();
  localStorage.clear();
  resetJamPanelForTests();
});

afterEach(() => {
  cleanup();
});

function Harness() {
  const [session, setSession] = useState<PracticeSession>(DEFAULT_SESSION);
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <LiveJamScreen
      menuOpen={menuOpen}
      onToggleMenu={() => setMenuOpen((open) => !open)}
      root={session.root}
      scaleType={session.scaleType}
      tuningId={session.tuningId}
      capo={session.capo}
      applyThreshold={session.applyThreshold}
      onChange={(patch) => setSession((current) => ({ ...current, ...patch }))}
    />
  );
}

describe('LiveJamScreen', () => {
  it('mounts with the session key and the fretboard', () => {
    render(<Harness />);

    expect(screen.getByRole('heading', { name: /Every note/i })).toBeDefined();
    expect(screen.getByRole('region', { name: /chord bank/i })).toBeDefined();
    expect(screen.getByText('No media session')).toBeDefined();
    expect(document.querySelectorAll('svg').length).toBeGreaterThan(0);
  });

  it('pushes a valid typed root up to the session and keeps an invalid one local', () => {
    render(<Harness />);
    const root = screen.getByPlaceholderText('A');

    fireEvent.change(root, { target: { value: 'Bb' } });
    expect(screen.getByRole('heading', { name: /Bb Natural minor/i })).toBeDefined();

    fireEvent.change(root, { target: { value: 'Bx' } });
    expect(root).toHaveProperty('value', 'Bx');
    /* The neck holds the last real key rather than blanking on a keystroke. */
    expect(screen.getByRole('heading', { name: /Bb Natural minor/i })).toBeDefined();
  });

  it('shows the play-along chart under the neck in place of the chord bank', () => {
    render(<Harness />);
    expect(screen.getByRole('heading', { name: 'Chords that live in this key.' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Chart' }));
    expect(screen.getByRole('region', { name: 'Play along chart' })).toBeDefined();
    expect(screen.queryByRole('region', { name: /chord bank/i })).toBeNull();
    expect(screen.getByRole('heading', { name: 'The chart, following the song.' })).toBeDefined();
    /* The neck stays: the chart is under it, not instead of it. */
    expect(screen.getByRole('heading', { name: /Natural minor/i })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Key chords' }));
    expect(screen.getByRole('region', { name: /chord bank/i })).toBeDefined();
  });

  it("opens the song sheet, which says how to get one when the song isn't saved", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Song sheet' }));
    expect(await screen.findByText('No saved copy of this song yet.')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'This recording, read by ear.' })).toBeDefined();
  });

  it('keeps the chosen panel and the sheet switch when the room opens again', () => {
    const { unmount } = render(<Harness />);
    const auto = screen.getByRole('button', { name: 'Sheet when ready' });
    expect(auto.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(auto);
    expect(auto.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Chart' }));
    unmount();

    render(<Harness />);
    expect(screen.getByRole('region', { name: 'Play along chart' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Sheet when ready' }).getAttribute('aria-pressed')).toBe('true');
  });
});
