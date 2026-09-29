// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChordSyncChart, PlayAlongPanel } from "./PlayAlongPanel";

vi.stubGlobal(
  "fetch",
  vi.fn(async () => ({ ok: false, status: 404, json: async () => null })),
);

const media = {
  title: "Test song",
  artist: "Test artist",
  album: null as string | null,
  sourceApp: "Test player",
  playbackStatus: "playing",
  positionMs: 12_000,
  durationMs: 180_000,
};

vi.mock("../hooks/useMediaSession", () => ({
  useMediaSession: () => media,
}));

afterEach(() => {
  cleanup();
});

describe("PlayAlongPanel", () => {
  it("reloads a lyrics-only chart when its HTML changes under the same source", () => {
    const { rerender } = render(
      <ChordSyncChart
        html="<html><body>First song</body></html>"
        activeIndex={null}
        sourceUrl={null}
      />,
    );
    const frame = screen.getByTitle("Chord chart");
    expect(frame.getAttribute("srcdoc")).toContain("First song");

    rerender(
      <ChordSyncChart
        html="<html><body>Second song</body></html>"
        activeIndex={null}
        sourceUrl={null}
      />,
    );
    expect(frame.getAttribute("srcdoc")).toContain("Second song");
  });

  it("follows the same OS now-playing session as the rest of Live Jam", () => {
    render(<PlayAlongPanel />);
    expect(screen.getByRole("region", { name: "Play along chart" })).toBeDefined();
    expect(screen.getByLabelText("Song title")).toBeDefined();
    expect(screen.getByRole("button", { name: "Search" })).toBeDefined();
    expect(screen.getByText("Waiting for a sung line…")).toBeDefined();
    expect(screen.getByRole("region", { name: "Synced lyrics" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Chord chart" })).toBeDefined();
    const nowPlaying = screen.getByTestId("playalong-now-playing").textContent;
    expect(nowPlaying).toMatch(/Test song/);
    expect(nowPlaying).toMatch(/Test artist/);
    expect(nowPlaying).toMatch(/0:12 \/ 3:00/);
    expect(nowPlaying).toMatch(/Test player/);
  });

  it("opens YouTube CC and Whisper lanes from the Dev toggle", () => {
    render(<PlayAlongPanel />);
    expect(screen.queryByTestId("playalong-dev")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dev" }));
    expect(screen.getByTestId("playalong-dev")).toBeDefined();
    expect(screen.getByRole("region", { name: "YouTube CC" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Whisper" })).toBeDefined();
  });
});
