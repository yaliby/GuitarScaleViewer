import type { ChordDisplayGroups, ChordDisplayVoicing, ChordVoicing } from './chordTypes';

const GROUP_ORDER: Record<'compact' | 'barre' | 'movable' | 'high', number> = {
  compact: 0,
  barre: 1,
  movable: 1,
  high: 2,
};
const TOO_SIMILAR_SHARED_STRINGS = 5;
const DIVERSITY_FAMILY_ORDER = ['open-compact', 'barre-movable', 'high-alternate'] as const;
type DiversityFamily = (typeof DIVERSITY_FAMILY_ORDER)[number];

function shapeToken(v: ChordVoicing): string {
  return v.frets
    .map((c) => {
      if (c === 'x') {
        return 'x';
      }
      if (c === 'o' || c === 0) {
        return '0';
      }
      return String(c);
    })
    .join('');
}

function minPressedFret(v: ChordVoicing): number {
  const nums: number[] = [];
  for (const c of v.frets) {
    if (typeof c === 'number' && c > 0) {
      nums.push(c);
    }
  }
  return nums.length ? Math.min(...nums) : 0;
}

function normalizedCells(v: ChordVoicing): readonly (string | number)[] {
  return v.frets.map((c) => {
    if (c === 'o' || c === 0) {
      return 0;
    }
    return c;
  });
}

function sharedStringCount(a: ChordDisplayVoicing, b: ChordDisplayVoicing): number {
  const aa = normalizedCells(a.voicing);
  const bb = normalizedCells(b.voicing);
  let shared = 0;
  for (let i = 0; i < 6; i++) {
    if (aa[i] === bb[i]) {
      shared += 1;
    }
  }
  return shared;
}

function isTooSimilar(candidate: ChordDisplayVoicing, selected: ChordDisplayVoicing[]): boolean {
  return selected.some((picked) => sharedStringCount(candidate, picked) >= TOO_SIMILAR_SHARED_STRINGS);
}

function classify(
  v: ChordVoicing,
): { group: 'compact' | 'barre' | 'movable' | 'high'; type: string; isFallback: boolean } {
  const tags = v.tags ?? [];
  const isSearch = tags.includes('search');
  const isOpen = tags.includes('open') || v.frets.some((c) => c === 'o' || c === 0);
  const isCompact = tags.includes('compact');
  const isBarre = Boolean(v.barre) || tags.includes('barre');
  const isMovable = tags.includes('movable') || tags.includes('generated-movable');
  const minF = minPressedFret(v);

  if (isOpen || isCompact) {
    if (isOpen && isCompact) {
      return { group: 'compact', type: 'Open / Compact', isFallback: isSearch };
    }
    return { group: 'compact', type: isOpen ? 'Open' : 'Compact', isFallback: isSearch };
  }
  if (isBarre || isMovable) {
    if (isBarre && isMovable) {
      return { group: isMovable ? 'movable' : 'barre', type: 'Barre / Movable', isFallback: isSearch };
    }
    return { group: isBarre ? 'barre' : 'movable', type: isBarre ? 'Barre' : 'Movable', isFallback: isSearch };
  }
  if (minF >= 7) {
    return { group: 'high', type: 'High', isFallback: isSearch };
  }
  return { group: isSearch ? 'movable' : 'compact', type: isSearch ? 'Found' : 'Voicing', isFallback: isSearch };
}

function diversityFamily(v: ChordDisplayVoicing): DiversityFamily {
  if (v.group === 'compact') {
    return 'open-compact';
  }
  if (v.group === 'barre' || v.group === 'movable') {
    return 'barre-movable';
  }
  return 'high-alternate';
}

function selectDiverseVoicings(
  ranked: ChordDisplayVoicing[],
  maxVoicingsPerChord: number,
): ChordDisplayVoicing[] {
  const selected: ChordDisplayVoicing[] = [];

  // Try to keep at least one representative per family if available.
  for (const family of DIVERSITY_FAMILY_ORDER) {
    const candidate = ranked.find(
      (v) => diversityFamily(v) === family && !selected.includes(v) && !isTooSimilar(v, selected),
    );
    if (candidate) {
      selected.push(candidate);
      if (selected.length >= maxVoicingsPerChord) {
        return selected;
      }
    }
  }

  // Fill remaining slots by rank while skipping near-duplicates.
  for (const v of ranked) {
    if (selected.includes(v)) {
      continue;
    }
    if (isTooSimilar(v, selected)) {
      continue;
    }
    selected.push(v);
    if (selected.length >= maxVoicingsPerChord) {
      break;
    }
  }

  return selected;
}

/**
 * UI-facing organization layer:
 * valid voicings -> rank -> diversity filter -> max N -> stable UI order.
 */
export function buildDisplayVoicings(
  voicings: ChordVoicing[],
  maxVoicingsPerChord: number = 4,
): ChordDisplayVoicing[] {
  const seen = new Set<string>();
  const out: ChordDisplayVoicing[] = [];

  for (const v of voicings) {
    const shape = shapeToken(v);
    if (seen.has(shape)) {
      continue;
    }
    seen.add(shape);
    const c = classify(v);
    out.push({
      voicing: v,
      shape,
      type: c.type,
      group: c.group,
      isFallback: c.isFallback,
      playable: true,
    });
  }

  const diverse = selectDiverseVoicings(out, maxVoicingsPerChord);

  diverse.sort((a, b) => {
    if (a.isFallback !== b.isFallback) {
      return a.isFallback ? 1 : -1;
    }
    const g = GROUP_ORDER[a.group] - GROUP_ORDER[b.group];
    if (g !== 0) {
      return g;
    }
    const am = minPressedFret(a.voicing);
    const bm = minPressedFret(b.voicing);
    if (am !== bm) {
      return am - bm;
    }
    return a.shape.localeCompare(b.shape);
  });

  return diverse;
}

export function buildDisplayGroups(voicings: ChordDisplayVoicing[]): ChordDisplayGroups {
  const groups: ChordDisplayGroups = {
    compact: [],
    barre: [],
    movable: [],
    high: [],
  };
  for (const v of voicings) {
    groups[v.group].push(v);
  }
  return groups;
}

