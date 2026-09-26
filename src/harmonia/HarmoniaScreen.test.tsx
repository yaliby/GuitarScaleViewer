import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import HarmoniaScreen from "./HarmoniaScreen";
import { resetChordJobsForTests, setChordJob } from "./chordJobs";

const mocks = vi.hoisted(() => {
  const snapshot = {
    status: "idle" as const,
    stage: "",
    progress: 0,
    current: null,
    library: [],
    error: null,
    profile: "balanced" as const,
    saveState: "saved" as const,
  };
  return {
    prepare: vi.fn(async (_file?: File, _force?: boolean, _stale?: () => boolean) => undefined),
    pause: vi.fn(),
    cancel: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    snapshot,
    tracks: [
      {
        id: "yt-abc",
        path: "/tmp/yt-abc.m4a",
        audioUrl: "/chordsync/audio?id=yt-abc",
        title: "Fast Car",
        artist: "Tracy Chapman",
        album: null,
        engine: "youtube_search" as const,
        webpageUrl: null,
        durationMs: 232000,
        artworkPath: null,
        artworkUrl: null,
        bytes: 12,
        cached: true,
        sourceApp: "Spotify",
        capturedAt: "2026-09-25T00:00:00Z",
      },
    ],
  };
});

vi.mock("../hooks/useMediaSession", () => ({
  useMediaSession: () => ({
    title: null,
    artist: null,
    album: null,
    sourceApp: null,
    playbackStatus: "stopped",
    positionMs: 0,
    durationMs: 0,
  }),
}));

vi.mock("../hooks/useTrackCapture", () => ({
  useTrackCapture: () => ({
    status: "idle",
    progressPct: null,
    stage: null,
    track: null,
    error: null,
    query: "",
    autoEnabled: true,
    playing: false,
    setQuery: vi.fn(),
    setAutoEnabled: vi.fn(),
    captureNow: vi.fn(),
    captureQuery: vi.fn(),
    togglePlayback: vi.fn(),
  }),
}));

vi.mock("../services/trackCapture", async () => {
  const actual = await vi.importActual<typeof import("../services/trackCapture")>(
    "../services/trackCapture",
  );
  return {
    ...actual,
    listTrackCaptures: vi.fn(async () => ({
      status: "ok",
      track: null,
      tracks: mocks.tracks,
    })),
    loadCapturedFile: vi.fn(async () => new File([new Uint8Array(32)], "Fast Car.m4a")),
  };
});

vi.mock("./composition", () => ({
  pauseHarmoniaPlayback: vi.fn(),
  prepareCapturedSong: (...args: [File, boolean?, (() => boolean)?]) => mocks.prepare(...args),
  cacheCapturedSong: vi.fn(),
  getHarmoniaSession: vi.fn(async () => ({
    subscribe: mocks.subscribe,
    snapshot: () => mocks.snapshot,
    cancel: mocks.cancel,
    player: { pause: mocks.pause },
  })),
}));

afterEach(() => {
  cleanup();
  mocks.prepare.mockClear();
  resetChordJobsForTests();
});

describe("HarmoniaScreen", () => {
  it("lists captured songs as the library", async () => {
    render(<HarmoniaScreen menuOpen={false} onToggleMenu={() => undefined} />);
    expect(await screen.findByRole("button", { name: "Open Fast Car" })).toBeInTheDocument();
    expect(screen.getByText("Tracy Chapman · 3:52")).toBeInTheDocument();
    expect(screen.getByText("Analyze")).toBeInTheDocument();
  });

  it("opens a captured song for whole-song analysis", async () => {
    render(<HarmoniaScreen menuOpen={false} onToggleMenu={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Fast Car" }));
    await waitFor(() =>
      expect(mocks.prepare).toHaveBeenCalledWith(
        expect.any(File),
        false,
        expect.any(Function),
      ),
    );
  });

  it("leaves the library up while chords are read in the background", async () => {
    setChordJob("yt-abc", { stage: "Recognizing harmony", progress: 0.4 });
    render(<HarmoniaScreen menuOpen={false} onToggleMenu={() => undefined} />);
    expect(await screen.findByRole("button", { name: "Open Fast Car" })).toBeInTheDocument();
    expect(screen.getByText("Chords…")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /songs this app has saved/i })).toBeInTheDocument();
  });
});
