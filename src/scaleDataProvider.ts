/**
 * Temporary scale context — replace this module later with a smart engine.
 * No UI, no drawing, no external APIs.
 */

export type ScaleType =
  | 'major'
  | 'minor'
  | 'harmonic-minor'
  | 'melodic-minor'
  | 'dorian'
  | 'phrygian'
  | 'lydian'
  | 'mixolydian'
  | 'locrian'
  | 'pentatonic-major'
  | 'pentatonic-minor'
  | 'blues';

/** Order in the scale-type control (grouped: diatonic variants → pentatonics → blues). */
export const SCALE_TYPES_ORDERED: readonly ScaleType[] = [
  'major',
  'minor',
  'harmonic-minor',
  'melodic-minor',
  'dorian',
  'phrygian',
  'lydian',
  'mixolydian',
  'locrian',
  'pentatonic-major',
  'pentatonic-minor',
  'blues',
] as const;

export const SCALE_TYPE_LABELS: Record<ScaleType, string> = {
  major: 'Major (Ionian)',
  minor: 'Natural minor (Aeolian)',
  'harmonic-minor': 'Harmonic minor',
  'melodic-minor': 'Melodic minor (asc.)',
  dorian: 'Dorian',
  phrygian: 'Phrygian',
  lydian: 'Lydian',
  mixolydian: 'Mixolydian',
  locrian: 'Locrian',
  'pentatonic-major': 'Major pentatonic',
  'pentatonic-minor': 'Minor pentatonic',
  blues: 'Blues',
};

const VALID_ROOT_NOTES = new Set([
  'C',
  'C#',
  'Db',
  'D',
  'D#',
  'Eb',
  'E',
  'F',
  'F#',
  'Gb',
  'G',
  'G#',
  'Ab',
  'A',
  'A#',
  'Bb',
  'B',
]);

/** Returns canonical root (e.g. "Bb") or null if invalid / incomplete. */
export function tryNormalizeRoot(input: string): string | null {
  const t = input.trim();
  if (!t) {
    return null;
  }
  const m = /^([A-Ga-g])([#b]?)$/.exec(t);
  if (!m || m[1] === undefined) {
    return null;
  }
  const letter = m[1].toUpperCase();
  const acc = m[2] ?? '';
  const key = `${letter}${acc}`;
  return VALID_ROOT_NOTES.has(key) ? key : null;
}

export function buildScaleTitle(root: string, scaleType: ScaleType): string {
  const r = root.trim();
  const kind = SCALE_TYPE_LABELS[scaleType];
  return `${r} ${kind}`;
}

/** What the UI and fretboard logic consume — data-driven only. */
export interface ScaleContext {
  root: string;
  scaleType: ScaleType;
  /** Human-readable title, e.g. "A Minor" */
  title: string;
  /** Optional preformatted note names for debugging or future use */
  displayNotes?: readonly string[];
  /** Placeholder for future confidence from detection */
  confidence?: number;
}

/**
 * Static mock — swap implementation later without changing the visual layer.
 */
export function getCurrentScale(): ScaleContext {
  return {
    root: 'A',
    scaleType: 'minor',
    title: buildScaleTitle('A', 'minor'),
    confidence: 1,
  };
}

/** Root + scale from the brain module (file / engine). Same source as {@link getCurrentScale} for now. */
export function getBrainDefaultScale(): Pick<ScaleContext, 'root' | 'scaleType'> {
  const s = getCurrentScale();
  return { root: s.root, scaleType: s.scaleType };
}
