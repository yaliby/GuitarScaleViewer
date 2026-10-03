import { formatChord } from "../../harmonia/packages/domain/chord";
import type { ChordSegment } from "../../harmonia/packages/domain/types";
import type { LyricLine } from "../services/lyricMap";

/**
 * The song as a chord sheet: every lyric word on the recording's clock (from the
 * lyric map) with the recognizer's chord changes placed over the word being sung
 * when they happen. Stretches with no singing become rows of chords.
 */

/** A run of one chord, as the sheet shows it. */
export type SheetChord = {
  order: number;
  /** First analysis segment of the run. */
  segment: number;
  start: number;
  end: number;
};

/** A chord over a word. `carried`: still ringing from before the line, not a change. */
export type SheetMark = { chord: number; carried: boolean };

/**
 * A stretch of the lane drawn over the words: one chord, or nothing played (chord -1). The
 * pieces of one chord join into a single box as long as the chord is played.
 */
export type SheetPiece = {
  chord: number;
  start: number;
  end: number;
  /** The chord changes to this one here: its box opens. */
  opens: boolean;
  /** It changes to the next one here: its box closes. */
  closes: boolean;
  /** Its name is written here: where it opens, or at the head of a row or bar it rings into. */
  label: boolean;
};

/** A span of the song's clock and the lane over it. */
export type SheetSlot = { start: number; end: number; pieces: SheetPiece[] };

export type SheetWord = {
  order: number;
  text: string;
  start: number;
  end: number;
  heard: boolean;
  marks: SheetMark[];
  /** The lane over the word: from its start to the next word's. */
  slot: SheetSlot;
};

export type SheetLyricRow = {
  kind: "lyric";
  id: string;
  start: number;
  end: number;
  words: SheetWord[];
  /** Changes after the last word, in the short rest before the next line. */
  tail: SheetMark[];
  /** The lane over that rest, while a chord still rings in it. */
  rest: SheetSlot | null;
  rtl: boolean;
  /** The span its lane covers, up to where the next row's starts. */
  lane: { start: number; end: number };
};

/** One bar of a chords-only row: the chord ringing into it (carried), then its changes. */
export type SheetBar = {
  start: number;
  end: number;
  marks: SheetMark[];
  pieces: SheetPiece[];
};

export type SheetChordRow = {
  kind: "chords";
  id: string;
  start: number;
  end: number;
  /** The changes written in this row, in order. */
  marks: SheetMark[];
  /** Present when the recording's bars are known: the row as a strip of bars. */
  bars?: SheetBar[];
  /** Without bars: one slot per chord, as long as it is played. */
  slots: SheetSlot[];
  lane: { start: number; end: number };
};

/** Where the bars fall: the analysis's downbeats and the end of the recording. */
export type SheetGrid = {
  downbeats: readonly number[];
  end: number;
};

export type SheetRow = SheetLyricRow | SheetChordRow;

export type SectionKind = "intro" | "verse" | "chorus" | "instrumental" | "outro" | "chords";

export type SheetSection = {
  id: string;
  kind: SectionKind;
  label: string;
  rows: SheetRow[];
};

export type SongSheet = {
  sections: SheetSection[];
  /** Every row in play order. */
  rows: SheetRow[];
  words: SheetWord[];
  chords: SheetChord[];
};

/** Shorter chords are recognizer flicker, folded into the chord around them. */
const BLIP_S = 0.35;
/** A change this soon before a line's first word belongs to that word. */
const LEAD_S = 0.3;
/** Before the first sung word, this much is a pickup into it, not an intro of its own. */
const PICKUP_S = 2.5;
/** A change this soon before a word lands on it, not on the word before. */
const SNAP_S = 0.15;
/** A change this long after a line's last word sits after the line. */
const TAIL_S = 0.6;
/** A rest this long between sung lines is played: its chords get rows of their own. */
const BREAK_S = 6;
/** A rest this long between sung lines starts a new block of lines. */
const STANZA_S = 3;
const ROW_CHORDS = 8;
const ROW_BARS = 4;
/** A chord landing this soon before a bar line is that bar's first chord, a push into it. */
const BAR_SNAP_S = 0.15;

