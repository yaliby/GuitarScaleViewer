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

export type SheetWord = {
  order: number;
  text: string;
  start: number;
  end: number;
  heard: boolean;
  marks: SheetMark[];
};

export type SheetLyricRow = {
  kind: "lyric";
  id: string;
  start: number;
  end: number;
  words: SheetWord[];
  /** Changes after the last word, in the short rest before the next line. */
  tail: SheetMark[];
  rtl: boolean;
};

export type SheetChordRow = {
  kind: "chords";
  id: string;
  start: number;
  end: number;
  marks: SheetMark[];
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

function chordRows(chords: readonly SheetChord[], id: string): SheetChordRow[] {
  const rows: SheetChordRow[] = [];
  for (let at = 0; at < chords.length; at += ROW_CHORDS) {
    const slice = chords.slice(at, at + ROW_CHORDS);
    rows.push({
      kind: "chords",
      id: `${id}-${at / ROW_CHORDS}`,
      start: slice[0]!.start,
      end: slice[slice.length - 1]!.end,
      marks: slice.map((chord) => ({ chord: chord.order, carried: false })),
    });
  }
  return rows;
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
): SongSheet {
  const chords = chordRuns(segments);
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
      rtl: HEBREW.test(line.text),
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
      ...chordRows(before, "intro"),
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
        ...chordRows(played[index]!, `b${index}`),
      );
    }
  });

  return { sections, rows: sections.flatMap((section) => section.rows), words, chords };
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
