import { describe, expect, it } from "vitest";
import type { Chord, ChordSegment } from "../../harmonia/packages/domain/types";
import type { LyricLine } from "../services/lyricMap";
import {
  activeIndex,
  barSpans,
  beatPlace,
  buildSongSheet,
  chordRuns,
  tuningNote,
  type SheetChordRow,
  type SheetLyricRow,
} from "./chordSheet";

const ROOTS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function chord(name: string): Chord {
  const minor = name.endsWith("m");
  return {
    kind: "chord",
    root: ROOTS[name[0]!]!,
    triad: minor ? "minor" : "major",
    fifth: 0,
    seventh: null,
    extensions: [],
    alterations: [],
    addedTones: [],
    omittedTones: [],
    bass: null,
    spelling: "sharp",
  };
}

/** `["C", 0, 4]` → C from 0 s to 4 s. `"N"` is silence. */
function segments(...spans: [string, number, number][]): ChordSegment[] {
  return spans.map(([name, start, end], index) => ({
    id: `s${index}`,
    start,
    end,
    chord: name === "N" ? { kind: "none" } : chord(name),
    score: 1,
    alternatives: [],
  }));
}

/** Words spaced 0.5 s apart from `start` seconds. */
function line(text: string, start: number, breakBefore = false): LyricLine {
  const words = text.split(" ").map((word, index) => ({
    text: word,
    startMs: Math.round((start + index * 0.5) * 1000),
    endMs: Math.round((start + index * 0.5 + 0.4) * 1000),
    heard: true,
  }));
  return {
    text,
    startMs: words[0]!.startMs,
    endMs: words[words.length - 1]!.endMs,
    breakBefore,
    words,
  };
}

function lyricRows(sheet: ReturnType<typeof buildSongSheet>): SheetLyricRow[] {
  return sheet.rows.filter((row): row is SheetLyricRow => row.kind === "lyric");
}

describe("chordRuns", () => {
  it("folds flicker and repeats into the chord around them, and silence ends a run", () => {
    const runs = chordRuns(
      segments(["N", 0, 1], ["C", 1, 3], ["G", 3, 3.2], ["C", 3.2, 5], ["G", 5, 7], ["N", 7, 8], ["G", 8, 9]),
    );
    expect(runs.map((run) => [run.segment, run.start, run.end])).toEqual([
      [1, 1, 5],
      [4, 5, 7],
      [6, 8, 9],
    ]);
  });
});