const HEBREW = /[֐-׿]/;

export function chordRuns(segments: readonly ChordSegment[]): SheetChord[] {
  const out: SheetChord[] = [];
  let current: string | null = null;
  segments.forEach((segment, index) => {
    if (segment.chord.kind !== "chord") {
      current = null;
      return;
    }
    const last = out[out.length - 1];
    if (segment.end - segment.start < BLIP_S) {
      if (last && current !== null) last.end = segment.end;
      return;
    }
    const label = formatChord(segment.chord);
    if (last && label === current) {
      last.end = segment.end;
      return;
    }
    out.push({ order: out.length, segment: index, start: segment.start, end: segment.end });
    current = label;
  });
  return out;
}

/** Bar spans from the downbeats: a pickup from 0 to the first, the last to the recording's end. */
export function barSpans(grid: SheetGrid): { start: number; end: number }[] {
  const lines = grid.downbeats.filter((time) => time > 0 && time < grid.end);
  if (lines.length < 2) return [];
  const edges = [0, ...lines, grid.end];
  return edges.slice(0, -1).map((start, index) => ({ start, end: edges[index + 1]! }));
}

/**
 * A chords-only stretch as bars, like a hand-written chart: each bar shows the chord ringing into
 * it (dimmed) unless a change lands on its first beat, then every change inside it.
 */
function barRows(chords: readonly SheetChord[], all: readonly SheetChord[], spans: readonly { start: number; end: number }[], id: string): SheetChordRow[] {
  const first = chords[0]!;
  const last = chords[chords.length - 1]!;
  const inside = spans.filter((bar) => bar.end > first.start + BAR_SNAP_S && bar.start < last.end - BAR_SNAP_S);
  if (!inside.length) return [];
  const members = new Set(chords.map((chord) => chord.order));
  const bars: SheetBar[] = inside.map((span) => {
    const changes = chords.filter(
      (chord) => chord.start >= span.start - BAR_SNAP_S && chord.start < span.end - BAR_SNAP_S,
    );
    const marks: SheetMark[] = changes.map((chord) => ({ chord: chord.order, carried: false }));
    if (!changes.length || changes[0]!.start > span.start + BAR_SNAP_S) {
      const ringing = activeIndex(all, span.start + BAR_SNAP_S);
      if (ringing >= 0 && members.has(ringing) && all[ringing]!.end > span.start + BAR_SNAP_S) {
        marks.unshift({ chord: ringing, carried: true });
      }
    }
    return { start: span.start, end: span.end, marks, pieces: [] };
  });
  const rows: SheetChordRow[] = [];
  for (let at = 0; at < bars.length; at += ROW_BARS) {
    const slice = bars.slice(at, at + ROW_BARS);
    rows.push({
      kind: "chords",
      id: `${id}-${at / ROW_BARS}`,
      start: Math.max(slice[0]!.start, at === 0 ? first.start - BAR_SNAP_S : slice[0]!.start),
      end: slice[slice.length - 1]!.end,
      marks: slice.flatMap((bar) => bar.marks.filter((mark) => !mark.carried)),
      bars: slice,
      slots: [],
      lane: { start: slice[0]!.start, end: slice[slice.length - 1]!.end },
    });
  }
  return rows;
}

function chordRows(
  chords: readonly SheetChord[],
  id: string,
  all: readonly SheetChord[] = chords,
  spans: readonly { start: number; end: number }[] = [],
): SheetChordRow[] {
  if (spans.length && chords.length) {
    const rows = barRows(chords, all, spans, id);
    if (rows.length) return rows;
  }
  const rows: SheetChordRow[] = [];
  for (let at = 0; at < chords.length; at += ROW_CHORDS) {
    const slice = chords.slice(at, at + ROW_CHORDS);
    rows.push({
      kind: "chords",
      id: `${id}-${at / ROW_CHORDS}`,
      start: slice[0]!.start,
      end: slice[slice.length - 1]!.end,
      marks: slice.map((chord) => ({ chord: chord.order, carried: false })),
      slots: [],
      lane: { start: slice[0]!.start, end: slice[slice.length - 1]!.end },
    });
  }
  return rows;
}

