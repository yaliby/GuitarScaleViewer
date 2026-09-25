// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import PlayAlongScreen, { ChordSyncChart } from "./PlayAlongScreen";
import type { FusedKey } from "./services/keyFusion";

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

vi.mock("./hooks/useMediaSession", () => ({
  useMediaSession: () => media,
}));

afterEach(() => {
  cleanup();
});

const fused: FusedKey = {
  root: "A",
  scale: "minor",
  displayName: "A minor",
  source: "detected",
  certainty: "lone",
  confidencePct: 70,
  notesSettled: false,
  tonicSettled: true,
  relativeAlternative: null,
  trackIdentity: "test",
  noteSetP: null,
  why: "test",
};

describe("PlayAlongScreen", () => {
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

  it("mounts the play-along workspace on the same OS now-playing session as Live Jam", () => {
    render(
      <PlayAlongScreen
        root="A"
        scaleType="minor"
        fused={fused}
        menuOpen={false}
        onToggleMenu={() => {}}
        onOpenJam={() => {}}
      />,
    );
    expect(
      screen.getByRole("region", { name: "Play Along workspace" }),
    ).toBeDefined();
    expect(screen.getByTestId("playalong-key").textContent).toMatch(/A/);
    expect(screen.getByRole("button", { name: "Live Jam" })).toBeDefined();
    expect(screen.getByLabelText("Song title")).toBeDefined();
    expect(screen.getByRole("button", { name: "Search" })).toBeDefined();
    expect(screen.getByText("Waiting for a sung line…")).toBeDefined();
    expect(screen.getByTestId("playalong-now-playing").textContent).toMatch(
      /Test song/,
    );
    expect(screen.getByTestId("playalong-now-playing").textContent).toMatch(
      /Test artist/,
    );
    expect(screen.getByTestId("playalong-now-playing").textContent).toMatch(
      /0:12 \/ 3:00/,
    );
    expect(screen.getByTestId("playalong-now-playing").textContent).toMatch(
      /Test player/,
    );
  });

  it("opens YouTube CC and Whisper lanes from the Dev toggle", () => {
    render(
      <PlayAlongScreen
        root="A"
        scaleType="minor"
        fused={fused}
        menuOpen={false}
        onToggleMenu={() => {}}
        onOpenJam={() => {}}
      />,
    );
    expect(screen.queryByTestId("playalong-dev")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dev" }));
    expect(screen.getByTestId("playalong-dev")).toBeDefined();
    expect(screen.getByRole("region", { name: "YouTube CC" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Whisper" })).toBeDefined();
  });
});
