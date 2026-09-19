import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

const mocks = vi.hoisted(() => ({
  media: {
    title: "Test song",
    artist: "Test artist",
    album: null,
    sourceApp: "Test player",
    playbackStatus: "playing",
    positionMs: 0,
    durationMs: 180_000,
  },
  detected: {
    primaryKey: null as string | null,
    primaryScale: null as string | null,
    displayName: null as string | null,
    confidence: 0.92,
    stability: 0.9,
    alternatives: [],
    source: "audio_analysis",
    captureMode: "process_loopback",
    targetApp: "Test player",
    enoughAudio: true,
    bufferSeconds: 12,
    windowCount: 5,
    ambiguous: false,
    reason: null,
    state: "likely_key",
    readyToApply: true,
  },
  cloud: {
    cloudState: "miss",
    cloudError: null,
    cloudHit: null as {
      key: string;
      mode: "major" | "minor";
      displayName: string;
      verified: boolean;
      source: "verified_library";
      sourceLabel: string;
    } | null,
    resolutionState: "ready",
    source: "local_detected",
    sourceBadge: "Local audio detection",
    trackIdentity: "test-track",
  },
  resetDetection: vi.fn(),
  stop: vi.fn(),
  play: vi.fn(),
  audition: vi.fn(),
}));

vi.mock("./hooks/useMediaSession", () => ({
  useMediaSession: () => mocks.media,
}));
vi.mock("./hooks/useDetectedKey", () => ({
  useDetectedKey: () => ({
    detectedKey: mocks.detected,
    detectedKeyAb: null,
    resetDetection: mocks.resetDetection,
  }),
}));
vi.mock("./hooks/useCloudKeyResolution", () => ({
  useCloudKeyResolution: () => mocks.cloud,
}));
vi.mock("./audio/usePracticeAudio", () => ({
  usePracticeAudio: () => ({
    playing: null,
    step: { notes: [], index: -1 },
    error: null,
    stop: mocks.stop,
    play: mocks.play,
    audition: mocks.audition,
  }),
}));

import App from "./App";

afterEach(() => cleanup());

beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  localStorage.clear();
  mocks.detected = {
    ...mocks.detected,
    primaryKey: null,
    primaryScale: null,
    displayName: null,
    confidence: 0,
    ambiguous: true,
    readyToApply: false,
  };
  mocks.cloud = { ...mocks.cloud, cloudHit: null };
  mocks.stop.mockClear();
  mocks.play.mockClear();
  mocks.audition.mockClear();
});

/**
 * The engine reporting a key. Nothing is armed and nothing is pressed afterwards: putting a
 * reading on the wire is the whole of the interaction, because the neck follows the song by
 * itself. See services/keyFusion.
 */
function hearing(
  primaryKey: string,
  primaryScale: "major" | "minor",
  over: Partial<typeof mocks.detected> = {},
) {
  mocks.detected = {
    ...mocks.detected,
    primaryKey,
    primaryScale,
    displayName: `${primaryKey} ${primaryScale}`,
    confidence: 0.92,
    ambiguous: false,
    readyToApply: true,
    ...over,
  };
}

