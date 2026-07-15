/**
 * Curated guitar voicings (standard tuning). No rendering — data only.
 */

import type { ChordQuality, ChordVoicing } from './chordTypes';

function V(
  v: Omit<ChordVoicing, 'frets'> & { frets: ReadonlyArray<string | number> },
): ChordVoicing {
  const frets = v.frets.map((c) => {
    if (c === 'x' || c === 'o' || c === 'X' || c === 'O') {
      const u = String(c).toLowerCase();
      return u === 'x' ? ('x' as const) : ('o' as const);
    }
    return Number(c);
  }) as ChordVoicing['frets'];
  return { ...v, frets };
}

/** Exact chord symbol → useful shapes (open / common). */
export const CURATED_VOICINGS_BY_NAME: Record<string, ChordVoicing[]> = {
  C: [
    V({
      id: 'c-open',
      chordName: 'C',
      variationLabel: 'Open',
      baseFret: 1,
      frets: ['x', 3, 2, 0, 1, 0],
      fingers: [null, 3, 2, null, 1, null],
      difficulty: 'easy',
      tags: ['open', 'compact'],
    }),
  ],
  G: [
    V({
      id: 'g-open',
      chordName: 'G',
      variationLabel: 'Open',
      baseFret: 1,
      frets: [3, 2, 0, 0, 0, 3],
      fingers: [2, 1, null, null, null, 3],
      difficulty: 'easy',
      tags: ['open'],
    }),
  ],
  D: [
    V({
      id: 'd-open',
      chordName: 'D',
      variationLabel: 'Open',
      baseFret: 1,
      frets: ['x', 'x', 0, 2, 3, 2],
      fingers: [null, null, null, 1, 3, 2],
      difficulty: 'easy',
      tags: ['open', 'compact'],
    }),
  ],
  A: [
    V({
      id: 'a-open',
      chordName: 'A',
      variationLabel: 'Open',
      baseFret: 1,
      frets: ['x', 0, 2, 2, 2, 0],
      fingers: [null, null, 1, 2, 3, null],
      difficulty: 'easy',
      tags: ['open'],
    }),
  ],
  E: [
    V({
      id: 'e-open',
      chordName: 'E',
      variationLabel: 'Open',
      baseFret: 1,
      frets: [0, 2, 2, 1, 0, 0],
      fingers: [null, 2, 3, 1, null, null],
      difficulty: 'easy',
      tags: ['open'],
    }),
  ],
  F: [
    V({
      id: 'f-compact-dgbe',
      chordName: 'F',
      variationLabel: 'Compact (D–e)',
      baseFret: 1,
      frets: ['x', 'x', 3, 2, 1, 1],
      fingers: [null, null, 3, 2, 1, 1],
      barre: { fret: 1, fromString: 4, toString: 5, finger: 1 },
      difficulty: 'medium',
      tags: ['compact', 'barre'],
    }),
    V({
      id: 'f-triad-dgb',
      chordName: 'F',
      variationLabel: 'Triad (D–B)',
      baseFret: 1,
      frets: ['x', 'x', 3, 2, 1, 'x'],
      fingers: [null, null, 3, 2, 1, null],
      difficulty: 'medium',
      tags: ['compact'],
    }),
    V({
      id: 'f-spread-133211',
      chordName: 'F',
      variationLabel: 'Spread (CAGED-style)',
      baseFret: 1,
      frets: [1, 3, 3, 2, 1, 1],
      fingers: [1, 3, 4, 2, 1, 1],
      difficulty: 'hard',
      tags: ['compact'],
    }),
    V({
      id: 'f-barre',
      chordName: 'F',
      variationLabel: 'Barre (E-shape)',
      baseFret: 1,
      frets: [1, 1, 2, 3, 3, 1],
      barre: { fret: 1, fromString: 0, toString: 5, finger: 1 },
      difficulty: 'hard',
      tags: ['barre'],
    }),
  ],
  Am: [
    V({
      id: 'am-open',
      chordName: 'Am',
      variationLabel: 'Open',
      baseFret: 1,
      frets: ['x', 0, 2, 2, 1, 0],
      fingers: [null, null, 2, 3, 1, null],
      difficulty: 'easy',
      tags: ['open'],
    }),
  ],
  Em: [
    V({
      id: 'em-open',
      chordName: 'Em',
      variationLabel: 'Open',
      baseFret: 1,
      frets: [0, 2, 2, 0, 0, 0],
      fingers: [null, 2, 3, null, null, null],
      difficulty: 'easy',
      tags: ['open'],
    }),
  ],
  Dm: [
    V({
      id: 'dm-open',
      chordName: 'Dm',
      variationLabel: 'Open',
      baseFret: 1,
      frets: ['x', 'x', 0, 2, 3, 1],
      fingers: [null, null, null, 1, 3, 2],
      difficulty: 'easy',
      tags: ['open', 'compact'],
    }),
  ],
  Bdim: [
    V({
      id: 'bdim-x2343',
      chordName: 'Bdim',
      variationLabel: 'Compact',
      baseFret: 1,
      // Root on A (ii): x f f+1 f+2 f+1 x — 4th string must be m3, not a fourth above the 3rd.
      frets: ['x', 2, 3, 4, 3, 'x'],
      fingers: [null, 1, 2, 4, 3, null],
      difficulty: 'medium',
      tags: ['compact'],
    }),
  ],
  Cm: [
    V({
      id: 'cm-barre',
      chordName: 'Cm',
      variationLabel: 'Barre (A-shape)',
      baseFret: 3,
      frets: ['x', 3, 5, 5, 4, 3],
      barre: { fret: 3, fromString: 1, toString: 5, finger: 1 },
      difficulty: 'hard',
      tags: ['barre'],
    }),
  ],
  Bb: [
    V({
      id: 'bb-barre',
      chordName: 'Bb',
      variationLabel: 'Barre (A-shape)',
      baseFret: 1,
      frets: ['x', 1, 3, 3, 3, 1],
      barre: { fret: 1, fromString: 1, toString: 5, finger: 1 },
      difficulty: 'hard',
      tags: ['barre'],
    }),
  ],
};

