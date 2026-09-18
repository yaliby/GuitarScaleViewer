// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import App from './App';

/**
 * Smoke test for the whole chassis: type-check and build both pass on a tree that throws on
 * mount, so something has to actually render it. Outside Tauri every backend hook falls back,
 * which is also what the browser dev server shows.
 */
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('mounts with the default A minor scale and the fretboard', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    render(<App />);

    expect(screen.getByText('Fretboard Lab')).toBeDefined();
    expect(screen.getByRole('region', { name: /chord bank/i })).toBeDefined();
    expect(screen.getByText('No media session')).toBeDefined();
    expect(document.querySelectorAll('svg').length).toBeGreaterThan(0);
  });
});
