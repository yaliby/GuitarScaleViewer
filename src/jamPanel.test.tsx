import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lyric = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let jobs: Record<string, { progress: number; stage: string }> = {};
  return {
    ensure: vi.fn(),
    listeners,
    jobs: () => jobs,
    setJob(id: string, job: { progress: number; stage: string } | null) {
      jobs = { ...jobs };
      if (job) jobs[id] = job;
      else delete jobs[id];
      listeners.forEach((listener) => listener());
    },
    reset() {
      jobs = {};
    },
  };
});

vi.mock("./services/lyricMap", () => ({
  ensureLyricMap: (id: string) => lyric.ensure(id),
  getLyricJobs: () => lyric.jobs(),
  subscribeLyricJobs: (listener: () => void) => {
    lyric.listeners.add(listener);
    return () => lyric.listeners.delete(listener);
  },
}));

import { markCaptureAnalyzed } from "./harmonia/analyzedCaptures";
import { resetChordJobsForTests, setChordJob } from "./harmonia/chordJobs";
import {
  choosePanel,
  resetJamPanelForTests,
  setAutoSheet,
  useJamPanel,
  useSheetFollow,
} from "./jamPanel";

function Harness({ trackId }: { trackId: string | null }) {
  const { panel } = useJamPanel();
  const status = useSheetFollow(trackId);
  return (
    <div>
      <output data-testid="panel">{panel}</output>
      <output data-testid="sheet">{status}</output>
      <button type="button" onClick={() => choosePanel("chart")}>
        chart
      </button>
    </div>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const panel = () => screen.getByTestId("panel").textContent;

beforeEach(() => {
  localStorage.clear();
  lyric.reset();
  resetChordJobsForTests();
  resetJamPanelForTests();
  lyric.ensure.mockImplementation(async () => ({ lines: [] }));
});

afterEach(() => {
  cleanup();
});

describe("Live Jam's panel", () => {
  it("opens on the key's chord bank and remembers a pick by hand", () => {
    render(<Harness trackId={null} />);
    expect(panel()).toBe("chords");

    fireEvent.click(screen.getByRole("button", { name: "chart" }));
    expect(panel()).toBe("chart");
    expect(localStorage.getItem("gsv.jam.panel")).toBe("chart");

    cleanup();
    resetJamPanelForTests();
    render(<Harness trackId={null} />);
    expect(panel()).toBe("chart");
  });

  it("stays where the player put it while the switch is off", async () => {
    markCaptureAnalyzed("song-a", "fp-a");
    render(<Harness trackId="song-a" />);
    expect(screen.getByTestId("sheet")).toHaveTextContent("ready");
    await act(async () => undefined);
    expect(panel()).toBe("chords");
    expect(lyric.ensure).not.toHaveBeenCalled();
  });

  it("moves to the sheet once the chords are read and the lyric timing has settled", async () => {
    setAutoSheet(true);
    choosePanel("chart");
    setChordJob("song-a", { stage: "Recognizing harmony", progress: 0.4 });
    const timing = deferred<unknown>();
    lyric.ensure.mockImplementation(() => timing.promise);
    render(<Harness trackId="song-a" />);
    expect(screen.getByTestId("sheet")).toHaveTextContent("working");

    act(() => {
      markCaptureAnalyzed("song-a", "fp-a");
      setChordJob("song-a", null);
      lyric.setJob("song-a", { progress: 30, stage: "listen" });
    });
    expect(lyric.ensure).toHaveBeenCalledWith("song-a");
    expect(screen.getByTestId("sheet")).toHaveTextContent("working");
    expect(panel()).toBe("chart");

    await act(async () => {
      lyric.setJob("song-a", null);
      timing.resolve({ lines: [] });
    });
    expect(panel()).toBe("sheet");
    expect(screen.getByTestId("sheet")).toHaveTextContent("ready");
    /* The detour is not the player's pick: a restart opens where they left it. */
    expect(localStorage.getItem("gsv.jam.panel")).toBe("chart");
  });

  it("still moves when the lyric timing fails: the chords alone are the sheet", async () => {
    setAutoSheet(true);
    markCaptureAnalyzed("song-a", "fp-a");
    lyric.ensure.mockImplementation(async () => {
      throw new Error("Whisper is not installed");
    });
    render(<Harness trackId="song-a" />);
    await waitFor(() => expect(panel()).toBe("sheet"));
  });

  it("moves once per song, so a pick by hand afterwards sticks", async () => {
    setAutoSheet(true);
    markCaptureAnalyzed("song-a", "fp-a");
    const { rerender } = render(<Harness trackId="song-a" />);
    await waitFor(() => expect(panel()).toBe("sheet"));

    fireEvent.click(screen.getByRole("button", { name: "chart" }));
    act(() => markCaptureAnalyzed("song-a", "fp-a2"));
    rerender(<Harness trackId="song-a" />);
    await act(async () => undefined);
    expect(panel()).toBe("chart");
  });

  it("puts the panel back for a song without a sheet, and moves again when it has one", async () => {
    setAutoSheet(true);
    choosePanel("chart");
    markCaptureAnalyzed("song-a", "fp-a");
    const { rerender } = render(<Harness trackId="song-a" />);
    await waitFor(() => expect(panel()).toBe("sheet"));

    rerender(<Harness trackId="song-b" />);
    expect(panel()).toBe("chart");

    act(() => markCaptureAnalyzed("song-b", "fp-b"));
    await waitFor(() => expect(panel()).toBe("sheet"));
  });

  it("stays on the sheet from one analysed song to the next", async () => {
    setAutoSheet(true);
    markCaptureAnalyzed("song-a", "fp-a");
    markCaptureAnalyzed("song-b", "fp-b");
    const { rerender } = render(<Harness trackId="song-a" />);
    await waitFor(() => expect(panel()).toBe("sheet"));

    rerender(<Harness trackId="song-b" />);
    expect(panel()).toBe("sheet");
    await waitFor(() => expect(lyric.ensure).toHaveBeenCalledWith("song-b"));
    expect(panel()).toBe("sheet");
  });

  it("moves at once when the switch goes on over a finished analysis, and remembers the switch", async () => {
    markCaptureAnalyzed("song-a", "fp-a");
    render(<Harness trackId="song-a" />);
    act(() => setAutoSheet(true));
    /* Turning the switch on is asking for the sheet as soon as it is there — and it is. */
    await waitFor(() => expect(panel()).toBe("sheet"));
    expect(localStorage.getItem("gsv.jam.autoSheet")).toBe("1");

    act(() => setAutoSheet(false));
    expect(localStorage.getItem("gsv.jam.autoSheet")).toBe("0");
  });
});
