/**
 * Attach voicings to scale chords; filter / rank by tuning, capo, playability.
 */

import type { ScaleChord, ScaleChordWithVoicings, ChordVoicing } from './chordTypes';
import {
  appendGeneratedVoicings,
  collectVoicingCandidates,
} from './chordVoicingLibrary';
import { searchVoicingsForPitchClasses } from './voicingSearch';
import { evaluateVoicingPlayability } from './playability';
import {
  countInnerMutes,
  distinctPressedFretCount,
  idiomaticQuality01,
  isAdjacentSoundedBlock,
  soundedStringCount,
} from './voicingHeuristics';
import { buildDisplayGroups, buildDisplayVoicings } from './displayVoicingGroups';

const STANDARD_OPEN_PCS: readonly number[] = [4, 9, 2, 7, 11, 4];

function fretToPc(openStringPcs: readonly number[], stringIndex: number, fret: number): number {
  const o = openStringPcs[stringIndex];
  if (o === undefined) {
    return 0;
  }
  return (o + fret) % 12;
}

function voicingMaxFret(v: ChordVoicing): number {
  let m = 0;
  for (const c of v.frets) {
    if (typeof c === 'number') {
      m = Math.max(m, c);
    }
  }
  return m;
}

/**
 * Every sounded string must spell a pitch class in `allowed` (triad tones).
 */
function voicingMatchesChord(
  v: ChordVoicing,
  openStringPcs: readonly number[],
  chordPcs: ReadonlySet<number>,
  capo: number,
): boolean {
  for (let s = 0; s < 6; s++) {
    const cell = v.frets[s];
    if (cell === 'x') {
      continue;
    }
    const fret =
      cell === 'o'
        ? capo
        : typeof cell === 'number'
          ? cell === 0 && capo > 0
            ? capo
            : cell
          : 0;
    const pc = fretToPc(openStringPcs, s, fret);
    if (!chordPcs.has(pc)) {
      return false;
    }
  }
  return true;
}

function voicingFitsCapo(v: ChordVoicing, capo: number, numFrets: number): boolean {
  let maxAbs = 0;
  for (const c of v.frets) {
    if (c === 'x') {
      continue;
    }
    const abs =
      c === 'o'
        ? capo
        : typeof c === 'number'
          ? c === 0 && capo > 0
            ? capo
            : c
          : 0;
    maxAbs = Math.max(maxAbs, abs);
  }
  if (maxAbs > numFrets) {
    return false;
  }
  if (capo <= 0) {
    return true;
  }
  for (const c of v.frets) {
    if (typeof c === 'number' && c > 0 && c < capo) {
      return false;
    }
  }
  return true;
}

function rankScore(v: ChordVoicing, capo: number): number {
  const tags = v.tags ?? [];
  let score = 0;

  const isKnown = tags.includes('known') || tags.includes('curated');
  const isGenMovable = tags.includes('generated-movable');
  const isSearch = tags.includes('search');
  const nSounded = soundedStringCount(v);
  const adjacentBlock = isAdjacentSoundedBlock(v);
  const compactAdjacentTriad =
    tags.includes('compact') && adjacentBlock && nSounded >= 3 && nSounded <= 4;

  if (isKnown) {
    score += 6500;
  } else if (isGenMovable && (v.barre || tags.includes('barre'))) {
    score += 2800;
  } else if (isGenMovable) {
    score += 2200;
  } else if (compactAdjacentTriad) {
    score += 1500;
  } else if (isSearch) {
    const idiom = idiomaticQuality01(v);
    score += -5600 + idiom * 5000;
  }

  if (tags.includes('open')) {
    score += 200;
  }
  if (tags.includes('compact')) {
    score += 120;
  }
  if (v.barre || tags.includes('barre')) {
    score += 140;
  }
  if (adjacentBlock && nSounded >= 3 && nSounded <= 4) {
    score += 160;
  }

  if (isSearch) {
    if (!adjacentBlock && nSounded >= 3) {
      score -= 320;
    }
    if (countInnerMutes(v) > 0) {
      score -= 280;
    }
    const df = distinctPressedFretCount(v);
    if (df >= 4) {
      score -= 200;
    }
    if (df >= 5) {
      score -= 140;
    }
  } else if (!isKnown) {
    if (!adjacentBlock && nSounded >= 3) {
      score -= 110;
    }
    if (countInnerMutes(v) > 0) {
      score -= 85;
    }
  }

  if (tags.includes('movable') && !isSearch) {
    score += 40;
  }
  if (v.difficulty === 'easy') {
    score += 24;
  } else if (v.difficulty === 'medium') {
    score += 12;
  }

  if (v.playability) {
    score += v.playability.playabilityScore;
  }
  score -= voicingMaxFret(v) * 0.35;
  score -= capo * 0.12;
  return score;
}

export type ResolveOptions = {
  tuningId: string;
  openStringPcs: readonly number[];
  capo: number;
  numFrets?: number;
};

export function resolveChordVoicings(
  chords: ScaleChord[],
  opts: ResolveOptions,
): ScaleChordWithVoicings[] {
  const numFrets = opts.numFrets ?? 24;
  const capo = Math.max(0, opts.capo);
  const isStandard = opts.tuningId === 'standard';
  const open = isStandard ? STANDARD_OPEN_PCS : opts.openStringPcs;

  return chords.map((ch) => {
    const chordPcs = new Set(ch.chordPitchClasses);
    let list = collectVoicingCandidates(ch.chordName);

    if (isStandard) {
      list = appendGeneratedVoicings(ch.rootPitchClass, ch.quality, ch.chordName, list);
    }

    const seenFrets = new Set(list.map((v) => v.frets.join(',')));
    const generated = searchVoicingsForPitchClasses(open, chordPcs, {
      maxFret: Math.min(17, numFrets - 1),
      minAbsoluteFret: capo,
      capoFret: capo,
      maxResults: 20,
    });
    for (const g of generated) {
      const key = g.frets.join(',');
      if (!seenFrets.has(key)) {
        seenFrets.add(key);
        list.push({ ...g, chordName: ch.chordName });
      }
    }

    const filtered = list.filter(
      (v) =>
        voicingMatchesChord(v, open, chordPcs, capo) && voicingFitsCapo(v, capo, numFrets),
    );

    const playable: ChordVoicing[] = [];
    for (const v of filtered) {
      const playability = evaluateVoicingPlayability(v);
      if (!playability.playable) {
        continue;
      }
      playable.push({
        ...v,
        difficulty: playability.difficulty,
        playability,
      });
    }

    playable.sort((a, b) => rankScore(b, capo) - rankScore(a, capo));

    const voicings = playable.length > 0 ? playable : [];
    const displayVoicings = buildDisplayVoicings(voicings, 4);
    const groups = buildDisplayGroups(displayVoicings);

    return { ...ch, voicings, displayVoicings, groups };
  });
}
