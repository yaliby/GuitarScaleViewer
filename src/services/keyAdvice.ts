import type { ScrapedChart } from '../playalong/types';
import { pitchClassForNoteLabel } from '../scaleSpell';
import { readChordKey, readingFromProbabilities, type ChordKeyReading } from './chordKey';
import type { KeyMode } from './keyFusion';
import { pitchClassToKey } from './keyParse';

/**
 * What the chords say about the key, before the engine has heard enough to say it — and beside it
 * once it has.
 *
 * Two legs speak in chords. The **chart** ChordSync scrapes from Tab4U / Ultimate Guitar arrives
 * seconds after a song starts, long before the engine's first reading. The **recording** — the chords
 * the recogniser reads off the saved copy of the song — arrives a minute or two in, or at once for a
 * song read before. Both go through the chart-key model (`chordKey.ts`), and both are *advice*:
 * `keyFusion.ts` puts it on the neck while nothing else has spoken, lets it name the root when the
 * engine hears the same seven notes, and lets the engine overrule it once the engine is more likely
 * to be right than it is. It never outranks a person.
 *
 * Chords and audio are good at different halves of the question. The engine decides the seven notes
 * well and the root badly: 22 of its 24 misses on the 72-clip corpus are the relative. Chords decide
 * the root from where phrases rest and resolve, which is exactly what the tone profile cannot hear —
 * out of fold on the Billboard annotations, when the model's notes are right its root is right for
 * 99.4% of songs (`scripts/key-research/exp_chart_advice.py`).
 */

export type AdviceSource = 'chart' | 'recording';

export type KeyAdvice = {
  key: string;
  mode: KeyMode;
  /**
   * The probability that these seven notes are the recording's — the model's own, discounted for
   * what it cannot see (see `CHART_APPLIES`, `RECORDING_APPLIES`). Comparable with the engine's
   * calibrated `noteSetEvidence.confidence`: when the two disagree about the notes, the likelier
   * one is whichever number is larger.
   */
  noteSetP: number;
  /** How firmly the chords name which end of the relative pair is home: 0.5 a coin flip, 1 certain. */
  tonicShare: number;
  /** The legs behind it, best first. Two legs appear only when they agree on the notes. */
  sources: AdviceSource[];
  /** The track the chords were read for. `fuseKey` ignores advice about any other. */
  trackIdentity: string | null;
  /** Machine-readable reason, mirrored into the trace log. */
  why: string;
};

/**
 * How often a scraped chart is written in the recording's key at all.
 *
 * The model is measured on charts that are right by construction: Billboard's annotations were
 * transcribed from the recordings they describe. A scraped chart can be another song, a simplified
 * or transposed version, or a capo chart that says nothing about the capo — none of which the chords
 * can reveal. This is the one number in the advice that is **not measured**: there is no corpus of
 * scraped charts against the recordings they were found for yet. It is set so that a decisive chart
 * (model mass 0.99) is worth p = 0.79, just above `key_confidence::CONFIDENT_NOTE_SET_P` — the engine
 * overrules a chart it disagrees with from the moment it would call its own reading confident.
 * The `advice.*` trace events are what a measurement of it would be built from.
 */
export const CHART_APPLIES = 0.8;

/**
 * How often the recogniser's chords describe the recording playing, by how the copy was found.
 *
 * A copy saved from the URL that is playing, or from the file itself, is the recording: what is left
 * is the recogniser's own error, and the model's mass already prices that — with a fifth of the chord
 * changes misread, mass 0.90-0.95 was right 95.9% of the time and 0.95-0.99 99.4%. The discount keeps
 * room for errors the simulation did not model, and for a song that modulates, whose global key the
 * recording names while the engine hears the passage playing. A YouTube *search* match can be
 * another cut — a live take, a cover — so it is discounted like a chart that may not apply.
 */
export const RECORDING_APPLIES = { exact: 0.95, searched: 0.85 } as const;

/** Beyond this share of the relative pair, the chords' root was right for 99%+ of songs. */
export const ADVICE_TONIC_FIRM = 0.8;

const BARS_PER_LINE = 4;
/** Without a bar grid, a recording is cut into lines of this long: about four bars of pop. */
const FALLBACK_LINE_SECONDS = 8;

function keyIndex(pc: number, mode: KeyMode): number {
  return 2 * pc + (mode === 'minor' ? 1 : 0);
}