const OPEN_E_MAJOR: readonly number[] = [0, 2, 2, 1, 0, 0];
const OPEN_A_MINOR_SHAPE: readonly (number | 'x')[] = ['x', 0, 2, 2, 1, 0];

/** E (pc 4) on low string 0. */
export function movableMajorE(rootPc: number): ChordVoicing | null {
  const ePc = 4;
  const f = (rootPc - ePc + 12) % 12;
  if (f === 0) {
    return null;
  }
  if (f > 14) {
    return null;
  }
  const frets = OPEN_E_MAJOR.map((n) => (typeof n === 'number' ? n + f : n)) as ChordVoicing['frets'];
  return {
    id: `maj-e-${rootPc}-f${f}`,
    chordName: '',
    variationLabel: 'Barre (E-shape)',
    baseFret: f,
    frets,
    barre: { fret: f, fromString: 0, toString: 5, finger: 1 },
    difficulty: 'hard',
    tags: ['barre', 'movable', 'generated-movable'],
  };
}

const A_STRING_OPEN_PC = 9;

/** Root on A string (index 1); Am open shape. */
export function movableMinorA(rootPc: number): ChordVoicing | null {
  const f = (rootPc - A_STRING_OPEN_PC + 12) % 12;
  if (f === 0) {
    return null;
  }
  if (f > 12) {
    return null;
  }
  const frets = OPEN_A_MINOR_SHAPE.map((c) => {
    if (c === 'x') {
      return 'x' as const;
    }
    return (c as number) + f;
  }) as ChordVoicing['frets'];
  return {
    id: `min-a-${rootPc}-f${f}`,
    chordName: '',
    variationLabel: 'Barre (A-shape)',
    baseFret: f,
    frets,
    barre: { fret: f, fromString: 1, toString: 5, finger: 1 },
    difficulty: 'hard',
    tags: ['barre', 'movable', 'generated-movable'],
  };
}

/**
 * Diminished triad, root on A string at fret f (standard tuning):
 * (A+f), (A+f)+6, (A+f), (A+f)+3 on D,G,B — x f f+1 f+2 f+1 x
 */
export function movableDimA(rootPc: number): ChordVoicing | null {
  const f = (rootPc - A_STRING_OPEN_PC + 12) % 12;
  if (f > 9) {
    return null;
  }
  const frets: ChordVoicing['frets'] = ['x', f, f + 1, f + 2, f + 1, 'x'];
  if (frets.some((c) => typeof c === 'number' && c > 16)) {
    return null;
  }
  return {
    id: `dim-a-${rootPc}`,
    chordName: '',
    variationLabel: 'Compact',
    baseFret: Math.max(1, f),
    frets,
    fingers: [null, 1, 2, 4, 3, null],
    difficulty: 'medium',
    tags: ['compact', 'movable', 'generated-movable'],
  };
}

export function collectVoicingCandidates(chordName: string): ChordVoicing[] {
  const curated = CURATED_VOICINGS_BY_NAME[chordName];
  const out: ChordVoicing[] = [];

  if (curated) {
    for (const c of curated) {
      const tagSet = new Set<string>([...(c.tags ?? []), 'curated', 'known']);
      out.push({ ...c, chordName, tags: [...tagSet] });
    }
  }

  return out;
}

export function appendGeneratedVoicings(
  rootPc: number,
  quality: ChordQuality,
  chordName: string,
  existing: ChordVoicing[],
): ChordVoicing[] {
  const seen = new Set(existing.map((v) => v.frets.join(',')));
  const add = (v: ChordVoicing | null) => {
    if (!v) {
      return;
    }
    const key = v.frets.join(',');
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const tagSet = new Set<string>([...(v.tags ?? []), 'generated-movable']);
    existing.push({ ...v, chordName, tags: [...tagSet] });
  };

  if (quality === 'major') {
    add(movableMajorE(rootPc));
  } else if (quality === 'minor') {
    add(movableMinorA(rootPc));
  } else if (quality === 'dim') {
    add(movableDimA(rootPc));
  }

  return existing;
}
