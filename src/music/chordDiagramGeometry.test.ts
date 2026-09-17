import { describe, expect, it } from 'vitest';
import type { ChordVoicing } from '../chords/chordTypes';
import { getChordDiagramFretWindow } from '../chords/diagramGeometry';

describe('chord diagram fret windows', () => {
  it('expands a closed-position diagram until every accepted fret is visible', () => {
    const voicing: ChordVoicing = {
      id: 'wide-b-dim',
      chordName: 'Bdim',
      baseFret: 3,
      frets: ['x', 'x', 3, 7, 6, 7],
      difficulty: 'hard',
    };

    expect(getChordDiagramFretWindow(voicing)).toEqual({
      startFret: 3,
      endFret: 7,
      fretRows: 5,
      hasOpenBoundary: false,
      boundaryFret: 2,
    });
  });

  it('uses the capo as the open-string boundary', () => {
    const voicing: ChordVoicing = {
      id: 'capo-five',
      chordName: 'D',
      baseFret: 5,
      frets: ['o', 7, 7, 6, 5, 'o'],
      difficulty: 'easy',
    };

    expect(getChordDiagramFretWindow(voicing, 5)).toEqual({
      startFret: 6,
      endFret: 9,
      fretRows: 4,
      hasOpenBoundary: true,
      boundaryFret: 5,
    });
  });

  it('treats a generated numeric fret at the capo as an open boundary note', () => {
    const voicing: ChordVoicing = {
      id: 'generated-at-capo',
      chordName: 'C',
      baseFret: 5,
      frets: [5, 7, 7, 5, 5, 5],
      difficulty: 'easy',
      tags: ['search'],
    };

    expect(getChordDiagramFretWindow(voicing, 5)).toEqual({
      startFret: 6,
      endFret: 9,
      fretRows: 4,
      hasOpenBoundary: true,
      boundaryFret: 5,
    });
  });
});
