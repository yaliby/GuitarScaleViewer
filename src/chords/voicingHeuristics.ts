import type { ChordVoicing } from './chordTypes';

/** Indices 0–5 where the string is not fully muted. */
export function soundedStringIndices(v: ChordVoicing): number[] {
  const out: number[] = [];
  for (let s = 0; s < 6; s++) {
    const c = v.frets[s];
    if (c === undefined) {
      continue;
    }
    if (c !== 'x') {
      out.push(s);
    }
  }
  return out;
}

export function soundedStringCount(v: ChordVoicing): number {
  return soundedStringIndices(v).length;
}

/** `x` between the outermost sounded strings. */
export function countInnerMutes(v: ChordVoicing): number {
  const idx = soundedStringIndices(v);
  if (idx.length === 0) {
    return 0;
  }
  const lo = Math.min(...idx);
  const hi = Math.max(...idx);
  let n = 0;
  for (let s = lo + 1; s < hi; s++) {
    if (v.frets[s] === 'x') {
      n++;
    }
  }
  return n;
}

/** All sounded strings occupy one consecutive index run (no skipped strings inside the block). */
export function isAdjacentSoundedBlock(v: ChordVoicing): boolean {
  const idx = soundedStringIndices(v);
  if (idx.length <= 1) {
    return true;
  }
  const sorted = [...idx].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! - sorted[i - 1]! !== 1) {
      return false;
    }
  }
  return true;
}

/** Count of distinct positive fretted fret numbers (not `o` / 0). */
export function distinctPressedFretCount(v: ChordVoicing): number {
  const set = new Set<number>();
  for (const c of v.frets) {
    if (typeof c === 'number' && c > 0) {
      set.add(c);
    }
  }
  return set.size;
}

function numericFrets(v: ChordVoicing): number[] {
  const out: number[] = [];
  for (const c of v.frets) {
    if (typeof c === 'number' && c > 0) {
      out.push(c);
    }
  }
  return out;
}

/** 0 = awkward / jumpy, 1 = very idiomatic compact grip. */
export function idiomaticQuality01(v: ChordVoicing): number {
  let q = 0.35;
  const nSound = soundedStringCount(v);
  const adjacent = isAdjacentSoundedBlock(v);
  const inner = countInnerMutes(v);
  const frets = numericFrets(v);
  const span = frets.length ? Math.max(...frets) - Math.min(...frets) : 0;
  const distinct = distinctPressedFretCount(v);

  if (adjacent && (nSound === 3 || nSound === 4)) {
    q += 0.28;
  } else if (adjacent && nSound >= 3) {
    q += 0.12;
  } else if (nSound >= 3) {
    q -= 0.18;
  }

  if (inner === 0) {
    q += 0.18;
  } else {
    q -= Math.min(0.35, inner * 0.12);
  }

  if (span <= 2) {
    q += 0.12;
  } else if (span <= 3) {
    q += 0.06;
  } else if (span >= 5) {
    q -= 0.12;
  }

  if (distinct <= 3) {
    q += 0.1;
  } else if (distinct >= 5) {
    q -= 0.1;
  }

  if (v.barre || (v.tags ?? []).includes('barre')) {
    q += 0.06;
  }

  return Math.max(0, Math.min(1, q));
}
