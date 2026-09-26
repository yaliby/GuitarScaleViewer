// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapturedTrack } from "../services/trackCapture";

const tauri = vi.hoisted(() => ({ on: true }));
const api = vi.hoisted(() => ({
  cache: vi.fn<
    (
      file: File,
      progress: (stage: string, value: number) => void,
      signal?: AbortSignal,
    ) => Promise<{ analysis: { fingerprint: string } } | null>
  >(async () => ({ analysis: { fingerprint: "abc" } })),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => tauri.on,
  invoke: vi.fn(),
}));

vi.mock("./composition", () => ({
  cacheCapturedSong: (
    file: File,
    progress: (stage: string, value: number) => void,
    signal?: AbortSignal,
  ) => api.cache(file, progress, signal),
}));

vi.mock("../services/trackCapture", () => ({
  loadCapturedFile: vi.fn(async () => new File(["x"], "song.m4a")),
}));

import { enqueueChordAnalysis, resetBackgroundChordsForTests } from "./backgroundChords";
import { analyzedCaptureIds } from "./analyzedCaptures";
import { getChordJobs } from "./chordJobs";

const track: CapturedTrack = {
  id: "yt-1",
  path: "/tmp/yt-1.m4a",
  audioUrl: "/chordsync/audio?id=yt-1",
  title: "Fast Car",
  artist: "Tracy Chapman",
  album: null,
  engine: "youtube_search",
  webpageUrl: null,
  durationMs: 1000,
  artworkPath: null,
  artworkUrl: null,
  bytes: 10,
  cached: false,
  sourceApp: null,
  capturedAt: "2026-09-26T00:00:00Z",
};

beforeEach(() => {
  tauri.on = true;
  api.cache.mockReset();
  api.cache.mockResolvedValue({ analysis: { fingerprint: "abc" } });
  localStorage.clear();
  resetBackgroundChordsForTests();
});

describe("background chord extraction", () => {
  it("reads chords once and remembers the song", async () => {
    await enqueueChordAnalysis(track);
    expect(api.cache).toHaveBeenCalledTimes(1);
    expect(analyzedCaptureIds().has("yt-1")).toBe(true);
    await enqueueChordAnalysis(track);
    expect(api.cache).toHaveBeenCalledTimes(1);
  });

  it("does nothing outside the desktop app", async () => {
    tauri.on = false;
    await enqueueChordAnalysis(track);
    expect(api.cache).not.toHaveBeenCalled();
  });

  it("leaves the song unanalyzed when extraction fails", async () => {
    api.cache.mockRejectedValueOnce(new Error("runtime missing"));
    await enqueueChordAnalysis(track);
    expect(analyzedCaptureIds().has("yt-1")).toBe(false);
    expect(getChordJobs()["yt-1"]).toBeUndefined();
  });

  it("does not start a second extraction for the same song", async () => {
    let release!: (value: { analysis: { fingerprint: string } }) => void;
    api.cache.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = enqueueChordAnalysis(track);
    await vi.waitFor(() => expect(api.cache).toHaveBeenCalledTimes(1));
    const second = enqueueChordAnalysis(track);
    await second;
    expect(api.cache).toHaveBeenCalledTimes(1);
    release({ analysis: { fingerprint: "abc" } });
    await first;
    expect(analyzedCaptureIds().has("yt-1")).toBe(true);
  });
});
