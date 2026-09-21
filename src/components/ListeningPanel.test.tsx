import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ListeningPanel } from "./ListeningPanel";
import type { FusedKey } from "../services/keyFusion";
import type { DetectedKeyState } from "../hooks/useDetectedKey";
import type { MediaSessionUiState } from "../hooks/useMediaSession";

afterEach(cleanup);

/**
 * Explore has to say the same thing about a song that Live Jam does.
 *
 * It used to re-derive its own verdict from the raw `detected` payload, which meant the two
 * screens could disagree about the same track, and it told the player to "apply" a key using a
 * button deleted back in M0. Both are regressions worth a test rather than a comment.
 */
describe("ListeningPanel reports the pipeline's decision", () => {
  const media: MediaSessionUiState = {
    title: "Numb",
    artist: "Linkin Park",
    album: null,
    sourceApp: "spotify",
    playbackStatus: "playing",
    positionMs: 0,
    durationMs: 200_000,
  } as MediaSessionUiState;

  const detected = { displayName: "G major", alternatives: [] } as unknown as DetectedKeyState;

  const fused = (over: Partial<FusedKey> = {}): FusedKey => ({
    root: "G",
    scale: "major",
    displayName: "G major",
    source: "detected",
    certainty: "lone",
    confidencePct: 80,
    notesSettled: false,
    tonicSettled: true,
    relativeAlternative: null,
    trackIdentity: "numb",
    why: "engine_only",
    ...over,
  });

  const panel = (fusedKey: FusedKey) =>
    render(
      <ListeningPanel
        media={media}
        detected={detected}
        cloud={{ cloudHit: null } as never}
        fused={fusedKey}
        applyDetected={true}
        onToggleApply={vi.fn()}
        onRetry={vi.fn()}
        root="G"
        scale="major"
      />,
    );

  it("names the relative reading when the root is open", () => {
    panel(
      fused({
        certainty: "tonic_open",
        notesSettled: true,
        tonicSettled: false,
        relativeAlternative: "E minor",
      }),
    );
    expect(screen.getByTestId("explore-key-alt").textContent).toContain("E minor");
    expect(screen.getByText(/Notes sure, root open/i)).toBeTruthy();
  });

  it("does not offer a relative when the tonic is settled", () => {
    panel(fused());
    expect(screen.queryByTestId("explore-key-alt")).toBeNull();
  });

  it("never tells the player to press anything — Apply is already engaged", () => {
    for (const key of [fused(), fused({ certainty: "tonic_open", tonicSettled: false, relativeAlternative: "E minor" })]) {
      cleanup();
      panel(key);
      // The latch itself is allowed to say Apply. The copy around it must never ask for it:
      // the neck is already following, and the switch exists only to stop that.
      expect(
        screen.queryAllByText(/apply/i).filter((el) => el.closest("button") === null),
      ).toEqual([]);
      expect(
        screen.getByRole("button", { name: "Turn off Apply" }).getAttribute("aria-pressed"),
      ).toBe("true");
    }
  });

  it("shows the verified library as the source when a human entered the key", () => {
    panel(fused({ source: "verified", certainty: "verified", confidencePct: 100, notesSettled: true }));
    expect(screen.getByText(/verified song library/i)).toBeTruthy();
  });
});
