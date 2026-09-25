// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayAlongPayload } from "../playalong/types";
import type { MediaSessionUiState } from "./useMediaSession";

const api = vi.hoisted(() => ({
  resolve: vi.fn(),
  follow: vi.fn(),
}));

vi.mock("../playalong/resolve", () => ({
  resolvePlayalong: api.resolve,
  followPlayalong: api.follow,
}));

import { usePlayAlong } from "./usePlayAlong";

function media(over: Partial<MediaSessionUiState> = {}): MediaSessionUiState {
  return {
    title: "First song",
    artist: "First artist",
    album: "First album",
    sourceApp: "Spotify",
    playbackStatus: "playing",
    positionMs: 12_000,
    durationMs: 180_000,
    ...over,
  };
}

function payload(title: string): PlayAlongPayload {
  return {
    status: "lyrics",
    track: { title, artist: "Artist", album: null },
    lyrics: {
      provider: "LRCLIB",
      title,
      artist: "Artist",
      plain: null,
      synced: [
        { index: 0, timeMs: 1_000, text: `${title} line one` },
        { index: 1, timeMs: 2_000, text: `${title} line two` },
      ],
      confidence: 1,
    },
    chart: null,
    chartHtml: `<html><body>${title}</body></html>`,
  };
}

describe("usePlayAlong", () => {
  beforeEach(() => {
    api.resolve.mockReset();
    api.follow.mockReset();
    api.resolve.mockImplementation(async ({ title }: { title: string }) =>
      payload(title),
    );
    api.follow.mockResolvedValue({
      status: "ok",
      lyricIndex: 0,
      chartIndex: 0,
      positionMs: 12_050,
      singingSource: "lrc",
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("clears the old chart immediately when the OS track changes", async () => {
    let keepSecondPending!: () => void;
    api.resolve.mockImplementation(({ title }: { title: string }) => {
      if (title === "Second song") {
        return new Promise<PlayAlongPayload>((resolve) => {
          keepSecondPending = () => resolve(payload(title));
        });
      }
      return Promise.resolve(payload(title));
    });
    const { result, rerender } = renderHook(
      ({ value }) => usePlayAlong(value),
      { initialProps: { value: media() } },
    );

    await waitFor(() =>
      expect(result.current.payload?.track?.title).toBe("First song"),
    );

    rerender({
      value: media({
        title: "Second song",
        artist: "Second artist",
        album: "Second album",
      }),
    });

    expect(result.current.status).toBe("loading");
    expect(result.current.payload).toBeNull();
    expect(result.current.lyricIndex).toBeNull();
    expect(result.current.chartIndex).toBeNull();

    act(() => keepSecondPending());
    await waitFor(() =>
      expect(result.current.payload?.track?.title).toBe("Second song"),
    );
  });

  it("keeps a manual search as the follow target while media keeps playing", async () => {
    const { result } = renderHook(() => usePlayAlong(media()));
    await waitFor(() =>
      expect(result.current.payload?.track?.title).toBe("First song"),
    );
    api.follow.mockClear();

    act(() => {
      result.current.search("Manual song", "Manual artist");
    });

    await waitFor(() =>
      expect(api.follow).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Manual song",
          artist: "Manual artist",
          positionMs: 12_000,
        }),
      ),
    );
    expect(result.current.payload?.track?.title).toBe("Manual song");
  });

  it("ignores an in-flight follow response from the previous track", async () => {
    let releaseOldFollow!: (value: unknown) => void;
    api.follow.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseOldFollow = resolve;
        }),
    );
    api.follow.mockResolvedValue(null);
    const { result } = renderHook(() => usePlayAlong(media()));
    await waitFor(() => expect(api.follow).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.search("Manual song", "Manual artist");
    });
    expect(result.current.chartIndex).toBeNull();

    await act(async () => {
      releaseOldFollow({
        status: "ok",
        lyricIndex: 9,
        chartIndex: 9,
        positionMs: 99_000,
        singingSource: "lrc",
      });
      await Promise.resolve();
    });

    expect(result.current.lyricIndex).toBeNull();
    expect(result.current.chartIndex).toBeNull();
  });

  it("stops following stale media after the OS session disappears", async () => {
    const { rerender } = renderHook(({ value }) => usePlayAlong(value), {
      initialProps: { value: media() },
    });
    await waitFor(() => expect(api.follow).toHaveBeenCalled());
    api.follow.mockClear();

    rerender({
      value: media({
        title: null,
        artist: null,
        album: null,
        sourceApp: null,
        playbackStatus: "none",
        positionMs: null,
        durationMs: null,
      }),
    });
    await new Promise((resolve) => window.setTimeout(resolve, 100));

    expect(api.follow).not.toHaveBeenCalled();
  });
});