/** The major tonic of a key's seven notes: C major and A minor are both 0. */
export function noteSetOf(pc: number, mode: KeyMode): number {
  return mode === 'minor' ? (pc + 3) % 12 : pc;
}

/** The reading as it sounds `semitones` higher: a capo chart's shapes, moved to where they ring. */
function transposed(reading: ChordKeyReading, semitones: number): ChordKeyReading {
  const shift = ((semitones % 12) + 12) % 12;
  if (shift === 0) {
    return reading;
  }
  const moved = Array<number>(24).fill(0);
  reading.probabilities.forEach((p, i) => {
    const pc = Math.floor(i / 2);
    moved[2 * ((pc + shift) % 12) + (i % 2)] = p;
  });
  return readingFromProbabilities(moved);
}

/** A key as a chart writes it: "F#m", "Bb", "Am", "C major", "E minor". */
export function parseChartKey(raw: string | null | undefined): { pc: number; mode: KeyMode } | null {
  if (!raw) {
    return null;
  }
  // Upper-case letters only: some traditions write a minor key as a lower-case letter, and a
  // misread mode would put the wrong root on the neck with a chart's authority behind it.
  const match = /^([A-G])\s*([#♯b♭]?)\s*(m(?:in(?:or)?)?|maj(?:or)?|-)?$/.exec(raw.trim());
  if (!match) {
    return null;
  }
  const accidental = match[2] === '♯' ? '#' : match[2] === '♭' ? 'b' : match[2]!;
  const pc = pitchClassForNoteLabel(`${match[1]!}${accidental}`);
  if (pc === null) {
    return null;
  }
  const suffix = match[3] ?? '';
  const minor = suffix === '-' || (suffix.startsWith('m') && !suffix.startsWith('maj'));
  return { pc, mode: minor ? 'minor' : 'major' };
}

const ROMAN: Readonly<Record<string, number>> = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11,
};

/** "Capo 2", "Capo: 3rd fret", "capo on II", "קאפו 2", "קאפו על 3"; 0 for "no capo"; null if none. */
export function capoFromText(text: string): number | null {
  if (/\bno\s+capo\b|\bwithout\s+(?:a\s+)?capo\b|ללא\s+קאפו|בלי\s+קאפו/i.test(text)) {
    return 0;
  }
  const latin = /\bcapo\b[\s:.\-–]*(?:on\s+|at\s+)?(?:the\s+)?(?:fret\s+)?(?:(\d{1,2})(?:st|nd|rd|th)?|([ivx]{1,4}))\b/i.exec(text);
  const hebrew = /קאפו[\s:.\-–]*(?:על\s*|ב[-־]?\s*)?(?:סריג\s*|שריג\s*)?(\d{1,2})/.exec(text);
  const raw = latin ? (latin[1] ?? latin[2]) : hebrew?.[1];
  if (!raw) {
    return null;
  }
  const fret = /^\d+$/.test(raw) ? Number(raw) : ROMAN[raw.toLowerCase()];
  return fret !== undefined && fret >= 1 && fret <= 11 ? fret : null;
}

/** Where the chart says its capo goes: the site's own field, else a mention in the chart. */
export function chartCapo(chart: ScrapedChart): number {
  if (typeof chart.capo === 'number' && Number.isInteger(chart.capo) && chart.capo >= 0) {
    return chart.capo % 12;
  }
  const text = [
    ...(chart.notes ?? []),
    ...chart.sections.flatMap((section) => [section.label, ...section.lines.map((line) => line.lyric)]),
  ].join('\n');
  return capoFromText(text) ?? 0;
}

function spelled(pc: number, mode: KeyMode): string {
  return pitchClassToKey(pc, mode) ?? `${pc}`;
}

function adviceFrom(
  reading: ChordKeyReading,
  applies: number,
  source: AdviceSource,
  trackIdentity: string | null,
  why: string,
  home: { pc: number; mode: KeyMode } | null = null,
): KeyAdvice {
  const pc = home?.pc ?? reading.pc;
  const mode = home?.mode ?? reading.mode;
  return {
    key: spelled(pc, mode),
    mode,
    noteSetP: applies * reading.noteSetMass,
    tonicShare: home ? 1 : reading.tonicShare,
    sources: [source],
    trackIdentity,
    why,
  };
}

/**
 * The scraped chart's key, as it sounds.
 *
 * The chords are read by the model, then moved up by the capo when the chart has one: a capo chart
 * writes the shapes, and the song rings where they land (Ultimate Guitar's Wonderwall is Em shapes
 * on capo 2, and the site calls it F#m). A key the site declares only decides which end of the
 * relative pair is home, and only when it names the chords' seven notes — as they sound, or as
 * written; a declared key that disagrees with the chords about the notes is ignored, because the
 * model is the half of that pair that has been measured.
 */
export function chartAdvice(chart: ScrapedChart | null | undefined, trackIdentity: string | null): KeyAdvice | null {
  if (!chart?.sourceUrl) {
    return null;
  }
  const written = readChordKey(chart.sections.map((section) => section.lines.map((line) => line.segs.map((seg) => seg.c))));
  if (!written) {
    return null;
  }
  const capo = chartCapo(chart);
  const sounding = transposed(written, capo);
  const tag = capo ? `chart_chords_capo_${capo}` : 'chart_chords';
  const declared = parseChartKey(chart.key);
  if (declared) {
    const notes = noteSetOf(sounding.pc, sounding.mode);
    if (noteSetOf(declared.pc, declared.mode) === notes) {
      return adviceFrom(sounding, CHART_APPLIES, 'chart', trackIdentity, `${tag}_declared_root`, declared);
    }
    const asSounding = { pc: (declared.pc + capo) % 12, mode: declared.mode };
    if (capo && noteSetOf(asSounding.pc, asSounding.mode) === notes) {
      return adviceFrom(sounding, CHART_APPLIES, 'chart', trackIdentity, `${tag}_declared_root`, asSounding);
    }
    return adviceFrom(sounding, CHART_APPLIES, 'chart', trackIdentity, `${tag}_declared_key_disagrees`);
  }
  return adviceFrom(sounding, CHART_APPLIES, 'chart', trackIdentity, tag);
}

/** The part of a recognised chord the model reads, in harmonia's domain shape. */
export type RecognisedChord =
  | {
      kind: 'chord';
      root: number;
      triad: 'major' | 'minor' | 'diminished' | 'augmented' | 'sus2' | 'sus4' | 'power';
      seventh: 'minor' | 'major' | 'diminished' | null;
    }
  | { kind: 'none' }
  | { kind: 'unknown' };

export type RecognisedSegment = { start: number; end: number; chord: RecognisedChord };

/** A recognised chord as the chart symbol the model parses: C, Cm, Cdim, Caug, C5, C7. */
export function chordSymbol(chord: RecognisedChord): string | null {
  if (chord.kind !== 'chord' || !Number.isInteger(chord.root) || chord.root < 0 || chord.root > 11) {
    return null;
  }
  const root = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][chord.root]!;
  switch (chord.triad) {
    case 'minor':
      return `${root}m`;
    case 'diminished':
      return `${root}dim`;
    case 'augmented':
      return `${root}aug`;
    case 'sus2':
    case 'sus4':
    case 'power':
      return `${root}5`;
    default:
      return chord.seventh === 'minor' ? `${root}7` : root;
  }
}

