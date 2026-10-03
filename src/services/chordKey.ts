import type { KeyMode } from './keyFusion';

/**
 * A song's key read off its chords — the chart-key model of ChordSync's `key_detect.py`, ported.
 *
 * Each of the 24 keys is scored by a linear model over what the chords say about its home chord:
 * how well they fit the key's usual harmony, whether lines and sections open, close and cadence on
 * its tonic, and how many chords hold the tonic note. Where phrases start and come to rest matters
 * as much as which chords occur, so the input is sections of lines of chords.
 *
 * It is here, and not only in the sidecar, because two legs of the key pipeline speak in chords:
 * the chart scraped from Tab4U / Ultimate Guitar, and the chords the recogniser reads off the saved
 * copy of the recording. Both go through one model, and the neck needs more from it than the
 * sidecar's argmax — it needs the model's probabilities, to weigh a chart against the engine.
 *
 * The constants are `key_detect.py`'s, printed from it rather than retyped; `chordKey.test.ts` holds
 * the port to the Python's own scores. They were fitted together on the McGill Billboard chord
 * annotations by `scripts/key-research/emit_chart_key.py`: change a feature and both must be refit.
 * Measured out of fold by `scripts/key-research/exp_chart_advice.py` (739 songs, 5-fold by song):
 *
 * ```text
 *                              tonic     key   note set
 *   a chart                    89.0%   88.8%     89.2%
 *   four-bar lines, no phrases 85.1%   84.8%     86.1%
 *   ... with 20% misread       82.3%   81.8%     84.2%
 *   profile match (rhythm.ts)  78.3%   76.6%     80.7%
 * ```
 *
 * The softmax of the scores is the fitted model's own probability (it was trained as one), and it
 * reads as one: the argmax's seven notes are right 98-99% of the time when the model puts 95% or
 * more on them, 83-89% at 80-95%, and a coin flip below 50%.
 */

export type ChordQuality = 'M' | 'm' | 'd' | 'a' | 'x';

export type ChordToken = {
  pc: number;
  /** Major, minor, diminished, augmented, or `x` for a chord without a third (power, sus). */
  quality: ChordQuality;
  /** A major chord with a minor seventh: 7, 9, 11, 13. */
  dominantSeventh: boolean;
};

/** Sections of lines of chord symbols, as a chart prints them. Empty or null entries are skipped. */
export type ChordSections = Iterable<Iterable<Iterable<string | null | undefined>>>;

