import type { ChordVoicing } from './chordTypes';

export type ChordDiagramFretWindow = {
  startFret: number;
  endFret: number;
  fretRows: number;
  hasOpenBoundary: boolean;
  boundaryFret: number;
};

/** Calculates a diagram window that contains every played fret. */
export function getChordDiagramFretWindow(
  voicing: ChordVoicing,
  capo: number = 0,
): ChordDiagramFretWindow {
  const boundaryFret = Math.max(0, Math.trunc(capo));
  const hasOpenBoundary = voicing.frets.some(
    (cell) =>
      cell === 'o' ||
      cell === 0 ||
      (boundaryFret > 0 && typeof cell === 'number' && cell === boundaryFret),
  );
  const positiveFrets = voicing.frets.filter(
    (cell): cell is number => typeof cell === 'number' && cell > boundaryFret,
  );

  if (hasOpenBoundary) {
    const startFret = boundaryFret + 1;
    const highestPlayed = positiveFrets.length ? Math.max(...positiveFrets) : startFret;
    const fretRows = Math.max(4, highestPlayed - boundaryFret);
    return {
      startFret,
      endFret: boundaryFret + fretRows,
      fretRows,
      hasOpenBoundary,
      boundaryFret,
    };
  }

  const minPlayed = positiveFrets.length ? Math.min(...positiveFrets) : Math.max(1, voicing.baseFret);
  const maxPlayed = positiveFrets.length ? Math.max(...positiveFrets) : minPlayed;
  const requestedBase = Math.max(1, Math.trunc(voicing.baseFret));
  const startFret = requestedBase > 1 && requestedBase <= minPlayed ? requestedBase : minPlayed;
  const fretRows = Math.max(4, maxPlayed - startFret + 1);
  return {
    startFret,
    endFret: startFret + fretRows - 1,
    fretRows,
    hasOpenBoundary,
    boundaryFret: startFret - 1,
  };
}