/**
 * Line boundaries for a recording: every fourth bar line when the recogniser heard bars, every
 * sixteen beats when it only heard beats, a fixed stretch when it heard neither.
 */
function lineStarts(duration: number, downbeats: readonly number[], beats: readonly number[], meter: number | null): number[] {
  if (downbeats.length >= 2) {
    return downbeats.filter((_, i) => i % BARS_PER_LINE === 0);
  }
  const beatsPerLine = BARS_PER_LINE * (meter && meter > 0 ? meter : 4);
  if (beats.length >= beatsPerLine) {
    return beats.filter((_, i) => i % beatsPerLine === 0);
  }
  const starts: number[] = [];
  for (let t = 0; t < duration; t += FALLBACK_LINE_SECONDS) starts.push(t);
  return starts;
}

/**
 * The recording's chords as the model reads a chart: one section of four-bar lines from the first
 * bar, each line the chords sounding in it with repeats folded — what a bar grid supports, since
 * nobody has marked the phrases. Measured that way, out of fold, the model loses 3.1 points of note
 * set to a chart with its phrases marked and still beats the profile match by 5.4 (86.1% against
 * 80.7%), and by 3.5 with a fifth of the chords misread.
 */
export function recordingLines(
  segments: readonly RecognisedSegment[],
  grid: { downbeats?: readonly number[]; beats?: readonly number[]; meter?: number | null; duration?: number } = {},
): string[][] {
  const chords = segments
    .map((segment) => ({ start: segment.start, end: segment.end, symbol: chordSymbol(segment.chord) }))
    .filter((segment): segment is { start: number; end: number; symbol: string } => segment.symbol !== null && segment.end > segment.start);
  if (!chords.length) {
    return [];
  }
  const duration = Math.max(grid.duration ?? 0, chords[chords.length - 1]!.end);
  const starts = lineStarts(duration, grid.downbeats ?? [], grid.beats ?? [], grid.meter ?? null);
  // Anything before the first bar line — a pickup, an unmetered intro — belongs to the first line.
  const edges = [0, ...starts.slice(1).filter((t) => t > 0 && t < duration), duration];
  const lines: string[][] = [];
  let at = 0;
  for (let i = 0; i + 1 < edges.length; i += 1) {
    const from = edges[i]!;
    const to = edges[i + 1]!;
    if (to <= from) continue;
    while (at < chords.length && chords[at]!.end <= from) at += 1;
    const line: string[] = [];
    for (let j = at; j < chords.length && chords[j]!.start < to; j += 1) {
      const symbol = chords[j]!.symbol;
      if (line[line.length - 1] !== symbol) line.push(symbol);
    }
    if (line.length) lines.push(line);
  }
  return lines;
}

