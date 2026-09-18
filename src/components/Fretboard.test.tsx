import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { buildScaleNotes } from "../scaleSpell";
import { Fretboard } from "./Fretboard";

afterEach(cleanup);
const base = {
  openMidi: [40, 45, 50, 55, 59, 64],
  labels: ["E", "A", "D", "G", "B", "E"],
  labelMode: "notes" as const,
  display: "scale" as const,
  positions: null,
  chordPcs: null,
  activeMidi: [],
  onNote: vi.fn(),
};

it("announces the same theoretical spelling shown on scale notes", () => {
  render(
    <Fretboard
      {...base}
      notes={buildScaleNotes("C#", "major")}
      scaleType="major"
      capo={0}
      startFret={0}
      endFret={12}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Play E♯, string 6, fret 1" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Play B♯, string 5, fret 3" }),
  ).toBeInTheDocument();
});

it("honors a single playable fret at the capo boundary", () => {
  render(
    <Fretboard
      {...base}
      display="chromatic"
      notes={buildScaleNotes("A", "minor")}
      scaleType="minor"
      capo={12}
      startFret={12}
      endFret={12}
    />,
  );
  expect(screen.getAllByRole("button")).toHaveLength(6);
  expect(
    screen.queryByRole("button", { name: /fret 13/ }),
  ).not.toBeInTheDocument();
});
