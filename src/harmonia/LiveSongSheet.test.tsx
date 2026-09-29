import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chord, ChordSegment, SavedTrack } from "../../harmonia/packages/domain/types";
import type { LyricLine, LyricMap } from "../services/lyricMap";
import type { CapturedTrack } from "../services/trackCapture";

const mocks = vi.hoisted(() => ({
  tauri: true,
  library: [] as unknown[],
  seek: vi.fn(),
  enqueue: vi.fn(),
  ensure: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  isTauri: () => mocks.tauri,
}));

vi.mock("./composition", () => ({
  getHarmoniaSession: async () => ({
    subscribe: () => () => undefined,
    snapshot: () => ({ library: mocks.library }),
  }),
}));

vi.mock("./backgroundChords", () => ({
  enqueueChordAnalysis: (track: CapturedTrack, options?: { refresh?: boolean }) =>
    mocks.enqueue(track, options),
}));

vi.mock("../hooks/mediaTransport", () => ({
  seekMedia: (ms: number) => mocks.seek(ms),
}));

vi.mock("../services/lyricMap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/lyricMap")>()),
  ensureLyricMap: (id: string, force?: boolean) => mocks.ensure(id, force),
}));

import { markCaptureAnalyzed } from "./analyzedCaptures";
import { resetChordJobsForTests, setChordJob } from "./chordJobs";
import { NATIVE_MODEL_VERSION } from "../../harmonia/packages/audio/native-whole";
import LiveSongSheet, { forgetRefreshesForTests } from "./LiveSongSheet";

const ROOTS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function chord(name: string): Chord {
  return {
    kind: "chord",
    root: ROOTS[name[0]!]!,
    triad: name.endsWith("m") ? "minor" : "major",
    fifth: 0,
    seventh: null,
    extensions: [],
    alterations: [],
    addedTones: [],
    omittedTones: [],
    bass: null,
    spelling: "sharp",
  } as Chord;
}

function segments(...spans: [string, number, number][]): ChordSegment[] {
  return spans.map(([name, start, end], index) => ({
    id: `s${index}`,
    start,
    end,
    chord: chord(name),
    score: 1,
    alternatives: [],
  }));
}

function line(text: string, start: number): LyricLine {
  const words = text.split(" ").map((word, index) => ({
    text: word,
    startMs: Math.round((start + index * 0.5) * 1000),
    endMs: Math.round((start + index * 0.5 + 0.4) * 1000),
    heard: true,
  }));
  return { text, startMs: words[0]!.startMs, endMs: words[words.length - 1]!.endMs, breakBefore: false, words };
}

function record(
  fingerprint: string,
  createdAt: string,
  spans: ChordSegment[],
  modelVersion = NATIVE_MODEL_VERSION,
): SavedTrack {
  return {
    track: {
      id: fingerprint,
      name: "Fast Car.m4a",
      duration: 16,
      fingerprint,
      importedAt: createdAt,
      favorite: false,
    },
    analysis: {
      id: `${fingerprint}-${createdAt}`,
      fingerprint,
      profile: "balanced",
      modelVersion,
      pipelineVersion: "p",
      duration: 16,
      segments: spans,
      beats: [],
      tempo: null,
      meter: null,
      key: { root: 7, mode: "major", score: 1 },
      waveform: [],
      boundaries: [],
      createdAt,
      calibration: "uncalibrated",
      warnings: [],
    },
    corrections: [],
  } as SavedTrack;
}

const MAP: LyricMap = {
  id: "yt-abc",
  source: "lrclib+whisper",
  provider: "lrclib",
  language: "en",
  model: "small",
  offsetMs: 0,
  wordsTotal: 6,
  wordsHeard: 6,
  durationMs: 16_000,
  note: null,
  lines: [line("hello world again", 4), line("second line here", 9)],
};

const TRACK: CapturedTrack = {
  id: "yt-abc",
  path: "/tmp/yt-abc.m4a",
  audioUrl: "/chordsync/audio?id=yt-abc",
  title: "Fast Car",
  artist: "Tracy Chapman",
  album: null,
  engine: "youtube_direct",
  webpageUrl: null,
  durationMs: 16_000,
  artworkPath: null,
  artworkUrl: null,
  bytes: 12,
  cached: true,
  sourceApp: "Firefox",
  capturedAt: "2026-09-25T00:00:00Z",
};

const nowRow = () => document.querySelector(".sheet-row.is-now")?.textContent ?? "";

beforeEach(() => {
  localStorage.clear();
  resetChordJobsForTests();
  forgetRefreshesForTests();
  mocks.enqueue.mockReset();
  mocks.tauri = true;
  mocks.library = [];
  mocks.ensure.mockImplementation(async () => MAP);
  mocks.seek.mockImplementation(async () => null);
});

afterEach(() => {
  cleanup();
});

