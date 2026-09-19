import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { KeyReadout } from './KeyReadout';
import { buildScaleNotes } from '../scaleSpell';

afterEach(cleanup);

/**
 * The card's job when the engine cannot pick a root.
 *
 * Measured on the 72-clip corpus (`src-tauri/tests/key_accuracy_scoreboard.rs`): note-set
 * accuracy 97.2%, tonic accuracy 66.7% — 22 of the engine's 24 misses are the right seven notes
 * under the wrong root. So the card must keep showing the notes, because they are almost always
 * right, while refusing to assert a root it has not earned.
 */
describe('KeyReadout with an open tonic', () => {
  const gMajor = () => buildScaleNotes('G', 'major');

  const renderCard = (over: Partial<Parameters<typeof KeyReadout>[0]> = {}) =>
    render(
      <KeyReadout
        root="G"
        scaleType="major"
        notes={gMajor()}
        sourceLabel="Detected"
        {...over}
      />,
    );

  it('keeps every scale tone on screen — the diagram is the part that is right', () => {
    renderCard({ tonicSettled: false, relativeAlternative: 'E minor' });
    // Scoped to the ruler: the tonic's letter also appears in the big key value above it.
    const ruler = within(screen.getByLabelText('Scale tones — root not yet resolved'));
    for (const note of gMajor()) {
      expect(ruler.getByText(note.label)).toBeTruthy();
    }
  });

  it('names the other reading instead of leaving the player to work it out', () => {
    renderCard({ tonicSettled: false, relativeAlternative: 'E minor' });
    expect(screen.getByTestId('jam-key-alt').textContent).toContain('E minor');
  });

  it('says so in the accessible name, not only in colour', () => {
    renderCard({ tonicSettled: false, relativeAlternative: 'E minor' });
    expect(screen.getByLabelText('Scale tones — root not yet resolved')).toBeTruthy();
  });

  it('still shows a root, because a blank neck helps nobody', () => {
    renderCard({ tonicSettled: false, relativeAlternative: 'E minor' });
    expect(screen.getByTestId('jam-key').textContent).toBe('G');
  });

  it('makes no such claim when the tonic is settled', () => {
    renderCard({ tonicSettled: true, relativeAlternative: null });
    expect(screen.queryByTestId('jam-key-alt')).toBeNull();
    expect(screen.getByLabelText('Scale tones')).toBeTruthy();
  });

  it('defaults to a settled tonic so an untouched caller cannot accidentally hedge', () => {
    renderCard();
    expect(screen.queryByTestId('jam-key-alt')).toBeNull();
  });
});