const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const ALIAS: Readonly<Record<string, number>> = {
  Db: 1,
  Eb: 3,
  Gb: 6,
  Ab: 8,
  Bb: 10,
  Cb: 11,
  Fb: 4,
  'E#': 5,
  'B#': 0,
};
const CHORD_RE = /^\(?([A-G][#b]?)(.*)$/;
const TONES: Readonly<Record<ChordQuality, readonly number[]>> = {
  M: [0, 4, 7],
  m: [0, 3, 7],
  d: [0, 3, 6],
  a: [0, 4, 8],
  x: [0, 7],
};
const SECTION_PRIOR = 4;

export const FEATURES = [
  'fit',
  'tonic_share',
  'end_dominant',
  'v_to_i',
  'iv_to_i',
  'absent',
  'v7_share',
  'first_tonic',
  'start_tonic',
  'sec_start_tonic',
  'end_tonic',
  'sec_end_tonic',
  'last_tonic',
  'tonic_note',
  'sec_end_dominant',
  'root_share',
  'bvi_to_i',
] as const;

type Feature = (typeof FEATURES)[number];

/** log P(chord root interval above the tonic, quality | major), then | minor; unlisted roles get the floor. */
// prettier-ignore
const ROLE_LOGP: readonly [Readonly<Record<string, number>>, Readonly<Record<string, number>>] = [
  {
    '0M': -1.13, '0a': -8.03, '0d': -8.5, '0m': -5.04, '1M': -5.39, '1a': -9.42,
    '1d': -7.58, '1m': -8.16, '2M': -3.87, '2d': -6.71, '2m': -2.88, '3M': -4.25,
    '3a': -9.7, '3d': -7.62, '3m': -6.55, '4M': -4.92, '4a': -7.97, '4d': -8.03,
    '4m': -3.55, '5M': -1.56, '5a': -9.01, '5d': -8.24, '5m': -4.39, '6M': -5.64,
    '6a': -9.19, '6d': -6.67, '6m': -7.3, '7M': -1.81, '7a': -8.4, '7d': -9.01,
    '7m': -4.68, '8M': -4.51, '8a': -9.7, '8d': -7.37, '8m': -7.02, '9M': -4.56,
    '9d': -7.76, '9m': -2.84, '10M': -3.13, '10d': -8.86, '10m': -6.61, '11M': -5.86,
    '11a': -8.86, '11d': -7.4, '11m': -6.3,
  },
  {
    '0M': -3.97, '0m': -1.19, '1M': -4.9, '1d': -7.69, '1m': -6.52, '2M': -4.42,
    '2d': -6.04, '2m': -4.62, '3M': -2.56, '3m': -5.86, '4M': -6.73, '4d': -8.2,
    '4m': -6.52, '5M': -2.6, '5d': -7.5, '5m': -2.6, '6M': -6.0, '7M': -2.91,
    '7a': -5.33, '7d': -6.81, '7m': -2.95, '8M': -2.0, '8d': -7.69, '8m': -6.73,
    '9M': -6.66, '9d': -7.69, '9m': -4.87, '10M': -1.96, '10a': -7.69, '10m': -5.45,
    '11M': -6.52, '11d': -7.69, '11m': -6.3,
  },
];
const ROLE_LOGP_FLOOR = -10.11;
const WEIGHTS: readonly number[] = [
  1.449, // fit
  13.18, // tonic_share
  1.136, // end_dominant
  6.113, // v_to_i
  5.236, // iv_to_i
  -2.119, // absent
  3.818, // v7_share
  1.014, // first_tonic
  -0.446, // start_tonic
  4.031, // sec_start_tonic
  1.403, // end_tonic
  1.761, // sec_end_tonic
  0.1657, // last_tonic
  2.743, // tonic_note
  2.141, // sec_end_dominant
  -14.75, // root_share
  2.334, // bvi_to_i
];

/** Root pitch class, triad quality, and whether the chord is a dominant seventh. */
export function parseChordSymbol(symbol: string): ChordToken | null {
  const match = CHORD_RE.exec(symbol.trim());
  if (!match) {
    return null;
  }
  const root = match[1]!;
  const pc = ALIAS[root] ?? SHARP.indexOf(root as (typeof SHARP)[number]);
  if (pc < 0) {
    return null;
  }
  const rest = trimParens(match[2]!.split('/', 1)[0]!);
  const low = rest.toLowerCase();
  let quality: ChordQuality;
  if (['dim', '°', 'ø', 'm7b5', 'm7-5'].some((p) => low.startsWith(p)) || /^o(\d|$)/.test(rest)) {
    quality = 'd';
  } else if (low.startsWith('aug') || low.startsWith('+')) {
    quality = 'a';
  } else if (['maj', 'Maj', 'M', 'Δ'].some((p) => rest.startsWith(p))) {
    quality = 'M';
  } else if (rest.startsWith('m') || rest.startsWith('-')) {
    quality = 'm';
  } else if (/^(5|sus|2(?!\d)|4(?!\d)|no3)/.test(low)) {
    quality = 'x';
  } else {
    quality = 'M';
  }
  return { pc, quality, dominantSeventh: quality === 'M' && /^(7|9|11|13)/.test(rest) };
}

/** Python's `str.strip("()")`. */
function trimParens(value: string): string {
  return value.replace(/^[()]+/, '').replace(/[()]+$/, '');
}

function roleLogP(table: Readonly<Record<string, number>>, interval: number, quality: ChordQuality): number {
  if (quality === 'x') {
    return Math.max(table[`${interval}M`] ?? ROLE_LOGP_FLOOR, table[`${interval}m`] ?? ROLE_LOGP_FLOOR);
  }
  return table[`${interval}${quality}`] ?? ROLE_LOGP_FLOOR;
}

type Triad = { pc: number; quality: ChordQuality };

const sameTriad = (a: Triad, b: Triad) => a.pc === b.pc && a.quality === b.quality;
const share = (hits: number, of: number) => hits / of;

/** One row of `FEATURES` per candidate key, indexed `2 * tonic + minor`; null without chords. */
export function chordKeyFeatures(sections: ChordSections): number[][] | null {
  const secs: ChordToken[][][] = [];
  for (const section of sections) {
    const lines: ChordToken[][] = [];
    for (const line of section) {
      const phrase: ChordToken[] = [];
      for (const chord of line) {
        const token = chord ? parseChordSymbol(chord) : null;
        if (token) phrase.push(token);
      }
      if (phrase.length) lines.push(phrase);
    }
    if (lines.length) secs.push(lines);
  }
  if (!secs.length) {
    return null;
  }
  const phrases = secs.flat();
  const seq = phrases.flat();
  const triads: Triad[] = seq.map(({ pc, quality }) => ({ pc, quality }));
  const n = triads.length;
  // Insertion-ordered like Python's Counter, so the sums below add in the same order.
  const counts = new Map<string, { triad: Triad; count: number }>();
  for (const triad of triads) {
    const id = `${triad.pc}${triad.quality}`;
    const entry = counts.get(id);
    if (entry) entry.count += 1;
    else counts.set(id, { triad, count: 1 });
  }
  const changes: [Triad, Triad][] = [];
  for (let i = 1; i < triads.length; i += 1) {
    if (!sameTriad(triads[i - 1]!, triads[i]!)) changes.push([triads[i - 1]!, triads[i]!]);
  }
  const nChanges = Math.max(changes.length, 1);
  const starts = phrases.map((phrase) => phrase[0]!);
  const ends = phrases.map((phrase) => phrase[phrase.length - 1]!);
  const secStarts = secs.map((sec) => sec[0]![0]!);
  const secEnds = secs.map((sec) => {
    const last = sec[sec.length - 1]!;
    return last[last.length - 1]!;
  });
  const sevenths = new Map<number, number>();
  for (const token of seq) {
    if (token.dominantSeventh) sevenths.set(token.pc, (sevenths.get(token.pc) ?? 0) + 1);
  }
  const holding = Array<number>(12).fill(0);
  for (const { triad, count } of counts.values()) {
    for (const interval of TONES[triad.quality]) holding[(triad.pc + interval) % 12]! += count;
  }

  // Tab4U charts label one or two sections where the fitting corpus labels about nine, so a
  // section statistic leans on its line-level counterpart until there are sections to trust.
  const bySection = (sectionShare: number, lineShare: number) =>
    (secs.length * sectionShare + SECTION_PRIOR * lineShare) / (secs.length + SECTION_PRIOR);
  const count = <T>(items: readonly T[], test: (item: T) => boolean) => items.filter(test).length;

  const rows: number[][] = [];
  for (let tonic = 0; tonic < 12; tonic += 1) {
    const dom = (tonic + 7) % 12;
    const sub = (tonic + 5) % 12;
    const flat6 = (tonic + 8) % 12;
    // Where phrases rest and resolve is judged by the tonic's root: songs move between the major
    // and minor chord on it (Am … A), and the mode is left to the chord vocabulary.
    const onTonic = (c: Triad) => c.pc === tonic && (c.quality === 'M' || c.quality === 'm' || c.quality === 'x');
    const isDom = (c: Triad) => c.pc === dom && (c.quality === 'M' || c.quality === 'x');
    const intoTonic = (from: (c: Triad) => boolean) =>
      changes.filter(([a, b]) => onTonic(b) && from(a)).length / nChanges;

    const startTonic = share(count(starts, onTonic), starts.length);
    const endTonic = share(count(ends, onTonic), ends.length);
    const endDominant = share(count(ends, isDom), ends.length);
    let rootHits = 0;
    for (const { triad, count: k } of counts.values()) if (onTonic(triad)) rootHits += k;
    const eitherMode: Omit<Record<Feature, number>, 'fit' | 'tonic_share' | 'absent'> = {
      end_dominant: endDominant,
      v_to_i: intoTonic(isDom),
      iv_to_i: intoTonic((c) => c.pc === sub && (c.quality === 'M' || c.quality === 'm' || c.quality === 'x')),
      v7_share: (sevenths.get(dom) ?? 0) / n,
      first_tonic: onTonic(triads[0]!) ? 1 : 0,
      start_tonic: startTonic,
      sec_start_tonic: bySection(share(count(secStarts, onTonic), secs.length), startTonic),
      end_tonic: endTonic,
      sec_end_tonic: bySection(share(count(secEnds, onTonic), secs.length), endTonic),
      last_tonic: onTonic(triads[n - 1]!) ? 1 : 0,
      tonic_note: holding[tonic]! / n,
      sec_end_dominant: bySection(share(count(secEnds, isDom), secs.length), endDominant),
      root_share: rootHits / n,
      bvi_to_i: intoTonic((c) => c.pc === flat6 && (c.quality === 'M' || c.quality === 'x')),
    };
    for (const minor of [false, true]) {
      const home: ChordQuality = minor ? 'm' : 'M';
      const table = ROLE_LOGP[minor ? 1 : 0];
      let hits = 0;
      let fit = 0;
      for (const { triad, count: k } of counts.values()) {
        if (triad.pc === tonic && (triad.quality === home || triad.quality === 'x')) hits += k;
        fit += k * roleLogP(table, (((triad.pc - tonic) % 12) + 12) % 12, triad.quality);
      }
      const values: Record<Feature, number> = {
        ...eitherMode,
        fit: fit / n,
        tonic_share: hits / n,
        absent: hits === 0 ? 1 : 0,
      };
      rows.push(FEATURES.map((name) => values[name]));
    }
  }
  return rows;
}

/** The model's score for each of the 24 keys, indexed `2 * tonic + minor`; null without chords. */
export function chordKeyScores(sections: ChordSections): number[] | null {
  const rows = chordKeyFeatures(sections);
  if (!rows) {
    return null;
  }
  return rows.map((row) => row.reduce((sum, value, i) => sum + WEIGHTS[i]! * value, 0));
}

export type ChordKeyReading = {
  pc: number;
  mode: KeyMode;
  /** The model's probability for each of the 24 keys, indexed `2 * tonic + minor`. */
  probabilities: number[];
  /** What the model puts on the argmax's seven notes: the key and its relative together. */
  noteSetMass: number;
  /** The larger end's share of that mass — how firmly the chords name which of the two is home. */
  tonicShare: number;
};

/** Index of a key's relative in the `2 * tonic + minor` layout: C major <-> A minor. */
export function relativeIndex(index: number): number {
  const tonic = Math.floor(index / 2);
  return index % 2 === 1 ? 2 * ((tonic + 3) % 12) : 2 * ((tonic + 9) % 12) + 1;
}

/** Read the key off a probability vector in the `2 * tonic + minor` layout. */
export function readingFromProbabilities(probabilities: number[]): ChordKeyReading {
  // First maximum, as Python's `max(range(...), key=...)` picks it.
  let best = 0;
  probabilities.forEach((p, i) => {
    if (p > probabilities[best]!) best = i;
  });
  const relative = relativeIndex(best);
  const mass = probabilities[best]! + probabilities[relative]!;
  return {
    pc: Math.floor(best / 2),
    mode: best % 2 === 1 ? 'minor' : 'major',
    probabilities,
    noteSetMass: mass,
    tonicShare: mass > 0 ? probabilities[best]! / mass : 0.5,
  };
}

/** The key the chords name, with the probabilities behind it; null when there are no chords. */
export function readChordKey(sections: ChordSections): ChordKeyReading | null {
  const scores = chordKeyScores(sections);
  if (!scores) {
    return null;
  }
  const top = Math.max(...scores);
  const weights = scores.map((score) => Math.exp(score - top));
  const total = weights.reduce((sum, w) => sum + w, 0);
  return readingFromProbabilities(weights.map((w) => w / total));
}