describe("LiveSongSheet", () => {
  it("says how to get a sheet when nothing of the song is saved", () => {
    render(<LiveSongSheet track={null} positionMs={0} playing={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("No saved copy of this song yet.");
  });

  it("shows the chords being read in the background", () => {
    setChordJob("yt-abc", { stage: "Recognizing harmony", progress: 0.4 });
    render(<LiveSongSheet track={TRACK} positionMs={0} playing={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("Reading this recording's chords…");
    expect(screen.getByRole("status")).toHaveTextContent("Recognizing harmony");
  });

  it("offers to read the chords of a saved song nobody has analysed", () => {
    render(<LiveSongSheet track={TRACK} positionMs={0} playing={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Read the chords" }));
    expect(mocks.enqueue).toHaveBeenCalledWith(TRACK, undefined);
  });

  it("follows the OS player's clock through the newest analysis of the recording", async () => {
    markCaptureAnalyzed("yt-abc", "fp-abc");
    mocks.library = [
      record("fp-abc", "2026-09-25T00:00:00Z", segments(["C", 0, 16])),
      record("fp-abc", "2026-09-26T00:00:00Z", segments(["C", 0, 4], ["G", 4, 8], ["Am", 8, 12], ["F", 12, 16])),
      record("fp-other", "2026-09-27T00:00:00Z", segments(["D", 0, 16])),
    ];
    const { rerender } = render(<LiveSongSheet track={TRACK} positionMs={4_200} playing={false} />);

    expect(await screen.findByRole("heading", { name: "Song sheet" })).toBeInTheDocument();
    expect(nowRow()).toContain("hello");
    /* The re-analysis wins: G over "hello", not the first analysis's lone C. */
    expect(nowRow()).toContain("G");
    expect(screen.getByText(/Read from the saved copy: Tracy Chapman — Fast Car/)).toBeInTheDocument();

    rerender(<LiveSongSheet track={TRACK} positionMs={9_600} playing={false} />);
    expect(nowRow()).toContain("second");
  });

  it("seeks the OS player from a word", async () => {
    markCaptureAnalyzed("yt-abc", "fp-abc");
    mocks.library = [record("fp-abc", "2026-09-26T00:00:00Z", segments(["G", 0, 8], ["Am", 8, 16]))];
    render(<LiveSongSheet track={TRACK} positionMs={4_200} playing={false} />);

    fireEvent.click(await screen.findByText("second"));
    expect(mocks.seek).toHaveBeenCalledWith(9_000);
    expect(nowRow()).toContain("second");
  });

  it("runs the clock on between the player's reports while the song plays", async () => {
    vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame"] });
    try {
      markCaptureAnalyzed("yt-abc", "fp-abc");
      mocks.library = [record("fp-abc", "2026-09-26T00:00:00Z", segments(["G", 0, 8], ["Am", 8, 16]))];
      render(<LiveSongSheet track={TRACK} positionMs={8_000} playing={true} />);
      await act(async () => undefined);
      await act(async () => undefined);
      expect(nowRow()).toContain("hello");

      act(() => {
        vi.advanceTimersByTime(1_500);
      });
      expect(nowRow()).toContain("second");
    } finally {
      vi.useRealTimers();
    }
  });

  it("warns that a search match may be another cut of the song", async () => {
    markCaptureAnalyzed("yt-abc", "fp-abc");
    mocks.library = [record("fp-abc", "2026-09-26T00:00:00Z", segments(["G", 0, 16]))];
    render(
      <LiveSongSheet track={{ ...TRACK, engine: "youtube_search" }} positionMs={0} playing={false} />,
    );
    expect(await screen.findByText(/another cut of the song is playing/)).toBeInTheDocument();
  });

  it("reads an analysis from the older recognizer again, once, keeping the old sheet up", async () => {
    markCaptureAnalyzed("yt-abc", "fp-abc");
    mocks.library = [
      record("fp-abc", "2026-09-26T00:00:00Z", segments(["G", 0, 16]), "lv-chordia-1.1.0-submission-native-v3"),
    ];
    const { rerender } = render(<LiveSongSheet track={TRACK} positionMs={4_200} playing={false} />);
    expect(await screen.findByRole("heading", { name: "Song sheet" })).toBeInTheDocument();
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenCalledWith(TRACK, { refresh: true });

    act(() => setChordJob("yt-abc", { stage: "Recognizing harmony", progress: 0.4 }));
    expect(screen.getByRole("heading", { name: "Song sheet" })).toBeInTheDocument();
    expect(screen.getByText(/Reading this recording again with the new recognizer/)).toHaveTextContent("40%");

    // The re-read failed: the job is gone and the old analysis is still the newest.
    act(() => setChordJob("yt-abc", null));
    rerender(<LiveSongSheet track={TRACK} positionMs={4_300} playing={false} />);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it("leaves a hand-corrected older analysis alone and offers to read it again", async () => {
    markCaptureAnalyzed("yt-abc", "fp-abc");
    const corrected = record(
      "fp-abc",
      "2026-09-26T00:00:00Z",
      segments(["G", 0, 16]),
      "lv-chordia-1.1.0-submission-native-v3",
    );
    mocks.library = [{ ...corrected, corrections: [{ id: "c1" }] }];
    render(<LiveSongSheet track={TRACK} positionMs={4_200} playing={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "Read again" }));
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenCalledWith(TRACK, { refresh: true });
  });

  it("shows the tempo, meter, tuning and the beat of the bar the recognizer read", async () => {
    markCaptureAnalyzed("yt-abc", "fp-abc");
    const beats = Array.from({ length: 32 }, (_, i) => 0.5 * i);
    const read = record("fp-abc", "2026-09-26T00:00:00Z", segments(["G", 0, 8], ["C", 8, 16]));
    mocks.library = [
      {
        ...read,
        analysis: {
          ...read.analysis,
          beats,
          tempo: 120,
          meter: 4,
          grid: { downbeats: beats.filter((_, i) => i % 4 === 0), steady: true, source: "beat-this-final0" },
          tuningCents: -32,
        },
      },
    ];
    render(<LiveSongSheet track={TRACK} positionMs={5_100} playing={false} />);
    expect(await screen.findByText("BPM", { exact: false })).toHaveTextContent("120 BPM");
    expect(screen.getByText(/beats a bar/)).toHaveTextContent("4 beats a bar");
    expect(screen.getByText(/Hz/)).toHaveTextContent("A = 432 Hz · 32¢ flat");
    // 5.1 s at 120 BPM in 4/4 from 0: bar 3, beat 3.
    expect(screen.getByRole("img", { name: "Bar 3, beat 3 of 4" })).toBeInTheDocument();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