/** Shorter than this, a piece of the lane is a rounding scrap, not a stretch of the song. */
const SCRAP_S = 0.02;

/**
 * The lane over a span of the clock: a piece per chord played in it, gaps where nothing is.
 * `head`: the span starts a row or a bar, so the chord ringing into it is named there.
 */
function laneSlot(
  shown: readonly { start: number; end: number }[],
  start: number,
  end: number,
  head: boolean,
): SheetSlot {
  const pieces: SheetPiece[] = [];
  const push = (chord: number, from: number, to: number, opens: boolean, closes: boolean) => {
    if (to - from < SCRAP_S) return;
    pieces.push({ chord, start: from, end: to, opens, closes, label: chord >= 0 && (opens || (head && !pieces.length)) });
  };
  let at = start;
  for (let index = Math.max(0, activeIndex(shown, start)); index < shown.length; index += 1) {
    const chord = shown[index]!;
    if (chord.start >= end) break;
    if (chord.end <= start) continue;
    const from = Math.max(start, chord.start);
    const to = Math.min(end, chord.end);
    push(-1, at, from, true, true);
    push(index, from, to, chord.start >= start, chord.end <= end);
    at = Math.max(at, to);
  }
  push(-1, at, end, true, true);
  return { start, end, pieces };
}

/**
 * Draws the lanes: the chords as boxes as long as they are played, over the words they are
 * played under, in bars, or in a row of their own. Rows share the clock between them: a row's
 * lane runs until the next row's starts. A change a hair off a word or a bar line lands on it.
 */
function drawLanes(rows: readonly SheetRow[], words: readonly SheetWord[], chords: readonly SheetChord[]): void {
  const edges = [
    ...words.map((word) => word.start),
    ...rows.flatMap((row) => (row.kind === "chords" && row.bars ? row.bars.map((bar) => bar.start) : [])),
  ].sort((a, b) => a - b);
  const marks = edges.map((edge) => ({ start: edge }));
  const snap = (time: number) => {
    const at = activeIndex(marks, time + SNAP_S);
    return at >= 0 && Math.abs(edges[at]! - time) <= SNAP_S ? edges[at]! : time;
  };
  const shown = chords.map((chord) => ({ start: snap(chord.start), end: snap(chord.end) }));
  shown.forEach((chord) => {
    chord.end = Math.max(chord.start, chord.end);
  });

  // Where each row's lane starts: a lyric row at its first change, even ahead of its first word.
  const starts = rows.map((row) => {
    if (row.kind === "chords") return row.bars ? row.lane.start : shown[row.marks[0]!.chord]!.start;
    const changes = row.words.flatMap((word) => word.marks.filter((mark) => !mark.carried));
    return Math.min(row.start, ...changes.map((mark) => shown[mark.chord]!.start));
  });
  const last = chords.length ? shown[shown.length - 1]!.end : 0;

  rows.forEach((row, index) => {
    const start = starts[index]!;
    if (row.kind === "chords") {
      if (row.bars) {
        for (const bar of row.bars) bar.pieces = laneSlot(shown, bar.start, bar.end, true).pieces;
        return;
      }
      row.slots = row.marks.map((mark) => laneSlot(shown, shown[mark.chord]!.start, shown[mark.chord]!.end, true));
      row.lane = { start, end: row.slots[row.slots.length - 1]!.end };
      return;
    }
    const final = row.words[row.words.length - 1]!;
    const end = Math.max(index + 1 < rows.length ? starts[index + 1]! : Math.max(last, row.end), final.end);
    // A rest after the line has a lane of its own; a breath is the last word's.
    const resting = end - final.end > TAIL_S;
    row.words.forEach((word, at) => {
      const from = at === 0 ? start : word.start;
      const next = row.words[at + 1];
      const to = next ? next.start : resting ? Math.max(word.start, word.end) : end;
      word.slot = laneSlot(shown, from, Math.max(from, to), at === 0);
    });
    const rest = resting ? laneSlot(shown, Math.max(final.start, final.end), end, false) : null;
    row.rest = rest && rest.pieces.some((piece) => piece.chord >= 0) ? rest : null;
    row.lane = { start, end };
  });
}

