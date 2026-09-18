import type { ScaleType } from '../scaleDataProvider';
import { SCALE_DEFINITIONS } from '../scaleSpell';

export type PositionMode = 'full' | 'pentatonic' | 'caged' | 'three-notes';

export type PositionWindow = {
  startFret: number;
  endFret: number;
  label: string;
  description: string;
};

export type PositionFret = { stringIndex: number; fret: number };

const STANDARD_OPEN_PCS = [4, 9, 2, 7, 11, 4] as const;
const PENTATONIC_BOX_OFFSETS = [0, 2, 4, 7, 9] as const;
const PENTATONIC_BOX_WIDTHS = [3, 3, 4, 3, 3] as const;
const CAGED_SHAPES = ['C', 'A', 'G', 'E', 'D'] as const;
const CAGED_START_OFFSETS_FROM_LOW_E_ROOT = [-8, -5, -3, -1, 2] as const;
const CAGED_WIDTHS = [4, 4, 4, 5, 4] as const;

const MAJOR_PENTATONIC_COMPATIBLE: ReadonlySet<ScaleType> = new Set([
  'major',
  'lydian',
  'mixolydian',
  'pentatonic-major',
]);
const MINOR_PENTATONIC_COMPATIBLE: ReadonlySet<ScaleType> = new Set([
  'minor',
  'dorian',
  'phrygian',
  'pentatonic-minor',
  'blues',
]);

function mod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function pc(value: number): number {
  return mod(value, 12);
}

function wrappedIndex(index: number, count: number): number {
  return mod(Math.trunc(index), count);
}

function fretForPitchClass(openPc: number, pitchClass: number): number {
  return pc(pitchClass - openPc);
}

function isStandardTuning(openPcs: readonly number[]): boolean {
  return (
    openPcs.length === STANDARD_OPEN_PCS.length &&
    openPcs.every((openPc, index) => pc(openPc) === STANDARD_OPEN_PCS[index])
  );
}

function pentatonicFlavor(scaleType: ScaleType): 'major' | 'minor' | null {
  if (MAJOR_PENTATONIC_COMPATIBLE.has(scaleType)) {
    return 'major';
  }
  if (MINOR_PENTATONIC_COMPATIBLE.has(scaleType)) {
    return 'minor';
  }
  return null;
}

function pentatonicPitchClasses(rootPc: number, flavor: 'major' | 'minor'): readonly number[] {
  const intervals = flavor === 'major' ? [0, 2, 4, 7, 9] : [0, 3, 5, 7, 10];
  return intervals.map((interval) => pc(rootPc + interval));
}

function expectedScalePitchClasses(rootPc: number, scaleType: ScaleType): readonly number[] {
  return SCALE_DEFINITIONS[scaleType].intervals.map((interval) => pc(rootPc + interval));
}

function hasEveryPitch(haystack: ReadonlySet<number>, needles: readonly number[]): boolean {
  return needles.every((pitchClass) => haystack.has(pitchClass));
}

/**
 * Returns the named fret window for a position family. Indices wrap within the
 * family: five pentatonic boxes, five CAGED shapes, or seven 3NPS patterns.
 */
