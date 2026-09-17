/**
 * Shared scale spelling — same rules as the fretboard (letter names + pitch classes).
 */

import type { ScaleType } from './scaleDataProvider';

export const SCALE_DEFINITIONS: Record<
  ScaleType,
  { intervals: readonly number[]; letterIndices: readonly number[] }
> = {
  major: {
    intervals: [0, 2, 4, 5, 7, 9, 11],
    letterIndices: [0, 1, 2, 3, 4, 5, 6],
  },
  minor: {
    intervals: [0, 2, 3, 5, 7, 8, 10],
    letterIndices: [0, 1, 2, 3, 4, 5, 6],
  },
  'harmonic-minor': {
    intervals: [0, 2, 3, 5, 7, 8, 11],
    letterIndices: [0, 1, 2, 3, 4, 5, 6],
  },
  'melodic-minor': {
    intervals: [0, 2, 3, 5, 7, 9, 11],
    letterIndices: [0, 1, 2, 3, 4, 5, 6],
  },
  dorian: {
    intervals: [0, 2, 3, 5, 7, 9, 10],
    letterIndices: [0, 1, 2, 3, 4, 5, 6],
  },
  phrygian: {
    intervals: [0, 1, 3, 5, 7, 8, 10],
    letterIndices: [0, 1, 2, 3, 4, 5, 6],
  },
  lydian: {
    intervals: [0, 2, 4, 6, 7, 9, 11],
    letterIndices: [0, 1, 2, 3, 4, 5, 6],
  },
  mixolydian: {
    intervals: [0, 2, 4, 5, 7, 9, 10],
    letterIndices: [0, 1, 2, 3, 4, 5, 6],
  },
  locrian: {
    intervals: [0, 1, 3, 5, 6, 8, 10],
    letterIndices: [0, 1, 2, 3, 4, 5, 6],
  },
  'pentatonic-major': {
    intervals: [0, 2, 4, 7, 9],
    letterIndices: [0, 1, 2, 4, 5],
  },
  'pentatonic-minor': {
    intervals: [0, 3, 5, 7, 10],
    letterIndices: [0, 2, 3, 4, 6],
  },
  blues: {
    intervals: [0, 3, 5, 6, 7, 10],
    letterIndices: [0, 2, 3, 4, 4, 6],
  },
};

export const SCALE_DEGREE_LABELS: Record<ScaleType, readonly string[]> = {
  major: ['1', '2', '3', '4', '5', '6', '7'],
  minor: ['1', '2', 'b3', '4', '5', 'b6', 'b7'],
  'harmonic-minor': ['1', '2', 'b3', '4', '5', 'b6', '7'],
  'melodic-minor': ['1', '2', 'b3', '4', '5', '6', '7'],
  dorian: ['1', '2', 'b3', '4', '5', '6', 'b7'],
  phrygian: ['1', 'b2', 'b3', '4', '5', 'b6', 'b7'],
  lydian: ['1', '2', '3', '#4', '5', '6', '7'],
  mixolydian: ['1', '2', '3', '4', '5', '6', 'b7'],
  locrian: ['1', 'b2', 'b3', '4', 'b5', 'b6', 'b7'],
  'pentatonic-major': ['1', '2', '3', '5', '6'],
  'pentatonic-minor': ['1', 'b3', '4', '5', 'b7'],
  blues: ['1', 'b3', '4', 'b5', '5', 'b7'],
};

const LETTER_ORDER = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;

const BASE_PC: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

export type ScaleNote = {
  pitchClass: number;
  label: string;
  isRoot: boolean;
};

function normalizePitchClass(pc: number): number {
  return ((pc % 12) + 12) % 12;
}

function parseSpelledNote(note: string): { letter: string; accidentals: string; pitchClass: number } | null {
  const normalized = note.trim().replaceAll('♯', '#').replaceAll('♭', 'b');
  const match = /^([A-Ga-g])([#b]*)$/.exec(normalized);
  if (!match || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  const letter = match[1].toUpperCase();
  const accidentals = match[2];
  if (accidentals.includes('#') && accidentals.includes('b')) {
    return null;
  }
  const base = BASE_PC[letter];
  if (base === undefined) {
    return null;
  }
  const offset = accidentals.startsWith('#') ? accidentals.length : -accidentals.length;
  return { letter, accidentals, pitchClass: normalizePitchClass(base + offset) };
}

export function parseRoot(root: string): { letter: string; pitchClass: number; key: string } {
  const parsed = parseSpelledNote(root);
  if (!parsed) {
    throw new Error(`Invalid root: ${root}`);
  }
  return {
    letter: parsed.letter,
    pitchClass: parsed.pitchClass,
    key: `${parsed.letter}${parsed.accidentals}`,
  };
}

function rotateLettersFromRoot(rootLetter: string): readonly string[] {
  const idx = LETTER_ORDER.indexOf(rootLetter as (typeof LETTER_ORDER)[number]);
  if (idx === -1) {
    throw new Error(`Invalid letter: ${rootLetter}`);
  }
  return [...LETTER_ORDER.slice(idx), ...LETTER_ORDER.slice(0, idx)];
}

function accidentalForLetter(letter: string, targetPc: number): string {
  const base = BASE_PC[letter];
  if (base === undefined) {
    return '';
  }
  let diff = (targetPc - base + 12) % 12;
  if (diff > 6) {
    diff -= 12;
  }
  if (diff === 0) {
    return letter;
  }
  return diff > 0 ? `${letter}${'#'.repeat(diff)}` : `${letter}${'b'.repeat(-diff)}`;
}

export function buildScaleNotes(root: string, scaleType: ScaleType): ScaleNote[] {
  const { letter: rootLetter, pitchClass: rootPc } = parseRoot(root);
  const def = SCALE_DEFINITIONS[scaleType];
  const { intervals, letterIndices } = def;
  if (intervals.length !== letterIndices.length) {
    throw new Error(`Scale definition length mismatch: ${scaleType}`);
  }
  const letters = rotateLettersFromRoot(rootLetter);

  return intervals.map((interval, idx) => {
    const pitchClass = (rootPc + interval) % 12;
    const li = letterIndices[idx];
    if (li === undefined) {
      throw new Error('Scale spelling mismatch');
    }
    const letter = letters[li];
    if (!letter) {
      throw new Error('Scale spelling mismatch');
    }
    const label = accidentalForLetter(letter, pitchClass);
    return {
      pitchClass,
      label,
      isRoot: idx === 0,
    };
  });
}

export function pitchClassSet(notes: ScaleNote[]): Set<number> {
  return new Set(notes.map((n) => n.pitchClass));
}

export function labelForPitchClass(
  notes: ScaleNote[],
  pc: number,
): { label: string; isRoot: boolean } | null {
  const match = notes.find((n) => n.pitchClass === pc);
  if (!match) {
    return null;
  }
  return { label: match.label, isRoot: match.isRoot };
}

export function pitchClassForNoteLabel(noteLabel: string): number | null {
  return parseSpelledNote(noteLabel)?.pitchClass ?? null;
}