describe("buildSongSheet", () => {
  it("puts each chord change over the word being sung when it happens", () => {
    const sheet = buildSongSheet(
      [line("one two three four", 10)],
      segments(["C", 9.8, 11.02], ["G", 11.02, 13]),
    );
    const [row] = lyricRows(sheet);
    // C changes 0.2 s before the line: it belongs to the first word. G lands on "three" (11.0).
    expect(row!.words.map((word) => word.marks.map((mark) => sheet.chords[mark.chord]!.segment))).toEqual([
      [0],
      [],
      [1],
      [],
    ]);
  });

  it("takes a short pickup into the first line as that line's chord, not an intro", () => {
    const sheet = buildSongSheet([line("first words", 10)], segments(["G", 8, 9], ["C", 9, 20]));
    expect(sheet.sections.map((section) => section.label)).toEqual(["Verse 1"]);
    expect(lyricRows(sheet)[0]!.words[0]!.marks).toEqual([
      { chord: 0, carried: false },
      { chord: 1, carried: false },
    ]);
  });

  it("shows the chord still ringing at the start of a line", () => {
    const sheet = buildSongSheet(
      [line("first line", 10), line("second line", 12)],
      segments(["C", 9, 20]),
    );
    const rows = lyricRows(sheet);
    expect(rows[0]!.words[0]!.marks).toEqual([{ chord: 0, carried: false }]);
    expect(rows[1]!.words[0]!.marks).toEqual([{ chord: 0, carried: true }]);
  });

  it("keeps a change in a short rest after the line it follows", () => {
    const sheet = buildSongSheet(
      [line("sung words", 10), line("next words", 14)],
      segments(["C", 9.9, 12], ["D", 12, 20]),
    );
    const rows = lyricRows(sheet);
    expect(rows[0]!.tail).toEqual([{ chord: 1, carried: false }]);
  });

  it("gives the intro, a played break and the outro rows of chords", () => {
    const sheet = buildSongSheet(
      [line("verse words here", 10), line("later words here", 40)],
      segments(["Am", 0, 5], ["F", 5, 10.2], ["C", 10.2, 20], ["G", 20, 30], ["Am", 30, 45], ["E", 45, 60]),
    );
    expect(sheet.sections.map((section) => [section.label, section.rows.map((row) => row.kind)])).toEqual([
      ["Intro", ["chords"]],
      ["Verse 1", ["lyric"]],
      ["Instrumental", ["chords"]],
      ["Verse 2", ["lyric"]],
      ["Outro", ["chords"]],
    ]);
    const instrumental = sheet.sections[2]!.rows[0]!;
    expect(instrumental.kind === "chords" && instrumental.marks.map((mark) => sheet.chords[mark.chord]!.start)).toEqual([
      20, 30,
    ]);
  });

  it("names a block of lines that comes back the chorus and numbers the verses around it", () => {
    const lines = [
      line("walking down the road tonight", 10),
      line("nobody knows my name", 13),
      line("she is a killer queen", 20),
      line("dynamite with a laser beam", 23),
      line("met a man from china", 30),
      line("went down to geisha minah", 33),
      line("she is a killer queen", 40),
      line("dynamite with a laser beam", 43),
    ];
    const sheet = buildSongSheet(lines, segments(["C", 9, 50]));
    expect(sheet.sections.map((section) => [section.label, section.rows.length])).toEqual([
      ["Verse 1", 2],
      ["Chorus", 2],
      ["Verse 2", 2],
      ["Chorus", 2],
    ]);
  });

  it("finds a chorus sung straight on from its verse, and not a lone repeated line", () => {
    const texts = [
      "caviar and cigarettes",
      "wanna try it now",
      "she is a killer queen",
      "dynamite with a laser beam",
      "wanna try it now",
      "drop of a hat she is",
      "she is a killer queen",
      "dynamite with a laser beam",
    ];
    const sheet = buildSongSheet(
      texts.map((text, index) => line(text, 10 + index * 3)),
      segments(["C", 9, 40]),
    );
    expect(sheet.sections.map((section) => [section.label, section.rows.length])).toEqual([
      ["Verse 1", 2],
      ["Chorus", 2],
      ["Verse 2", 2],
      ["Chorus", 2],
    ]);
  });

  it("is all chords when nothing is sung", () => {
    const sheet = buildSongSheet([], segments(["C", 0, 4], ["G", 4, 8]));
    expect(sheet.sections.map((section) => section.label)).toEqual(["Chords"]);
    expect(sheet.words).toEqual([]);
  });

  it("reads Hebrew lines right to left", () => {
    const sheet = buildSongSheet([line("שיר של יום", 5)], segments(["C", 4, 9]));
    expect(lyricRows(sheet)[0]!.rtl).toBe(true);
  });
});

