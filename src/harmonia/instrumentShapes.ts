import { chordPitchClasses } from "../../harmonia/packages/domain/chord";
import {
  STANDARD_GUITAR_TUNING,
  getGuitarVoicings,
  getPianoVoicings,
} from "../../harmonia/packages/domain/practice-voicings";
import type { Chord } from "../../harmonia/packages/domain/types";

export type InstrumentId = "guitar" | "piano" | "ukulele" | "bass" | "mandolin";

type Fretted = {
  label: string;
  /** Open strings in MIDI, in the order a chord chart draws them, left to right. */
  tuning: readonly number[];
  strings: readonly string[];
  /** Ukulele's high G: the leftmost string is not the lowest note, so no grip needs a root bass. */
  reentrant: boolean;
};

export const FRETTED: Record<"ukulele" | "mandolin" | "bass", Fretted> = {
  ukulele: { label: "Ukulele", tuning: [67, 60, 64, 69], strings: ["G", "C", "E", "A"], reentrant: true },
  mandolin: { label: "Mandolin", tuning: [55, 62, 69, 76], strings: ["G", "D", "A", "E"], reentrant: false },
  bass: { label: "Bass", tuning: [28, 33, 38, 43], strings: ["E", "A", "D", "G"], reentrant: false },
};

/** A dot on a chord chart: `fret` 0 is an open string, drawn over the nut. */
export type FretMark = { string: number; fret: number; finger: number | null; root: boolean };

export type FretShape = {
  kind: "frets";
  strings: readonly string[];
  /** The fret the chart's top row is; 1 draws the nut. */
  baseFret: number;
  rows: number;
  marks: FretMark[];
  muted: number[];
  barres: { fret: number; from: number; to: number }[];
  name: string;
};

export type KeysShape = { kind: "keys"; midiNotes: number[]; root: number; name: string };

export type Shape = FretShape | KeysShape;

export type ShapeResult = {
  shapes: Shape[];
  /** Why the shapes are not the whole chord, or why there are none. */
  note: string | null;
};

const MAX_FRET = 12;
const MAX_SPAN = 3;

const mod12 = (value: number) => ((value % 12) + 12) % 12;
const maskOf = (pcs: readonly number[]) => pcs.reduce((mask, pc) => mask | (1 << mod12(pc)), 0);

function window(frets: readonly number[]): { baseFret: number; rows: number } {
  const pressed = frets.filter((fret) => fret > 0);
  const top = pressed.length ? Math.max(...pressed) : 0;
  const baseFret = top <= 4 ? 1 : Math.min(...pressed);
  return { baseFret, rows: Math.max(4, top - baseFret + 1) };
}

/**
 * The tones a four-string grip keeps when the chord has more: root, third (or sus tone), seventh
 * and color before the natural fifth, which goes first as it does on a guitar.
 */
function essentialTones(chord: Extract<Chord, { kind: "chord" }>, room: number): number[] {
  const pcs = chordPitchClasses(chord);
  if (pcs.length <= room) return pcs;
  const weight = (pc: number) => {
    if (pc === (chord.bass ?? chord.root)) return 200;
    if (pc === chord.root) return 150;
    const interval = mod12(pc - chord.root);
    if (interval === 3 || interval === 4) return 100;
    if (interval === 10 || interval === 11) return 90;
    if (interval === 7) return 10;
    return 60;
  };
  return [...pcs].sort((a, b) => weight(b) - weight(a)).slice(0, room);
}

/** Every string strummed, one fret each, inside a hand's reach: the grips that sound the chord. */
export function frettedGrips(chord: Chord, instrument: Fretted, limit = 3): ShapeResult {
  if (chord.kind !== "chord") return { shapes: [], note: null };
  const tones = chordPitchClasses(chord);
  const toneMask = maskOf(tones);
  const kept = essentialTones(chord, instrument.tuning.length);
  const keptMask = maskOf(kept);
  const bass = chord.bass ?? chord.root;
  const choices = instrument.tuning.map((open) =>
    Array.from({ length: MAX_FRET + 1 }, (_, fret) => fret).filter((fret) => toneMask & (1 << mod12(open + fret))),
  );
  const found: { frets: number[]; score: number }[] = [];
  const walk = (string: number, frets: number[]) => {
    if (string === instrument.tuning.length) {
      const pressed = frets.filter((fret) => fret > 0);
      if (pressed.length && Math.max(...pressed) - Math.min(...pressed) > MAX_SPAN) return;
      const notes = frets.map((fret, index) => instrument.tuning[index]! + fret);
      if ((maskOf(notes) & keptMask) !== keptMask) return;
      const lowest = mod12(Math.min(...notes));
      found.push({
        frets: [...frets],
        score:
          (pressed.length ? Math.max(...pressed) : 0) +
          (pressed.length ? Math.max(...pressed) - Math.min(...pressed) : 0) * 0.5 +
          pressed.length * 0.3 +
          (!instrument.reentrant && lowest !== bass ? 4 : 0),
      });
      return;
    }
    for (const fret of choices[string]!) {
      frets.push(fret);
      walk(string + 1, frets);
      frets.pop();
    }
  };
  walk(0, []);
  found.sort((a, b) => a.score - b.score);
  const omitted = tones.filter((pc) => !kept.includes(pc));
  return {
    shapes: found.slice(0, limit).map(({ frets }) => {
      const { baseFret, rows } = window(frets);
      return {
        kind: "frets",
        strings: instrument.strings,
        baseFret,
        rows,
        marks: frets.map((fret, string) => ({
          string,
          fret,
          finger: null,
          root: mod12(instrument.tuning[string]! + fret) === chord.root,
        })),
        muted: [],
        barres: [],
        name: baseFret === 1 ? "Open / low position" : `Position ${baseFret}`,
      };
    }),
    note: found.length
      ? omitted.length
        ? `Four strings: this grip leaves out ${omitted.length === 1 ? "one tone" : `${omitted.length} tones`} of the chord.`
        : null
      : `No ${instrument.label.toLowerCase()} grip in reach for this chord.`,
  };
}

