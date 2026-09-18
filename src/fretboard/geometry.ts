import {
  SCALE_DEFINITIONS,
  pitchClassSet,
  type ScaleNote,
} from '../scaleSpell';
import type { ScaleType } from '../scaleDataProvider';

export type FretboardViewMode =
  | 'scale-all'
  | 'scale-plus-pentatonic'
  | 'root-only'
  | 'triads'
  | 'chromatic';

export const ALL_PITCH_CLASS_SET = new Set<number>([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

export const CHROMATIC_LABELS: readonly string[] = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
];

export function labelChromatic(pc: number): string {
  return CHROMATIC_LABELS[pc] ?? '';
}

/** The other pentatonic on the same root (major ↔ minor), or by tonality (M3 vs m3) for heptatonic scales. */
export function pentatonicCompanionType(scaleType: ScaleType): 'pentatonic-major' | 'pentatonic-minor' {
  if (scaleType === 'pentatonic-major') {
    return 'pentatonic-minor';
  }
  if (scaleType === 'pentatonic-minor') {
    return 'pentatonic-major';
  }
  const third = SCALE_DEFINITIONS[scaleType].intervals[2];
  return third === 4 ? 'pentatonic-minor' : 'pentatonic-major';
}

/** Tonic triad: root + minor or major 3rd present in scale + P5. */
export function triadPitchClassSet(notes: ScaleNote[]): Set<number> {
  const rootPc = notes[0]?.pitchClass;
  if (rootPc === undefined) {
    return new Set();
  }
  const set = new Set<number>([rootPc]);
  const thirdMinor = (rootPc + 3) % 12;
  const thirdMajor = (rootPc + 4) % 12;
  const thirdNote =
    notes.find((n) => n.pitchClass === thirdMinor) ??
    notes.find((n) => n.pitchClass === thirdMajor);
  if (thirdNote) {
    set.add(thirdNote.pitchClass);
  }
  const fifth = notes.find((n) => n.pitchClass === (rootPc + 7) % 12);
  if (fifth) {
    set.add(fifth.pitchClass);
  }
  return set;
}

export function mainPitchClassSet(mode: FretboardViewMode, notes: ScaleNote[]): Set<number> {
  if (mode === 'chromatic') {
    return ALL_PITCH_CLASS_SET;
  }
  if (mode === 'scale-all' || mode === 'scale-plus-pentatonic') {
    return pitchClassSet(notes);
  }
  if (mode === 'root-only') {
    const r = notes[0]?.pitchClass;
    return r === undefined ? new Set() : new Set([r]);
  }
  return triadPitchClassSet(notes);
}

export function pitchAtFret(openStringPcs: readonly number[], stringIndex: number, fret: number): number {
  const open = openStringPcs[stringIndex];
  if (open === undefined) {
    throw new Error(`Invalid string index: ${stringIndex}`);
  }
  return (open + fret) % 12;
}

export type FretPoint = {
  stringIndex: number;
  fret: number;
  x: number;
  y: number;
};

/**
 * Equal-temperament fret positions from the nut (12-TET).
 * s[k] = distance from nut to the k-th fret wire; s[0] = 0.
 */
export function fretDistancesFromNut(numFrets: number, nutToLastFretWire: number): number[] {
  const denom = 1 - Math.pow(2, -numFrets / 12);
  const scaleLength = nutToLastFretWire / denom;
  const s: number[] = [0];
  for (let k = 1; k <= numFrets; k++) {
    s.push(scaleLength * (1 - Math.pow(2, -k / 12)));
  }
  return s;
}

/**
 * Horizontal center for a scale dot: musical fret `fret` (0 = open).
 * `s[k]` = distance from nut face to k-th fret wire; wires are drawn at `leftPad + nutW + s[k]`.
 * Fret N slot lies between wire N-1 and wire N, so its center is midpoint of those distances.
 */
export function fretMarkerCenterX(leftPad: number, nutW: number, s: number[], fret: number): number {
  if (fret === 0) {
    const s1 = s[1];
    if (s1 === undefined) {
      return leftPad + nutW * 0.5;
    }
    // Open string: left third of first fret slot (clearly left of fret-1 center, not on the nut bar)
    return leftPad + nutW + s1 * 0.26;
  }
  const leftWire = s[fret - 1];
  const rightWire = s[fret];
  if (leftWire === undefined || rightWire === undefined) {
    return leftPad + nutW;
  }
  return leftPad + nutW + (leftWire + rightWire) / 2;
}

/** Extra “virtual” frets past the last playable fret — continues toward the bridge / off-screen. */
export function computeGhostFretWireXs(
  numFrets: number,
  nutToLastFretWire: number,
  leftPad: number,
  nutW: number,
  count: number,
): number[] {
  const denom = 1 - Math.pow(2, -numFrets / 12);
  const scaleLength = nutToLastFretWire / denom;
  const xs: number[] = [];
  for (let k = numFrets + 1; k <= numFrets + count; k++) {
    const sk = scaleLength * (1 - Math.pow(2, -k / 12));
    xs.push(leftPad + nutW + sk);
  }
  return xs;
}

export function buildLayout(numFrets: number): {
  nutW: number;
  stringGap: number;
  topPad: number;
  leftPad: number;
  bottomPad: number;
  boardTop: number;
  boardBottom: number;
  height: number;
  width: number;
  /** Baseline Y for fret number labels (above the fretboard). */
  fretNumberBaselineY: number;
  /** Distance from nut edge to last fret wire (SVG units). */
  lastWireFromNut: number;
  fretCenters: number[];
  stringYs: number[];
  fretWireXs: number[];
  /** X of each ghost fret wire (beyond playable frets). */
  ghostFretWireXs: number[];
  /** X where playable neck ends (last real fret wire). */
  neckEndX: number;
  /** Right edge of finished binding / face. */
  boardFaceRightX: number;
  /** Right edge for ghost frets and string span. */
  boardRightX: number;
} {
  const nutW = 82;
  const stringGap = 80;
  const topPad = 104;
  const leftPad = 146;
  const bottomPad = 58;
  const boardTop = topPad;
  const boardBottom = topPad + stringGap * 5;
  /** Fret numbers sit above the binding (wood ~boardTop − 18). */
  const fretNumberBaselineY = boardTop - 42;
  const height = boardBottom + bottomPad;

  /** Horizontal span (nut → last fret) — larger units → bigger on-screen neck. */
  const nutToBridgeFrets = 102 * numFrets;
  const s = fretDistancesFromNut(numFrets, nutToBridgeFrets);

  const GHOST_FRET_COUNT = 5;
  const ghostFretWireXs = computeGhostFretWireXs(
    numFrets,
    nutToBridgeFrets,
    leftPad,
    nutW,
    GHOST_FRET_COUNT,
  );

  const fretWireXs: number[] = [];
  for (let k = 1; k <= numFrets; k++) {
    const sk = s[k];
    if (sk === undefined) {
      throw new Error('Fret geometry mismatch');
    }
    fretWireXs.push(leftPad + nutW + sk);
  }

  const fretCenters: number[] = [];
  for (let fret = 0; fret <= numFrets; fret++) {
    fretCenters.push(fretMarkerCenterX(leftPad, nutW, s, fret));
  }

  const lastWire = s[numFrets];
  if (lastWire === undefined) {
    throw new Error('Fret geometry mismatch');
  }
  const neckEndX = leftPad + nutW + lastWire;
  const lastGhostX = ghostFretWireXs[ghostFretWireXs.length - 1];
  if (lastGhostX === undefined) {
    throw new Error('Ghost fret geometry mismatch');
  }
  /** Binding/wood face extends slightly past the last fret wire. */
  const boardFaceRightX = neckEndX + 14;
  const boardRightX = Math.min(lastGhostX + 36, neckEndX + 118);
  /** ViewBox width: neck + right padding. */
  const width = neckEndX + 48;

  /**
   * Player view: 6th string (low E) at top → 1st string (high E) at bottom.
   * Index 0 = low E, 1 = A (second from top), … 5 = high E.
   */
  const stringYs = Array.from({ length: 6 }, (_, sIdx) => topPad + sIdx * stringGap);

  return {
    nutW,
    stringGap,
    topPad,
    leftPad,
    bottomPad,
    boardTop,
    boardBottom,
    height,
    width,
    fretNumberBaselineY,
    lastWireFromNut: lastWire,
    fretCenters,
    stringYs,
    fretWireXs,
    ghostFretWireXs,
    neckEndX,
    boardFaceRightX,
    boardRightX,
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Capo: crop + zoom window; center the slice (capo wire → last fret) when possible.
 * Tuning sits left of the wire — view width must span from ~(wireX − minSpaceLeftOfWire) to layout.width
 * or fret 24 / the bridge edge is clipped (common at capo 1–3 with a fixed zoom fraction).
 */
export const CAPO_CAMERA = {
  viewWidthFraction: 0.74,
  minViewWidth: 1000,
  /** ViewBox left edge x must be ≤ wireX − this so tuning pills stay visible. */
  minSpaceLeftOfWire: 215,
  /** From this capo fret upward, viewBox width (zoom) matches capo 9 — only panning changes. */
  zoomLockFromCapo: 9,
} as const;

/** Zoom level only — same formulas as buildCameraWindow for a given capo fret index. */
export function capoViewWidthForZoom(layout: ReturnType<typeof buildLayout>, capo: number): number {
  const W = layout.width;
  const wireX = layout.fretWireXs[capo - 1] ?? layout.leftPad + layout.nutW;
  const { neckEndX } = layout;
  const left = CAPO_CAMERA.minSpaceLeftOfWire;

  const minSpan = W - wireX + left;

  let viewW = Math.round(W * CAPO_CAMERA.viewWidthFraction);
  viewW = Math.max(viewW, CAPO_CAMERA.minViewWidth, Math.ceil(minSpan));
  viewW = Math.min(viewW, W - 1);

  const sliceCenter = (wireX + neckEndX) / 2;

  if (capo >= 6) {
    const maxWForCenter = 2 * (W - sliceCenter);
    if (Number.isFinite(maxWForCenter) && maxWForCenter > 0) {
      const capped = Math.min(viewW, Math.ceil(maxWForCenter));
      viewW = Math.max(Math.ceil(minSpan), capped);
      viewW = Math.min(viewW, W - 1);
    }
  }

  return viewW;
}

export function buildCameraWindow(
  layout: ReturnType<typeof buildLayout>,
  capo: number,
): { x: number; width: number } {
  if (capo <= 0) {
    return { x: 0, width: layout.width };
  }

  const W = layout.width;
  const wireX = layout.fretWireXs[capo - 1] ?? layout.leftPad + layout.nutW;
  const { neckEndX } = layout;
  const left = CAPO_CAMERA.minSpaceLeftOfWire;

  const zoomCapo =
    capo >= CAPO_CAMERA.zoomLockFromCapo &&
    layout.fretWireXs[CAPO_CAMERA.zoomLockFromCapo - 1] !== undefined
      ? CAPO_CAMERA.zoomLockFromCapo
      : capo;
  let viewW = capoViewWidthForZoom(layout, zoomCapo);

  const sliceCenter = (wireX + neckEndX) / 2;

  const maxX = W - viewW;
  const xMin = Math.max(0, W - viewW);
  const xMax = Math.min(Math.max(0, wireX - left), maxX);

  let x = sliceCenter - viewW / 2;
  x = clamp(x, xMin, xMax);

  // Should not happen if viewW ≥ minSpan; fallback to full width.
  if (xMin > xMax) {
    viewW = W - 1;
    const maxX2 = W - viewW;
    const xMin2 = Math.max(0, W - viewW);
    const xMax2 = Math.min(Math.max(0, wireX - left), maxX2);
    x = clamp(sliceCenter - viewW / 2, xMin2, xMax2);
  }

  return { x, width: viewW };
}

export function getCapoBodyX(layout: ReturnType<typeof buildLayout>, capo: number): number | null {
  if (capo <= 0) {
    return null;
  }
  const wireX = layout.fretWireXs[capo - 1];
  if (wireX === undefined) {
    return null;
  }
  return wireX - 22;
}

/** Typical side dots on a 24-fret neck (12 & 24 as double inlays in render). */
export const FRET_MARKER_FRETS = new Set([3, 5, 7, 9, 12, 15, 17, 19, 21, 24]);

/** Gentle exit so dots don’t pop off the neck. */
export const NOTE_EXIT = { type: 'spring' as const, stiffness: 380, damping: 38, mass: 0.65 };
export const NOTE_LAYOUT_SPRING = { type: 'spring' as const, stiffness: 340, damping: 36 };

export type ChordEmphasis = 'chord-root' | 'chord-member' | 'chord-dimmed';

export type RenderMarker = {
  x: number;
  y: number;
  label: string;
  isRootStyle: boolean;
  overlayOnly: boolean;
  showPentRing: boolean;
  pitchClass: number;
  chordEmphasis?: ChordEmphasis;
};

export type MarkerToken = {
  id: string;
  x: number;
  y: number;
  visible: boolean;
  marker: RenderMarker | null;
};

export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}
