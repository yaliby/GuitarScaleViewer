// @ts-nocheck
import { formatChord, pitchName } from './chord';
import type { Chord } from './types';

export type ChordDisplayMode = 'advanced' | 'simple' | 'roman' | 'nashville';

// Major-reference degrees, including in a minor key; these are descriptive
// pitch labels, not inferred harmonic functions or local modulation analysis.
const DEGREES = ['1', 'b2', '2', 'b3', '3', '4', '#4', '5', 'b6', '6', 'b7', '7'];
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

export function displayChord(chord: Chord, mode: ChordDisplayMode, tonic: number | null): string {
  if (chord.kind !== 'chord' || mode === 'advanced') return formatChord(chord);
  if (mode === 'simple') {
    return formatChord({
      ...chord,
      seventh: null,
      extensions: [],
      alterations: chord.alterations.filter(({ degree }) => degree <= 5),
      addedTones: [],
      omittedTones: chord.omittedTones,
    });
  }
  if (tonic === null) return formatChord(chord);
  const degree = (pitch: number) => DEGREES[(((pitch - tonic) % 12) + 12) % 12]!;
  const symbol = formatChord({ ...chord, bass: null });
  let suffix = symbol.slice(pitchName(chord.root, chord.spelling).length);
  let root = degree(chord.root);
  if (mode === 'roman') {
    root = root.replace(/[1-7]/, (value) => ROMAN[Number(value) - 1]!);
    if (chord.triad === 'minor' || chord.triad === 'diminished') {
      root = root.toLowerCase();
      if (suffix.startsWith('m') && !suffix.startsWith('maj')) suffix = suffix.slice(1);
    }
  }
  // Slash bass is an absolute scale degree, never a secondary-dominant claim.
  return root + suffix + (chord.bass === null ? '' : `/${degree(chord.bass)}`);
}
