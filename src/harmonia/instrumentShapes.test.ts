import { describe, expect, it } from "vitest";
import { parseChord } from "../../harmonia/packages/domain/chord";
import { chordShapes, type FretShape } from "./instrumentShapes";

const frets = (shape: FretShape) =>
  shape.strings.map((_, string) => shape.marks.find((mark) => mark.string === string)?.fret ?? null);

describe("chordShapes", () => {
  it("finds the familiar first-position ukulele grips", () => {
    expect(frets(chordShapes(parseChord("C"), "ukulele").shapes[0] as FretShape)).toEqual([0, 0, 0, 3]);
    expect(frets(chordShapes(parseChord("Am"), "ukulele").shapes[0] as FretShape)).toEqual([2, 0, 0, 0]);
    expect(frets(chordShapes(parseChord("G"), "ukulele").shapes[0] as FretShape)).toEqual([0, 2, 3, 2]);
  });

  it("keeps the root in the mandolin's bass", () => {
    const shape = chordShapes(parseChord("G"), "mandolin").shapes[0] as FretShape;
    expect(frets(shape)).toEqual([0, 0, 2, 3]);
  });

  it("drops the fifth first when a chord has more tones than strings", () => {
    const result = chordShapes(parseChord("C9"), "ukulele");
    expect(result.shapes.length).toBeGreaterThan(0);
    expect(result.note).toMatch(/leaves out one tone/);
  });

  it("boxes the bass note low on the neck with the chord tones around it", () => {
    const shape = chordShapes(parseChord("A"), "bass").shapes[0] as FretShape;
    expect(shape.name).toBe("Bass note on the A string, open");
    expect(shape.marks.filter((mark) => mark.root).length).toBeGreaterThan(0);
    const slash = chordShapes(parseChord("C/E"), "bass").shapes[0] as FretShape;
    expect(slash.name).toBe("Bass note on the E string, open");
  });

  it("uses the guitar library and a one-hand piano voicing", () => {
    const guitar = chordShapes(parseChord("E"), "guitar").shapes[0] as FretShape;
    expect(frets(guitar)).toEqual([0, 2, 2, 1, 0, 0]);
    const piano = chordShapes(parseChord("C"), "piano").shapes[0]!;
    expect(piano.kind === "keys" && piano.midiNotes.map((note) => note % 12)).toEqual([0, 4, 7]);
  });

  it("has nothing to show for no chord", () => {
    expect(chordShapes({ kind: "none" }, "guitar").shapes).toEqual([]);
  });
});
