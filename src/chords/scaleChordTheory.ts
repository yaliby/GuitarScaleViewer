/**
 * Diatonic harmony on the current scale (same spelling as fretboard via scaleSpell).
 */

import type { ScaleType } from '../scaleDataProvider';
import { buildScaleNotes, type ScaleNote } from '../scaleSpell';
import type { ChordQuality, ScaleChord } from './chordTypes';

const HEPTATONIC: ReadonlySet<ScaleType> = new Set([
  'major',
  'minor',
  'harmonic-minor',
  'melodic-minor',
  'dorian',
  'phrygian',
  'lydian',
  'mixolydian',
  'locrian',
]);

/** Roman numerals for diatonic triads (degree 1 = index 0), per mode. */
const TRIAD_ROMAN: Record<string, readonly string[]> = {
  major: ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'],
  minor: ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII'],
  'harmonic-minor': ['i', 'ii°', 'III+', 'iv', 'V', 'VI', 'vii°'],
  'melodic-minor': ['i', 'ii', 'III+', 'IV', 'V', 'vi°', 'vii°'],
  dorian: ['i', 'ii', 'III', 'IV', 'v', 'vi°', 'VII'],
  phrygian: ['i', 'II', 'III', 'iv', 'v°', 'VI', 'vii'],
  lydian: ['I', 'II', 'iii', '#iv°', 'V', 'VI', 'vii'],
  mixolydian: ['I', 'ii', 'iii°', 'IV', 'v', 'VI', 'VII'],
  locrian: ['i°', 'II', 'iii', 'iv', 'V', 'VI', 'vii'],
};

type TriadKind = 'major' | 'minor' | 'diminished' | 'augmented';

function triadKind(rootPc: number, thirdPc: number, fifthPc: number): TriadKind {
  const i3 = (thirdPc - rootPc + 12) % 12;
  const i5 = (fifthPc - rootPc + 12) % 12;
  if (i3 === 4 && i5 === 7) {
    return 'major';
  }
  if (i3 === 3 && i5 === 7) {
    return 'minor';
  }
  if (i3 === 3 && i5 === 6) {
    return 'diminished';
  }
  if (i3 === 4 && i5 === 8) {
    return 'augmented';
  }
  return 'major';
}

function qualityForScaleChord(kind: TriadKind): ChordQuality {
  switch (kind) {
    case 'major':
      return 'major';
    case 'minor':
      return 'minor';
    case 'diminished':
      return 'dim';
    case 'augmented':
      return 'aug';
    default:
      return 'major';
  }
}

function chordSymbolFromRootLabel(rootLabel: string, kind: TriadKind): string {
  switch (kind) {
    case 'major':
      return rootLabel;
    case 'minor':
      return `${rootLabel}m`;
    case 'diminished':
      return `${rootLabel}dim`;
    case 'augmented':
      return `${rootLabel}aug`;
    default:
      return rootLabel;
  }
}

function romanKey(scaleType: ScaleType): keyof typeof TRIAD_ROMAN | null {
  if (TRIAD_ROMAN[scaleType]) {
    return scaleType;
  }
  return null;
}

/**
 * Returns diatonic triads for 7-note scales; empty for pentatonic / blues.
 */
export function getDiatonicTriads(root: string, scaleType: ScaleType): ScaleChord[] {
  if (!HEPTATONIC.has(scaleType)) {
    return [];
  }

  const notes = buildScaleNotes(root, scaleType);
  if (notes.length !== 7) {
    return [];
  }

  const rk = romanKey(scaleType);
  const romans = rk ? TRIAD_ROMAN[rk] : null;
  const out: ScaleChord[] = [];

  for (let i = 0; i < 7; i++) {
    const r = notes[i];
    const t = notes[(i + 2) % 7];
    const f = notes[(i + 4) % 7];
    if (!r || !t || !f) {
      continue;
    }
    const kind = triadKind(r.pitchClass, t.pitchClass, f.pitchClass);
    const degree = romans?.[i] ?? `${i + 1}`;
    const chordName = chordSymbolFromRootLabel(r.label, kind);
    const unique = [...new Set([r.pitchClass, t.pitchClass, f.pitchClass])];

    out.push({
      degree,
      chordName,
      root: r.label,
      quality: qualityForScaleChord(kind),
      chordPitchClasses: unique,
      chordLabels: [chordName],
      family: 'diatonic-triad',
      rootPitchClass: r.pitchClass,
    });
  }

  return out;
}

export function isHeptatonicScaleType(scaleType: ScaleType): boolean {
  return HEPTATONIC.has(scaleType);
}

/** For extensions (borrowed chords) later. */
export function scaleNotesForChordContext(root: string, scaleType: ScaleType): ScaleNote[] {
  return buildScaleNotes(root, scaleType);
}
