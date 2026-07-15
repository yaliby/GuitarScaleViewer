/**
 * Generic voicing finder: any set of pitch classes × any 6-string open-string tuning.
 * DFS with per-string pruning — used when curated / template voicings miss a shape.
 */

import type { ChordVoicing, FretCell } from './chordTypes';

export type VoicingSearchOptions = {
  maxFret?: number;
  /**
   * All fretted notes must be >= this (use `capo` when diagrams are absolute:
   * frets 1‒capo−1 are not playable in front of the capo).
   */
  minAbsoluteFret?: number;
  /** Open strings are evaluated at this effective fret (capo). */
  capoFret?: number;
  /** If true (default for 3-note chords), every chord tone must appear on at least one sounded string. */
  requireAllChordTones?: boolean;
  minStrings?: number;
  maxResults?: number;
};

function pcAtFret(openPc: number, fret: number): number {
  return (openPc + fret) % 12;
}

function soundedPcs(
  frets: ChordVoicing['frets'],
  openStringPcs: readonly number[],
  capoFret: number,
): number[] {
  const out: number[] = [];
  for (let s = 0; s < 6; s++) {
    const cell = frets[s];
    if (cell === 'x') {
      continue;
    }
    const fret =
      cell === 'o'
        ? capoFret
        : typeof cell === 'number'
          ? cell === 0 && capoFret > 0
            ? capoFret
            : cell
          : 0;
    const o = openStringPcs[s];
    if (o === undefined) {
      continue;
    }
    out.push(pcAtFret(o, fret));
  }
  return out;
}

function coversAllChordTones(
  frets: ChordVoicing['frets'],
  openStringPcs: readonly number[],
  chordPcs: ReadonlySet<number>,
  capoFret: number,
): boolean {
  const heard = new Set(soundedPcs(frets, openStringPcs, capoFret));
  for (const pc of chordPcs) {
    if (!heard.has(pc)) {
      return false;
    }
  }
  return true;
}

type CellOption = { cell: FretCell };

/** Cap fretted options per string so DFS stays bounded; prefer lower positions. */
const MAX_FRETTED_CHOICES_PER_STRING = 5;

function stringCellOptions(
  stringIndex: number,
  openStringPcs: readonly number[],
  chordPcs: ReadonlySet<number>,
  maxFret: number,
  fretMin?: number,
  fretMax?: number,
  minAbsoluteFret: number = 0,
  capoFret: number = 0,
): CellOption[] {
  const o = openStringPcs[stringIndex];
  if (o === undefined) {
    return [{ cell: 'x' }];
  }
  const lo = fretMin ?? 0;
  const hi = fretMax ?? maxFret;
  const opts: CellOption[] = [{ cell: 'x' }];
  const openPc = pcAtFret(o, capoFret);
  if (lo <= 0 && chordPcs.has(openPc)) {
    opts.push({ cell: 'o' });
  }
  const fretted: number[] = [];
  const fLow = Math.max(1, lo, minAbsoluteFret);
  for (let f = fLow; f <= Math.min(maxFret, hi); f++) {
    if (chordPcs.has(pcAtFret(o, f))) {
      fretted.push(f);
    }
  }
  const take = fretted.slice(0, MAX_FRETTED_CHOICES_PER_STRING);
  for (const f of take) {
    opts.push({ cell: f });
  }
  return opts;
}

function baseFretFromFrets(frets: ChordVoicing['frets']): number {
  const nums: number[] = [];
  for (const c of frets) {
    if (c === 'x' || c === 'o') {
      continue;
    }
    if (typeof c === 'number') {
      nums.push(c);
    }
  }
  if (nums.length === 0) {
    return 1;
  }
  const hasOpen = frets.some((c) => c === 'o' || c === 0);
  const minF = Math.min(...nums);
  if (hasOpen) {
    return 1;
  }
  return Math.max(1, minF);
}

/**
 * Returns up to `maxResults` voicings whose sounded notes are subset of `chordPcs`,
 * optionally requiring every pitch class in `chordPcs` to be heard.
 */
