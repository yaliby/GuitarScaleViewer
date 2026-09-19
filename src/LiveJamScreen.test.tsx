// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import LiveJamScreen from './LiveJamScreen';
import type { PracticeSession } from './practice/session';
import { DEFAULT_SESSION } from './practice/session';

/**
 * Smoke test for the Live Jam chassis: type-check and build both pass on a tree that throws on
 * mount, so something has to actually render it. Outside Tauri every backend hook falls back,
 * which is also what the browser dev server shows.
 */
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
});
