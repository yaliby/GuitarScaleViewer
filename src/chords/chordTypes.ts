export type ChordQuality =
  | 'major'
  | 'minor'
  | 'dim'
  | 'aug'
  | 'sus2'
  | 'sus4'
  | '7'
  | 'maj7'
  | 'm7'
  | 'm7b5';

export type ChordFamily = 'diatonic-triad' | 'diatonic-seventh' | 'extension' | 'color';

export type ScaleChord = {
  degree: string;
  chordName: string;
  /** Spelling root (e.g. "Bb", "C#"). */
  root: string;
  quality: ChordQuality;
  /** Pitch classes in the chord (unique, 0–11). */
  chordPitchClasses: number[];
  chordLabels: string[];
  family: ChordFamily;
  /** Class of the chord root (for fretboard highlight). */
  rootPitchClass: number;
};

export type FretCell = number | 'x' | 'o';

export type ChordPlayability = {
  playable: boolean;
  difficulty: 'easy' | 'medium' | 'hard';
  reason: string;
  playabilityScore: number;
};

export type ChordVoicing = {
  id: string;
  chordName: string;
  variationLabel?: string;
  baseFret: number;
  frets: [FretCell, FretCell, FretCell, FretCell, FretCell, FretCell];
  fingers?: (number | null)[];
  barre?: {
    fret: number;
    fromString: number;
    toString: number;
    finger: number;
  };
  difficulty: 'easy' | 'medium' | 'hard';
  tags?: string[];
  /** Human playability layer result (added at resolve time). */
  playability?: ChordPlayability;
};

export type ChordDisplayGroupKey = 'compact' | 'barre' | 'movable' | 'high';

export type ChordDisplayVoicing = {
  voicing: ChordVoicing;
  shape: string;
  type: string;
  group: ChordDisplayGroupKey;
  /** Search-generated fallback shapes should stay at the end of display order. */
  isFallback: boolean;
  playable: boolean;
};

export type ChordDisplayGroups = {
  compact: ChordDisplayVoicing[];
  barre: ChordDisplayVoicing[];
  movable: ChordDisplayVoicing[];
  high: ChordDisplayVoicing[];
};

export type ScaleChordWithVoicings = ScaleChord & {
  voicings: ChordVoicing[];
  displayVoicings: ChordDisplayVoicing[];
  groups: ChordDisplayGroups;
};
