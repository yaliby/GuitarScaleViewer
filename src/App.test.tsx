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
    primaryKey: "D",
    primaryScale: "major",
    displayName: "D major",
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
    cloudHit: null,
    resolutionState: "ready",
    source: "local_detected",
    sourceBadge: "Local audio detection",
    trackIdentity: "test-track",
    suggestionStatus: "idle",
    suggestionMessage: null,
    submitSuggestion: vi.fn(),
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
    primaryKey: "D",
    primaryScale: "major",
    displayName: "D major",
    confidence: 0.92,
    ambiguous: false,
    readyToApply: true,
  };
  mocks.cloud = { ...mocks.cloud, cloudHit: null };
  mocks.stop.mockClear();
  mocks.play.mockClear();
  mocks.audition.mockClear();
});

describe("practice studio shell", () => {
  it("opens a separate live jam without overwriting the practice setup", async () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText("Root note"), {
      target: { value: "Bb" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Live Jam" }));
    expect(
      await screen.findByRole("region", { name: "Live Jam workspace" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Tempo")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Choose key manually" }),
    );
    fireEvent.change(screen.getByLabelText("Jam root"), {
      target: { value: "G" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("jam-key")).toHaveTextContent("G"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Explore" }));
    expect(await screen.findByLabelText("Root note")).toHaveValue("Bb");
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
    render(<App />);
    fireEvent.click(screen.getByLabelText("Auto follow stable keys"));
    await waitFor(() =>
      expect(screen.getByLabelText("Root note")).toHaveValue("D"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Lock practice key" }));

    fireEvent.click(screen.getByRole("button", { name: "Load C minor setup" }));

    expect(screen.getByLabelText("Root note")).toHaveValue("C");
    expect(screen.getByLabelText("Scale type")).toHaveValue("minor");
    expect(screen.getByLabelText("Auto follow stable keys")).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "Unlock practice key" }),
    ).toBeInTheDocument();
  });

  it("resets the setup without silently unlocking it or reapplying Auto", async () => {
    render(<App />);
    fireEvent.click(screen.getByLabelText("Auto follow stable keys"));
    await waitFor(() =>
      expect(screen.getByLabelText("Root note")).toHaveValue("D"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Lock practice key" }));

    fireEvent.click(
      screen.getByRole("button", { name: "Reset practice setup" }),
    );

    expect(screen.getByLabelText("Root note")).toHaveValue("A");
    expect(screen.getByLabelText("Scale type")).toHaveValue("minor");
    expect(screen.getByLabelText("Auto follow stable keys")).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "Unlock practice key" }),
    ).toBeInTheDocument();
  });

  it("auto-applies only eligible results and keeps a locked context stable", async () => {
    const { rerender } = render(<App />);
    fireEvent.click(screen.getByLabelText("Auto follow stable keys"));
    await waitFor(() =>
      expect(screen.getByLabelText("Root note")).toHaveValue("D"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Lock practice key" }));
    mocks.detected = {
      ...mocks.detected,
      primaryKey: "C",
      displayName: "C major",
    };
    rerender(<App />);
    expect(screen.getByLabelText("Root note")).toHaveValue("D");

    fireEvent.click(
      screen.getByRole("button", { name: "Unlock practice key" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Root note")).toHaveValue("C"),
    );

    mocks.detected = {
      ...mocks.detected,
      primaryKey: "E",
      primaryScale: "minor",
      displayName: "E minor",
      confidence: 0.99,
      ambiguous: true,
      readyToApply: false,
    };
    rerender(<App />);
    expect(screen.getByLabelText("Root note")).toHaveValue("C");
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

  it("offers a major or minor practice key as a cloud-library suggestion", () => {
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", { name: "Connection & diagnostics" }),
    );

    expect(
      screen.getByRole("button", { name: "Suggest current key" }),
    ).toBeInTheDocument();
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