describe("practice studio shell", () => {
  it("puts the heard key on the neck with nothing pressed", async () => {
    // The iron rule. There is no latch to arm and no Apply to press: a player holding a guitar
    // gets the scale by playing the song, and that is the only interaction there is.
    hearing("D", "major");
    render(<App />);

    await waitFor(() =>
      expect(screen.getByLabelText("Root note")).toHaveValue("D"),
    );
    expect(screen.getByLabelText("Scale type")).toHaveValue("major");
  });

  it("keeps a verified library key even when the engine names something else", async () => {
    mocks.cloud = {
      ...mocks.cloud,
      cloudState: "hit",
      cloudHit: {
        key: "A",
        mode: "minor",
        displayName: "A minor",
        verified: true,
        source: "verified_library",
        sourceLabel: "Verified library",
      },
      resolutionState: "cloud_hit",
      source: "cloud_verified",
      sourceBadge: "Verified library key",
    };
    const { rerender } = render(<App />);
    await waitFor(() =>
      expect(screen.getByLabelText("Root note")).toHaveValue("A"),
    );

    hearing("G", "major");
    rerender(<App />);
    await waitFor(() =>
      expect(screen.getByLabelText("Root note")).toHaveValue("A"),
    );
    expect(screen.getByLabelText("Scale type")).toHaveValue("minor");
  });

  it("leaves a hand-picked key alone until the song itself changes", async () => {
    // Following unasked must not mean overriding a deliberate choice. The pipeline only acts
    // when its own answer changes, so an edit stands until the music moves on.
    hearing("D", "major");
    render(<App />);
    await waitFor(() =>
      expect(screen.getByLabelText("Root note")).toHaveValue("D"),
    );

    fireEvent.change(screen.getByLabelText("Root note"), {
      target: { value: "Bb" },
    });
    expect(screen.getByLabelText("Root note")).toHaveValue("Bb");
  });

  it("opens live jam full-window on the shared key and carries edits back", async () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText("Root note"), {
      target: { value: "Bb" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Live Jam" }));

    const jam = await screen.findByRole("region", { name: "Live Jam workspace" });
    expect(jam).toBeInTheDocument();
    /* Immersive: no transport, and the nav is behind the hamburger. */
    expect(screen.queryByLabelText("Tempo")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open navigation menu" }),
    ).toBeInTheDocument();

    const jamRoot = screen.getByPlaceholderText("A");
    expect(jamRoot).toHaveValue("Bb");
    fireEvent.change(jamRoot, { target: { value: "G" } });

    fireEvent.click(screen.getByRole("button", { name: "Open navigation menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Explore" }));
    expect(await screen.findByLabelText("Root note")).toHaveValue("G");
  });
  it("updates and persists the shared musical context", async () => {
    render(<App />);

    expect(
      screen.getByRole("group", { name: "Interactive guitar fretboard" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Root note"), {
      target: { value: "Bb" },
    });
    fireEvent.change(screen.getByLabelText("Scale type"), {
      target: { value: "major" },
    });

    expect(screen.getByTestId("scale-title")).toHaveTextContent("B♭ major");
    await waitFor(() =>
      expect(
        JSON.parse(localStorage.getItem("fretboard-studio.session.v1") ?? "{}"),
      ).toMatchObject({ root: "Bb", scaleType: "major" }),
    );
  });

  it("saves a named favorite and restores its setup", async () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText("Root note"), {
      target: { value: "D" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save setup" }));
    fireEvent.change(screen.getByLabelText("Setup name"), {
      target: { value: "D practice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save favorite" }));

    fireEvent.change(screen.getByLabelText("Root note"), {
      target: { value: "G" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load D practice" }));

    expect(screen.getByLabelText("Root note")).toHaveValue("D");
    await waitFor(() =>
      expect(
        JSON.parse(
          localStorage.getItem("fretboard-studio.favorites.v1") ?? "[]",
        ),
      ).toHaveLength(1),
    );
  });

  it("loads a favorite without silently unlocking it or letting Auto overwrite it", async () => {
    localStorage.setItem(
      "fretboard-studio.favorites.v1",
      JSON.stringify([
        {
          id: "saved-c-minor",
          name: "C minor setup",
          session: { root: "C", scaleType: "minor" },
        },
      ]),
    );
    hearing("D", "major");
    render(<App />);
    await waitFor(() =>
      expect(screen.getByLabelText("Root note")).toHaveValue("D"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Lock practice key" }));

    fireEvent.click(screen.getByRole("button", { name: "Load C minor setup" }));

    expect(screen.getByLabelText("Root note")).toHaveValue("C");
    expect(screen.getByLabelText("Scale type")).toHaveValue("minor");
    expect(
      screen.getByRole("button", { name: "Unlock practice key" }),
    ).toBeInTheDocument();
  });

  it("resets the setup without silently unlocking it", async () => {
    hearing("D", "major");
    render(<App />);
    await waitFor(() =>
      expect(screen.getByLabelText("Root note")).toHaveValue("D"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Lock practice key" }));

    fireEvent.click(
      screen.getByRole("button", { name: "Reset practice setup" }),
    );

    expect(screen.getByLabelText("Root note")).toHaveValue("A");
    expect(screen.getByLabelText("Scale type")).toHaveValue("minor");
    expect(
      screen.getByRole("button", { name: "Unlock practice key" }),
    ).toBeInTheDocument();
  });

  it("follows the song unasked, and stops dead at a lock", async () => {
    hearing("D", "major");
    const { rerender } = render(<App />);
    await waitFor(() =>
      expect(screen.getByLabelText("Root note")).toHaveValue("D"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Lock practice key" }));
    hearing("C", "major");
    rerender(<App />);
    expect(screen.getByLabelText("Root note")).toHaveValue("D");

    fireEvent.click(
      screen.getByRole("button", { name: "Unlock practice key" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Root note")).toHaveValue("C"),
    );

    // An unsure reading still has to clear the revision margin against the key already up.
    // It does not, so the neck stays where it is rather than chasing a hedge.
    hearing("E", "minor", { confidence: 0.99, ambiguous: true, readyToApply: false });
    rerender(<App />);
    expect(screen.getByLabelText("Root note")).toHaveValue("C");
  });

  it("puts the pipeline key back on the neck when the player unlocks after a hand edit", async () => {
    // The Stairway case: the deck already reads A minor, the board was left on G, and Unlock
    // must mean "follow the song again" — not "keep sitting on the leftover key".
    hearing("A", "minor");
    render(<App />);
    await waitFor(() =>
      expect(screen.getByLabelText("Root note")).toHaveValue("A"),
    );

    fireEvent.change(screen.getByLabelText("Root note"), {
      target: { value: "G" },
    });
    fireEvent.change(screen.getByLabelText("Scale type"), {
      target: { value: "major" },
    });
    expect(screen.getByLabelText("Root note")).toHaveValue("G");

    fireEvent.click(screen.getByRole("button", { name: "Lock practice key" }));
    fireEvent.click(screen.getByRole("button", { name: "Unlock practice key" }));

    await waitFor(() =>
      expect(screen.getByLabelText("Root note")).toHaveValue("A"),
    );
    expect(screen.getByLabelText("Scale type")).toHaveValue("minor");
  });

  it("live jam follows the heard key onto a leftover board after unlock", async () => {
    hearing("A", "minor");
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Live Jam" }));

    const jamRoot = await screen.findByPlaceholderText("A");
    await waitFor(() => expect(jamRoot).toHaveValue("A"));

    fireEvent.change(jamRoot, { target: { value: "G" } });
    fireEvent.change(screen.getByDisplayValue("Natural minor (Aeolian)"), {
      target: { value: "major" },
    });
    expect(jamRoot).toHaveValue("G");

    fireEvent.click(screen.getByRole("button", { name: "Lock" }));
    fireEvent.click(screen.getByRole("button", { name: "Locked" }));

    await waitFor(() => expect(jamRoot).toHaveValue("A"));
    expect(screen.getByDisplayValue("Natural minor (Aeolian)")).toBeInTheDocument();
  });

  it("exposes exercise direction and scale-note audition in the practice view", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Practice" }));
    fireEvent.change(await screen.findByLabelText("Exercise direction"), {
      target: { value: "descending" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Hear A" }));

    expect(screen.getByLabelText("Exercise direction")).toHaveValue(
      "descending",
    );
    expect(mocks.audition).toHaveBeenCalledWith([69]);
    expect(screen.getByTestId("position-description")).toHaveTextContent("15");
  });

  it("expands named positions for their active tuning without shrinking the neck", () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText("Root note"), {
      target: { value: "C" },
    });
    fireEvent.change(screen.getByLabelText("Scale type"), {
      target: { value: "major" },
    });
    fireEvent.change(screen.getByLabelText("Tuning"), {
      target: { value: "drop-d" },
    });
    fireEvent.change(screen.getByLabelText("Position family"), {
      target: { value: "three-notes" },
    });

    expect(screen.getByLabelText("Visible frets")).toHaveValue("24");
    fireEvent.change(screen.getByLabelText("Position family"), {
      target: { value: "pentatonic" },
    });
    expect(screen.getByLabelText("Visible frets")).toHaveValue("24");
  });

  it("labels a position clipped by the fret limit and prevents its scale exercise", () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText("Root note"), {
      target: { value: "C" },
    });
    fireEvent.change(screen.getByLabelText("Scale type"), {
      target: { value: "major" },
    });
    fireEvent.change(screen.getByLabelText("Tuning"), {
      target: { value: "drop-d" },
    });
    fireEvent.change(screen.getByLabelText("Visible frets"), {
      target: { value: "24" },
    });
    fireEvent.change(screen.getByLabelText("Position family"), {
      target: { value: "three-notes" },
    });
    fireEvent.change(screen.getByLabelText("Visible frets"), {
      target: { value: "15" },
    });

    expect(screen.getByTestId("position-description")).toHaveTextContent(
      /Partial.*Show 24 visible frets/i,
    );
    expect(
      screen.getByRole("button", { name: "Play scale exercise" }),
    ).toBeDisabled();
  });

  it("labels a position clipped by the capo and prevents its scale exercise", () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText("Position family"), {
      target: { value: "pentatonic" },
    });
    fireEvent.change(screen.getByLabelText("Capo"), {
      target: { value: "6" },
    });

    expect(screen.getByTestId("position-description")).toHaveTextContent(
      /Partial.*Lower the capo to fret 5 or earlier/i,
    );
    expect(
      screen.getByRole("button", { name: "Play scale exercise" }),
    ).toBeDisabled();
  });

  it("stops playback for exercise changes while keeping volume and labels live", () => {
    render(<App />);
    mocks.stop.mockClear();

    fireEvent.change(screen.getByLabelText("Playback volume"), {
      target: { value: "0.7" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Intervals" }));
    expect(mocks.stop).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Tempo"), {
      target: { value: "95" },
    });
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });
});