function wordKeys(row: SheetLyricRow): string[] {
  return row.words
    .map((word) => word.text.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""))
    .filter(Boolean);
}

function sameLine(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return false;
  const left = new Set(a);
  const right = new Set(b);
  let shared = 0;
  for (const key of left) if (right.has(key)) shared += 1;
  return shared / (left.size + right.size - shared) >= 0.7;
}

/**
 * Lines sung again elsewhere in the same order as their neighbours: the chorus.
 * One line coming back ("yeah", a title hook) is not enough; two in a row are.
 */
function repeatedLines(rows: readonly SheetLyricRow[]): boolean[] {
  const keys = rows.map(wordKeys);
  const n = rows.length;
  const same = rows.map((_row, i) => rows.map((_other, j) => i !== j && sameLine(keys[i]!, keys[j]!)));
  return rows.map((_row, i) =>
    same[i]!.some(
      (match, j) =>
        match &&
        ((i + 1 < n && j + 1 < n && j + 1 !== i && same[i + 1]![j + 1]!) ||
          (i > 0 && j > 0 && j - 1 !== i && same[i - 1]![j - 1]!)),
    ),
  );
}

export function buildSongSheet(
  lines: readonly LyricLine[],
  segments: readonly ChordSegment[],
  grid?: SheetGrid | null,
): SongSheet {
  const chords = chordRuns(segments);
  const spans = grid ? barSpans(grid) : [];
  const words: SheetWord[] = [];
  const lyricRows: SheetLyricRow[] = lines.map((line, index) => {
    const rowWords = line.words.map((word) => {
      const item: SheetWord = {
        order: words.length,
        text: word.text,
        start: word.startMs / 1000,
        end: Math.max(word.startMs, word.endMs) / 1000,
        heard: word.heard,
        marks: [],
        slot: { start: word.startMs / 1000, end: word.endMs / 1000, pieces: [] },
      };
      words.push(item);
      return item;
    });
    return {
      kind: "lyric",
      id: `l${index}`,
      start: rowWords[0]!.start,
      end: Math.max(...rowWords.map((word) => word.end)),
      words: rowWords,
      tail: [],
      rest: null,
      rtl: HEBREW.test(line.text),
      lane: { start: rowWords[0]!.start, end: Math.max(...rowWords.map((word) => word.end)) },
    };
  });

  const before: SheetChord[] = [];
  const played: SheetChord[][] = lyricRows.map(() => []);
  let at = -1;
  for (const chord of chords) {
    while (
      at + 1 < lyricRows.length &&
      chord.start >= lyricRows[at + 1]!.start - (at < 0 ? PICKUP_S : LEAD_S)
    ) {
      at += 1;
    }
    if (at < 0) {
      before.push(chord);
      continue;
    }
    const row = lyricRows[at]!;
    const next = lyricRows[at + 1];
    const rest = (next ? next.start - LEAD_S : Number.POSITIVE_INFINITY) - row.end;
    if (chord.start > row.end + TAIL_S) {
      if (rest >= BREAK_S) played[at]!.push(chord);
      else row.tail.push({ chord: chord.order, carried: false });
      continue;
    }
    let target = row.words[0]!;
    for (const word of row.words) {
      if (word.start <= chord.start + SNAP_S) target = word;
      else break;
    }
    target.marks.push({ chord: chord.order, carried: false });
  }

  // The chord a line starts on, when it changed before the line did.
  for (const row of lyricRows) {
    const first = row.words[0]!;
    if (first.marks.length) continue;
    const ringing = activeIndex(chords, row.start + SNAP_S);
    if (ringing >= 0 && chords[ringing]!.end > row.start) {
      first.marks.push({ chord: ringing, carried: true });
    }
  }

  const chorus = repeatedLines(lyricRows);
  const sections: SheetSection[] = [];
  const open = (kind: SectionKind, label: string) => {
    const section: SheetSection = { id: `s${sections.length}`, kind, label, rows: [] };
    sections.push(section);
    return section;
  };
  if (before.length) {
    open(lyricRows.length ? "intro" : "chords", lyricRows.length ? "Intro" : "Chords").rows.push(
      ...chordRows(before, "intro", chords, spans),
    );
  }
  let verses = 0;
  lyricRows.forEach((row, index) => {
    const prev = lyricRows[index - 1];
    const kind: SectionKind = chorus[index] ? "chorus" : "verse";
    const last = sections[sections.length - 1];
    const stanza = !prev || lines[index]!.breakBefore || row.start - prev.end >= STANZA_S;
    const current =
      last && last.kind === kind && !(stanza && kind === "verse")
        ? last
        : open(kind, kind === "chorus" ? "Chorus" : `Verse ${(verses += 1)}`);
    current.rows.push(row);
    if (played[index]!.length) {
      const outro = index === lyricRows.length - 1;
      open(outro ? "outro" : "instrumental", outro ? "Outro" : "Instrumental").rows.push(
        ...chordRows(played[index]!, `b${index}`, chords, spans),
      );
    }
  });

  const rows = sections.flatMap((section) => section.rows);
  drawLanes(rows, words, chords);
  return { sections, rows, words, chords };
}