describe("bars", () => {
  /** Chord names per bar; a carried chord is written in brackets. */
  function barNames(sheet: ReturnType<typeof buildSongSheet>, row: SheetChordRow): string[][] {
    const names = ["C", "G", "Am", "F", "D", "E"];
    return row.bars!.map((bar) =>
      bar.marks.map((mark) => {
        const segment = sheet.chords[mark.chord]!.segment;
        return mark.carried ? `(${names[segment]})` : names[segment]!;
      }),
    );
  }

  it("lays a chords-only stretch out as bars from the downbeats", () => {
    const sheet = buildSongSheet(
      [],
      segments(["C", 0, 4], ["G", 4, 8], ["Am", 8, 10], ["F", 10, 16]),
      { downbeats: [0, 4, 8, 12], end: 16 },
    );
    const rows = sheet.rows as SheetChordRow[];
    expect(rows).toHaveLength(1);
    expect(barNames(sheet, rows[0]!)).toEqual([["C"], ["G"], ["Am", "F"], ["(F)"]]);
    // Changes only: the carried F is not a change the sheet has to light up again.
    expect(rows[0]!.marks.map((mark) => mark.chord)).toEqual([0, 1, 2, 3]);
  });

  it("writes a chord pushed just ahead of the bar line into that bar", () => {
    const sheet = buildSongSheet([], segments(["C", 0, 3.9], ["G", 3.9, 7.9], ["Am", 7.9, 12]), {
      downbeats: [0, 4, 8],
      end: 12,
    });
    expect(barNames(sheet, sheet.rows[0] as SheetChordRow)).toEqual([["C"], ["G"], ["Am"]]);
  });

  it("wraps every four bars and starts a row when its first chord does", () => {
    const sheet = buildSongSheet(
      [],
      segments(["C", 1, 9], ["G", 9, 17], ["Am", 17, 25], ["F", 25, 33], ["D", 33, 41], ["E", 41, 48]),
      { downbeats: [1, 5, 9, 13, 17, 21, 25, 29, 33, 37, 41, 45], end: 48 },
    );
    const rows = sheet.rows as SheetChordRow[];
    expect(rows.map((row) => row.bars!.length)).toEqual([4, 4, 4]);
    expect(rows[0]!.start).toBeCloseTo(1, 5);
    expect(barNames(sheet, rows[1]!)).toEqual([["Am"], ["(Am)"], ["F"], ["(F)"]]);
  });

  it("keeps the flat chord list for an analysis without bars", () => {
    const sheet = buildSongSheet([], segments(["C", 0, 4], ["G", 4, 8]));
    expect((sheet.rows[0] as SheetChordRow).bars).toBeUndefined();
  });

  it("makes a pickup bar before the first downbeat and a last bar to the end", () => {
    expect(barSpans({ downbeats: [0.8, 2.8, 4.8], end: 6 })).toEqual([
      { start: 0, end: 0.8 },
      { start: 0.8, end: 2.8 },
      { start: 2.8, end: 4.8 },
      { start: 4.8, end: 6 },
    ]);
    expect(barSpans({ downbeats: [1], end: 6 })).toEqual([]);
  });
});

describe("activeIndex", () => {
  it("finds the last item that has started", () => {
    const items = [{ start: 1 }, { start: 2 }, { start: 5 }];
    expect([0.5, 1, 3, 9].map((time) => activeIndex(items, time))).toEqual([-1, 0, 1, 2]);
  });
});

describe("beatPlace", () => {
  // 4/4 at 120 BPM with a one-beat pickup: beats every 0.5 s from 1.0, bars from 1.5.
  const beats = Array.from({ length: 17 }, (_, i) => 1 + i * 0.5);
  const downbeats = [1.5, 3.5, 5.5, 7.5];

  it("counts bars from the first downbeat and beats within the bar", () => {
    expect(beatPlace(beats, downbeats, 4, 1.6)).toMatchObject({ bar: 1, beat: 1 });
    expect(beatPlace(beats, downbeats, 4, 3.4)).toMatchObject({ bar: 1, beat: 4 });
    expect(beatPlace(beats, downbeats, 4, 3.5)).toMatchObject({ bar: 2, beat: 1 });
  });

  it("numbers a pickup as the end of an unseen bar", () => {
    expect(beatPlace(beats, downbeats, 4, 1.2)).toMatchObject({ bar: 0, beat: 4 });
  });

  it("says nothing before the first beat, after the last, or without a meter", () => {
    expect(beatPlace(beats, downbeats, 4, 0.5)).toBeNull();
    expect(beatPlace(beats, downbeats, 4, 20)).toBeNull();
    expect(beatPlace(beats, downbeats, null, 2)).toBeNull();
    expect(beatPlace(beats, [], 4, 2)).toBeNull();
  });
});

describe("tuningNote", () => {
  it("names the A to tune to when the recording is clearly off 440", () => {
    expect(tuningNote(-32)).toEqual({ cents: -32, hz: 432 });
    expect(tuningNote(20)).toEqual({ cents: 20, hz: 445 });
  });

  it("stays quiet about a few cents, and about analyses that never measured it", () => {
    expect(tuningNote(-9)).toBeNull();
    expect(tuningNote(null)).toBeNull();
    expect(tuningNote(undefined)).toBeNull();
  });
});