export function getPositionWindow(
  rootPc: number,
  scaleType: ScaleType,
  mode: PositionMode,
  index: number,
  openPcs: readonly number[] = STANDARD_OPEN_PCS,
): PositionWindow {
  if (mode === 'full') {
    return {
      startFret: 0,
      endFret: 24,
      label: 'Full neck',
      description: 'Every current-scale note across the 24-fret neck.',
    };
  }

  if (mode === 'pentatonic') {
    const flavor = pentatonicFlavor(scaleType);
    const relativeMinorRoot = flavor === 'major' ? pc(rootPc + 9) : pc(rootPc);
    const boxIndex = wrappedIndex(index, PENTATONIC_BOX_OFFSETS.length);
    const lowERootFret = fretForPitchClass(STANDARD_OPEN_PCS[0], relativeMinorRoot);
    const startFret = lowERootFret + PENTATONIC_BOX_OFFSETS[boxIndex]!;
    return {
      startFret,
      endFret: startFret + PENTATONIC_BOX_WIDTHS[boxIndex]!,
      label: `Box ${boxIndex + 1}`,
      description: flavor
        ? `${flavor === 'major' ? 'Major' : 'Minor'} pentatonic box, adapted note-by-note to the active tuning.`
        : 'No conventional major or minor pentatonic subset exists for this scale.',
    };
  }

  if (mode === 'caged') {
    const shapeIndex = wrappedIndex(index, CAGED_SHAPES.length);
    const lowERootFret = fretForPitchClass(STANDARD_OPEN_PCS[0], rootPc);
    const startFret = mod(lowERootFret + CAGED_START_OFFSETS_FROM_LOW_E_ROOT[shapeIndex]!, 12);
    return {
      startFret,
      endFret: startFret + CAGED_WIDTHS[shapeIndex]!,
      label: `${CAGED_SHAPES[shapeIndex]} shape`,
      description: 'CAGED major-scale connection for standard E–A–D–G–B–E tuning.',
    };
  }

  const intervals = SCALE_DEFINITIONS[scaleType].intervals;
  const patternIndex = wrappedIndex(index, 7);
  const degreeInterval = intervals[patternIndex] ?? intervals[0] ?? 0;
  const startFret = fretForPitchClass(openPcs[0] ?? STANDARD_OPEN_PCS[0], rootPc + degreeInterval);
  return {
    startFret,
    endFret: startFret + 6,
    label: `3NPS degree ${patternIndex + 1}`,
    description: 'Three scale notes per string, beginning from the named scale degree on low E.',
  };
}

function allScaleFrets(
  openPcs: readonly number[],
  allowedPcs: ReadonlySet<number>,
  startFret: number,
  endFret: number,
): PositionFret[] {
  const points: PositionFret[] = [];
  openPcs.forEach((openPc, stringIndex) => {
    for (let fret = startFret; fret <= endFret; fret += 1) {
      if (allowedPcs.has(pc(openPc + fret))) {
        points.push({ stringIndex, fret });
      }
    }
  });
  return points;
}

/**
 * Resolves a position against actual open-string pitch classes. CAGED is
 * deliberately limited to major scale in standard tuning; unsupported
 * combinations return an empty array instead of showing a mislabeled shape.
 */
export function getPositionFrets(
  openPcs: readonly number[],
  scalePcs: readonly number[],
  rootPc: number,
  scaleType: ScaleType,
  mode: PositionMode,
  index: number,
): PositionFret[] {
  if (openPcs.length === 0 || scalePcs.length === 0) {
    return [];
  }
  const scaleSet = new Set(scalePcs.map(pc));
  const window = getPositionWindow(rootPc, scaleType, mode, index, openPcs);

  if (mode === 'full') {
    return allScaleFrets(openPcs, scaleSet, window.startFret, window.endFret);
  }

  if (mode === 'pentatonic') {
    const flavor = pentatonicFlavor(scaleType);
    if (!flavor) {
      return [];
    }
    const pentatonicPcs = pentatonicPitchClasses(rootPc, flavor);
    if (!hasEveryPitch(scaleSet, pentatonicPcs)) {
      return [];
    }
    return allScaleFrets(
      openPcs,
      new Set(pentatonicPcs),
      window.startFret,
      window.endFret,
    );
  }

  if (mode === 'caged') {
    const expected = expectedScalePitchClasses(rootPc, scaleType);
    if (scaleType !== 'major' || !isStandardTuning(openPcs) || !hasEveryPitch(scaleSet, expected)) {
      return [];
    }
    return allScaleFrets(openPcs, scaleSet, window.startFret, window.endFret);
  }

  const expected = expectedScalePitchClasses(rootPc, scaleType);
  if (expected.length !== 7 || scaleSet.size !== 7 || !hasEveryPitch(scaleSet, expected)) {
    return [];
  }
  const candidates = allScaleFrets(openPcs, scaleSet, window.startFret, window.endFret);
  const points: PositionFret[] = [];
  for (let stringIndex = 0; stringIndex < openPcs.length; stringIndex += 1) {
    const onString = candidates.filter((point) => point.stringIndex === stringIndex).slice(0, 3);
    if (onString.length !== 3) {
      return [];
    }
    points.push(...onString);
  }
  return points;
}