/** Last item starting at or before `time`, or -1. */
export function activeIndex(items: readonly { start: number }[], time: number): number {
  let low = 0;
  let high = items.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (items[middle]!.start <= time) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/** Where the clock is in the bar grid: bar 0 is the pickup before the first downbeat. */
export type BeatPlace = { bar: number; beat: number; meter: number; index: number };

/** Last value at or before `time`, or -1. */
function lastAtOrBefore(values: readonly number[], time: number): number {
  let low = 0;
  let high = values.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (values[middle]! <= time) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

export function beatPlace(
  beats: readonly number[],
  downbeats: readonly number[],
  meter: number | null,
  time: number,
): BeatPlace | null {
  if (!meter || meter < 2 || beats.length < 2 || !downbeats.length) return null;
  const index = lastAtOrBefore(beats, time);
  if (index < 0) return null;
  const period = beats[Math.min(index + 1, beats.length - 1)]! - beats[Math.max(index - 1, 0)]!;
  // Past the last beat by more than a beat and a half: the song has stopped counting.
  if (index === beats.length - 1 && time > beats[index]! + Math.max(period, 0.2) * 0.75) return null;
  const bar = lastAtOrBefore(downbeats, beats[index]! + 1e-6) + 1;
  if (bar === 0) {
    const first = lastAtOrBefore(beats, downbeats[0]! + 1e-6);
    return { bar: 0, beat: Math.max(1, meter - (first - index) + 1), meter, index };
  }
  const barStart = lastAtOrBefore(beats, downbeats[bar - 1]! + 1e-6);
  return { bar, beat: Math.min(meter, index - barStart + 1), meter, index };
}

/**
 * What a guitarist tunes to so their open strings sit with this recording: the A the recording
 * implies, when it is far enough from 440 to hear (a sixth of a semitone).
 */
export function tuningNote(cents: number | null | undefined): { cents: number; hz: number } | null {
  if (cents === null || cents === undefined || !Number.isFinite(cents) || Math.abs(cents) < 15) return null;
  return { cents: Math.round(cents), hz: Math.round(440 * 2 ** (cents / 1200)) };
}
