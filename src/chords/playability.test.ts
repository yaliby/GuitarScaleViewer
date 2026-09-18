import { describe, expect, it } from 'vitest';
import type { ChordVoicing, FretCell } from './chordTypes';
import { evaluateVoicingPlayability } from './playability';

function voicing(
  frets: [FretCell, FretCell, FretCell, FretCell, FretCell, FretCell],
  extra: Partial<ChordVoicing> = {},
): ChordVoicing {
  return {
    id: 'test',
    chordName: 'Test',
    baseFret: 1,
    frets,
    difficulty: 'medium',
    ...extra,
  };
}

describe('evaluateVoicingPlayability', () => {
  it('rejects a voicing with no fretted note', () => {
    const result = evaluateVoicingPlayability(voicing(['x', 'o', 'o', 'o', 'o', 'x']));
    expect(result.playable).toBe(false);
    expect(result.difficulty).toBe('hard');
    expect(result.reason).toBe('no fretted notes');
  });

  it('rejects a stretch no hand can make', () => {
    const result = evaluateVoicingPlayability(voicing([1, 'x', 'x', 'x', 'x', 12]));
    expect(result.playable).toBe(false);
    expect(result.reason).toBe('too wide span');
  });

  it('accepts open-position C major as playable', () => {
    const result = evaluateVoicingPlayability(voicing(['x', 3, 2, 'o', 1, 'o']));
    expect(result.playable).toBe(true);
    expect(result.playabilityScore).toBeGreaterThan(0);
  });

  it('accepts the E-shape F barre as playable', () => {
    const result = evaluateVoicingPlayability(
      voicing([1, 3, 3, 2, 1, 1], {
        barre: { fret: 1, fromString: 0, toString: 5, finger: 1 },
      }),
    );
    expect(result.playable).toBe(true);
  });

  it('scores an easy open chord above a barre chord', () => {
    const open = evaluateVoicingPlayability(voicing(['x', 'o', 2, 2, 2, 'o']));
    const barre = evaluateVoicingPlayability(
      voicing([1, 3, 3, 2, 1, 1], {
        barre: { fret: 1, fromString: 0, toString: 5, finger: 1 },
      }),
    );
    expect(open.playabilityScore).toBeGreaterThan(barre.playabilityScore);
  });

  it('allows a wider span higher up the neck than at the nut', () => {
    const low = evaluateVoicingPlayability(voicing([1, 'x', 'x', 'x', 'x', 6]));
    const high = evaluateVoicingPlayability(voicing([10, 'x', 'x', 'x', 'x', 15]));
    expect(low.playable).toBe(false);
    expect(high.playable).toBe(true);
  });

  it('always reports a non-empty reason and a defined difficulty', () => {
    const samples: Array<[FretCell, FretCell, FretCell, FretCell, FretCell, FretCell]> = [
      ['x', 'o', 'o', 'o', 'o', 'x'],
      ['x', 3, 2, 'o', 1, 'o'],
      [1, 3, 3, 2, 1, 1],
      [5, 7, 7, 6, 5, 5],
      [1, 'x', 'x', 'x', 'x', 12],
    ];
    for (const frets of samples) {
      const result = evaluateVoicingPlayability(voicing(frets));
      expect(result.reason.length).toBeGreaterThan(0);
      expect(['easy', 'medium', 'hard']).toContain(result.difficulty);
    }
  });
});