/**
 * A bass player's box: the bass note on the E or A string, low as it goes, and every chord tone
 * within a hand's reach above it to walk between.
 */
export function bassBox(chord: Chord): ShapeResult {
  if (chord.kind !== "chord") return { shapes: [], note: null };
  const { tuning, strings } = FRETTED.bass;
  const bass = chord.bass ?? chord.root;
  const onE = mod12(bass - tuning[0]!);
  const onA = mod12(bass - tuning[1]!);
  const [rootString, rootFret] = onE <= onA ? [0, onE] : [1, onA];
  const low = Math.max(0, rootFret - 1);
  const high = rootFret + 3;
  const toneMask = maskOf(chordPitchClasses(chord));
  const marks: FretMark[] = [];
  for (let string = rootString; string < tuning.length; string += 1) {
    for (let fret = low; fret <= high; fret += 1) {
      const pc = mod12(tuning[string]! + fret);
      if (toneMask & (1 << pc)) marks.push({ string, fret, finger: null, root: pc === bass });
    }
  }
  const baseFret = low <= 1 ? 1 : low;
  return {
    shapes: [
      {
        kind: "frets",
        strings,
        baseFret,
        rows: Math.max(4, high - baseFret + 1),
        marks,
        muted: Array.from({ length: rootString }, (_, string) => string),
        barres: [],
        name: `Bass note on the ${strings[rootString]} string${rootFret ? `, fret ${rootFret}` : ", open"}`,
      },
    ],
    note: null,
  };
}

function guitar(chord: Chord): ShapeResult {
  if (chord.kind !== "chord") return { shapes: [], note: null };
  const result = getGuitarVoicings(chord, { limit: 3 });
  return {
    note: result.explanation,
    shapes: result.voicings.map((voicing) => {
      const top = Math.max(0, ...voicing.frets.map((fret) => fret ?? 0));
      return {
        kind: "frets",
        strings: ["E", "A", "D", "G", "B", "e"],
        baseFret: voicing.baseFret,
        rows: Math.max(4, top - voicing.baseFret + 1),
        marks: voicing.frets.flatMap((fret, string) =>
          fret === null
            ? []
            : [
                {
                  string,
                  fret,
                  finger: fret > 0 ? (voicing.fingers[string] ?? null) : null,
                  root: mod12(STANDARD_GUITAR_TUNING[string]! + fret) === chord.root,
                },
              ],
        ),
        muted: voicing.frets.flatMap((fret, string) => (fret === null ? [string] : [])),
        barres: voicing.barres.map((barre) => ({ fret: barre.fret, from: barre.fromString, to: barre.toString })),
        name: voicing.name.split(" · ").at(-1) ?? voicing.name,
      };
    }),
  };
}

function piano(chord: Chord): ShapeResult {
  if (chord.kind !== "chord") return { shapes: [], note: null };
  const result = getPianoVoicings(chord);
  return {
    note: result.explanation,
    shapes: result.voicings.map((voicing) => ({
      kind: "keys",
      midiNotes: voicing.midiNotes,
      root: chord.root,
      name: "One hand, close position",
    })),
  };
}

/** How to play `chord` on `instrument`: a few shapes, the easiest first. */
export function chordShapes(chord: Chord, instrument: InstrumentId): ShapeResult {
  switch (instrument) {
    case "guitar":
      return guitar(chord);
    case "piano":
      return piano(chord);
    case "bass":
      return bassBox(chord);
    default:
      return frettedGrips(chord, FRETTED[instrument]);
  }
}
