import {
  SCALE_TYPES_ORDERED,
  tryNormalizeRoot,
  type ScaleType,
} from "../scaleDataProvider";
import { TUNING_PRESETS } from "../tunings";

export type PositionMode = "full" | "pentatonic" | "caged" | "three-notes";
export type ExerciseDirection = "ascending" | "descending" | "up-down";
export type PracticeSession = {
  root: string;
  scaleType: ScaleType;
  tuningId: string;
  capo: number;
  labelMode: "notes" | "intervals";
  display: "scale" | "roots" | "triad" | "chromatic" | "pentatonic-overlay";
  positionMode: PositionMode;
  positionIndex: number;
  frets: number;
  tempo: number;
  direction: ExerciseDirection;
  loop: boolean;
  metronome: boolean;
  progression: number[];
  volume: number;
};
export const DEFAULT_SESSION: PracticeSession = {
  root: "A",
  scaleType: "minor",
  tuningId: "standard",
  capo: 0,
  labelMode: "notes",
  display: "scale",
  positionMode: "full",
  positionIndex: 0,
  frets: 15,
  tempo: 80,
  direction: "up-down",
  loop: true,
  metronome: true,
  progression: [0, 5, 2, 6],
  volume: 0.55,
};
const member = <T extends string>(
  value: unknown,
  options: readonly T[],
  fallback: T,
): T =>
  typeof value === "string" && options.includes(value as T)
    ? (value as T)
    : fallback;
const number = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;

export function parseSession(input: unknown): PracticeSession {
  const v =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const positionMode = member(
    v.positionMode,
    ["full", "pentatonic", "caged", "three-notes"],
    "full",
  );
  const lastPositionIndex: Record<PositionMode, number> = {
    full: 0,
    pentatonic: 4,
    caged: 4,
    "three-notes": 6,
  };
  return {
    root: typeof v.root === "string" ? (tryNormalizeRoot(v.root) ?? "A") : "A",
    scaleType: member(v.scaleType, SCALE_TYPES_ORDERED, "minor"),
    tuningId: member(
      v.tuningId,
      TUNING_PRESETS.map((t) => t.id),
      "standard",
    ),
    capo: Math.round(number(v.capo, 0, 0, 12)),
    labelMode: member(v.labelMode, ["notes", "intervals"], "notes"),
    display: member(
      v.display,
      ["scale", "roots", "triad", "chromatic", "pentatonic-overlay"],
      "scale",
    ),
    positionMode,
    positionIndex: Math.round(
      number(v.positionIndex, 0, 0, lastPositionIndex[positionMode]),
    ),
    frets: [12, 15, 24].includes(v.frets as number) ? (v.frets as number) : 15,
    tempo: Math.round(number(v.tempo, 80, 40, 220)),
    direction: member(
      v.direction,
      ["ascending", "descending", "up-down"],
      "up-down",
    ),
    loop: typeof v.loop === "boolean" ? v.loop : true,
    metronome: typeof v.metronome === "boolean" ? v.metronome : true,
    progression: Array.isArray(v.progression)
      ? v.progression
          .filter(
            (n): n is number =>
              typeof n === "number" && Number.isInteger(n) && n >= 0 && n < 7,
          )
          .slice(0, 16)
      : [...DEFAULT_SESSION.progression],
    volume: number(v.volume, 0.55, 0, 1),
  };
}

export function readSession(): PracticeSession {
  try {
    return parseSession(
      JSON.parse(localStorage.getItem("fretboard-studio.session.v1") ?? "null"),
    );
  } catch {
    return parseSession(null);
  }
}

export function storeSession(session: PracticeSession): boolean {
  try {
    localStorage.setItem(
      "fretboard-studio.session.v1",
      JSON.stringify(session),
    );
    return true;
  } catch {
    return false;
  }
}

export type Favorite = { id: string; name: string; session: PracticeSession };
export function readFavorites(): Favorite[] {
  try {
    const data: unknown = JSON.parse(
      localStorage.getItem("fretboard-studio.favorites.v1") ?? "[]",
    );
    if (!Array.isArray(data)) return [];
    return data
      .slice(0, 30)
      .filter(
        (v) =>
          v &&
          typeof v === "object" &&
          typeof v.id === "string" &&
          typeof v.name === "string",
      )
      .map((v) => ({
        id: v.id,
        name: v.name.slice(0, 60),
        session: parseSession(v.session),
      }));
  } catch {
    return [];
  }
}
export function storeFavorites(favorites: Favorite[]): boolean {
  try {
    localStorage.setItem(
      "fretboard-studio.favorites.v1",
      JSON.stringify(favorites),
    );
    return true;
  } catch {
    return false;
  }
}

const MIDI_TUNINGS: Record<string, number[]> = {
  standard: [40, 45, 50, 55, 59, 64],
  "half-step-down": [39, 44, 49, 54, 58, 63],
  "drop-d": [38, 45, 50, 55, 59, 64],
  "d-standard": [38, 43, 48, 53, 57, 62],
  "c-standard": [36, 41, 46, 51, 55, 60],
  "b-standard": [35, 40, 45, 50, 54, 59],
  "drop-c": [36, 43, 48, 53, 57, 62],
  "drop-csharp": [37, 44, 49, 54, 58, 63],
  "drop-b": [35, 42, 47, 52, 56, 61],
  "open-g": [38, 43, 50, 55, 59, 62],
  "open-d": [38, 45, 50, 54, 57, 62],
  "open-e": [40, 47, 52, 56, 59, 64],
  "open-a": [40, 45, 52, 57, 61, 64],
  "open-c": [36, 43, 48, 55, 60, 64],
  dadgad: [38, 45, 50, 55, 57, 62],
  dgcgcd: [38, 43, 48, 55, 60, 62],
};
export function tuningMidi(id: string): readonly number[] {
  return MIDI_TUNINGS[id] ?? MIDI_TUNINGS.standard!;
}
export function buildExercise(
  notes: readonly number[],
  direction: ExerciseDirection,
): number[] {
  const sorted = [...new Set(notes)].sort((a, b) => a - b);
  if (direction === "descending") return sorted.reverse();
  if (direction === "up-down")
    return [...sorted, ...sorted.slice(1, -1).reverse()];
  return sorted;
}
export function canAutoApply(result: {
  readyToApply: boolean;
  ambiguous: boolean;
  confidence: number;
}): boolean {
  return result.readyToApply && !result.ambiguous && result.confidence >= 0.84;
}
