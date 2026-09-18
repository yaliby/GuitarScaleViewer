import { describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION,
  parseSession,
  buildExercise,
  tuningMidi,
  canAutoApply,
} from "./session";

describe("practice session boundaries", () => {
  it("restores a valid setup and rejects unsupported settings without crashing", () => {
    expect(
      parseSession({ root: "Bb", scaleType: "major", tempo: 110, capo: 2 })
        .root,
    ).toBe("Bb");
    expect(
      parseSession({ root: "<bad>", scaleType: "bad", tempo: -20, capo: 99 }),
    ).toMatchObject({ root: "A", scaleType: "minor", tempo: 40, capo: 12 });
    expect(parseSession(null)).toEqual(DEFAULT_SESSION);
  });
  it("keeps stored progressions bounded and removes invalid degrees", () => {
    expect(
      parseSession({ progression: [0, 3, 4, 99, -1, "2"] }).progression,
    ).toEqual([0, 3, 4]);
  });
  it("normalizes a stored position index to the selected mode", () => {
    expect(
      parseSession({ positionMode: "full", positionIndex: 6 }).positionIndex,
    ).toBe(0);
    expect(
      parseSession({ positionMode: "pentatonic", positionIndex: 6 })
        .positionIndex,
    ).toBe(4);
    expect(
      parseSession({ positionMode: "caged", positionIndex: 5 }).positionIndex,
    ).toBe(4);
    expect(
      parseSession({ positionMode: "three-notes", positionIndex: 9 })
        .positionIndex,
    ).toBe(6);
  });
  it("maps alternate tunings to actual octaves, not just pitch classes", () => {
    expect(tuningMidi("drop-c")).toEqual([36, 43, 48, 53, 57, 62]);
    expect(tuningMidi("dadgad")).toEqual([38, 45, 50, 55, 57, 62]);
  });
  it("plays an up/down exercise without repeating the highest note", () => {
    expect(buildExercise([57, 60, 62], "up-down")).toEqual([57, 60, 62, 60]);
    expect(buildExercise([62, 57, 60, 57], "ascending")).toEqual([57, 60, 62]);
  });
  it("never automatically applies ambiguous or unready observations", () => {
    expect(
      canAutoApply({ readyToApply: false, ambiguous: true, confidence: 0.99 }),
    ).toBe(false);
    expect(
      canAutoApply({ readyToApply: true, ambiguous: false, confidence: 0.9 }),
    ).toBe(true);
  });
});