/** The recording's key, read off the chords the recogniser heard in it. */
export function recordingAdvice(
  analysis: {
    segments: readonly RecognisedSegment[];
    beats?: readonly number[];
    meter?: number | null;
    duration?: number;
    grid?: { downbeats?: readonly number[] } | null;
  },
  sameRecording: boolean,
  trackIdentity: string | null,
): KeyAdvice | null {
  const lines = recordingLines(analysis.segments, {
    downbeats: analysis.grid?.downbeats ?? [],
    beats: analysis.beats ?? [],
    meter: analysis.meter ?? null,
    duration: analysis.duration,
  });
  const reading = readChordKey([lines]);
  if (!reading) {
    return null;
  }
  return adviceFrom(
    reading,
    sameRecording ? RECORDING_APPLIES.exact : RECORDING_APPLIES.searched,
    'recording',
    trackIdentity,
    sameRecording ? 'recording_chords' : 'searched_recording_chords',
  );
}

/**
 * One piece of advice from the legs that answered.
 *
 * The likelier leg speaks. A leg that names the same seven notes joins it as a second source, but
 * does not raise the price: both are the same model reading chords, and its mistakes — a song read
 * in its dominant — are the kind two readings of one song make together. A leg that disagrees about
 * the notes is dropped; the recording outranks the chart unless it is much less sure of itself.
 */
export function combineAdvice(...legs: (KeyAdvice | null | undefined)[]): KeyAdvice | null {
  const answered = legs
    .filter((leg): leg is KeyAdvice => Boolean(leg))
    .sort((a, b) => b.noteSetP - a.noteSetP);
  const best = answered[0];
  if (!best) {
    return null;
  }
  const bestPc = pitchClassForNoteLabel(best.key);
  if (bestPc === null) {
    return null;
  }
  const notes = noteSetOf(bestPc, best.mode);
  const agreeing = answered.slice(1).filter((leg) => {
    const pc = pitchClassForNoteLabel(leg.key);
    return pc !== null && noteSetOf(pc, leg.mode) === notes;
  });
  if (!agreeing.length) {
    return answered.length > 1 ? { ...best, why: `${best.why}_outranks_${answered[1]!.sources.join('_')}` } : best;
  }
  const sameRoot = agreeing.filter((leg) => keyIndex(pitchClassForNoteLabel(leg.key)!, leg.mode) === keyIndex(bestPc, best.mode));
  return {
    ...best,
    tonicShare: Math.max(best.tonicShare, ...sameRoot.map((leg) => leg.tonicShare)),
    sources: [...best.sources, ...agreeing.flatMap((leg) => leg.sources)],
    why: `${best.why}_agrees_with_${agreeing.flatMap((leg) => leg.sources).join('_')}`,
  };
}