export function searchVoicingsForPitchClasses(
  openStringPcs: readonly number[],
  chordPcs: ReadonlySet<number>,
  options: VoicingSearchOptions = {},
): ChordVoicing[] {
  if (chordPcs.size === 0) {
    return [];
  }
  const maxFret = options.maxFret ?? 12;
  const minAbs = Math.max(0, options.minAbsoluteFret ?? 0);
  const capoFret = Math.max(0, options.capoFret ?? 0);
  const minStrings = options.minStrings ?? 3;
  const maxResults = options.maxResults ?? 16;
  /** Allow collecting extra candidates per window; trim after sort. */
  const maxCollection = Math.max(maxResults, minAbs > 0 ? maxResults * 3 : maxResults);
  const requireAll =
    options.requireAllChordTones !== undefined
      ? options.requireAllChordTones
      : chordPcs.size >= 2;

  const out: ChordVoicing[] = [];
  const seen = new Set<string>();
  const frets: FretCell[] = ['x', 'x', 'x', 'x', 'x', 'x'];

  function tryWindow(fretMin: number, fretMax: number): void {
    const byString: CellOption[][] = [];
    for (let s = 0; s < 6; s++) {
      byString.push(
        stringCellOptions(s, openStringPcs, chordPcs, maxFret, fretMin, fretMax, minAbs, capoFret),
      );
    }

    function dfs(si: number): void {
      if (out.length >= maxCollection) {
        return;
      }
      if (si === 6) {
        let n = 0;
        for (const c of frets) {
          if (c !== 'x') {
            n++;
          }
        }
        if (n < minStrings) {
          return;
        }
        if (
          requireAll &&
          !coversAllChordTones(
            frets as ChordVoicing['frets'],
            openStringPcs,
            chordPcs,
            capoFret,
          )
        ) {
          return;
        }
        const key = frets.join(',');
        if (seen.has(key)) {
          return;
        }
        seen.add(key);
        const v: ChordVoicing = {
          id: `search-${key.replace(/[^0-9ox,\\-]/g, '').slice(0, 48)}`,
          chordName: '',
          variationLabel: 'Found',
          baseFret: baseFretFromFrets(frets as ChordVoicing['frets']),
          frets: [...frets] as ChordVoicing['frets'],
          difficulty: 'medium',
          tags: ['search', 'compact'],
        };
        out.push(v);
        return;
      }
      for (const opt of byString[si] ?? []) {
        frets[si] = opt.cell;
        dfs(si + 1);
        if (out.length >= maxCollection) {
          return;
        }
      }
    }

    dfs(0);
  }

  if (minAbs > 0) {
    for (const span of [2, 3, 4, 5] as const) {
      if (minAbs + span <= maxFret) {
        tryWindow(minAbs, minAbs + span);
      }
    }
    for (let w = minAbs; w <= maxFret - 2; w++) {
      for (const span of [2, 3, 4] as const) {
        if (w + span <= maxFret) {
          tryWindow(w, w + span);
        }
      }
    }
  } else {
    for (const hi of [3, 4, 5] as const) {
      tryWindow(0, hi);
    }
    for (let w = 1; w <= maxFret - 2; w++) {
      for (const span of [2, 3, 4] as const) {
        if (w + span <= maxFret) {
          tryWindow(w, w + span);
        }
      }
    }
  }

  out.sort((a, b) => {
    const span = (v: ChordVoicing) => {
      const nums = v.frets.filter((c): c is number => typeof c === 'number' && c > 0);
      if (nums.length === 0) {
        return 0;
      }
      return Math.max(...nums) - Math.min(...nums);
    };
    const d = span(a) - span(b);
    if (d !== 0) {
      return d;
    }
    const maxF = (v: ChordVoicing) => Math.max(...v.frets.map((c) => (typeof c === 'number' ? c : 0)));
    return maxF(a) - maxF(b);
  });

  return out.slice(0, maxResults);
}
