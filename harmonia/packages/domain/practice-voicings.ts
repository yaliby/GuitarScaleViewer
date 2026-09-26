// @ts-nocheck
import { chordPitchClasses, formatChord, pitchName } from './chord';
import type { Chord } from './types';
import guitarShapes from './data/guitar-shapes.json';

export interface VoicingResult<T> {
  requestedLabel: string;
  status: 'exact' | 'simplified' | 'unavailable';
  explanation: string | null;
  voicings: T[];
}

export interface GuitarBarre {
  fret: number;
  /** Zero-based string indices, low E (0) to high e (5). */
  fromString: number;
  toString: number;
  finger: number;
}

export interface GuitarVoicing {
  id: string;
  name: string;
  /** Low E to high e. Null = muted, zero = open. */
  frets: (number | null)[];
  /** Null = muted, zero = open, 1–4 = index through little finger. */
  fingers: (number | null)[];
  barres: GuitarBarre[];
  baseFret: number;
  midiNotes: number[];
}

export interface PianoVoicing {
  id: string;
  name: string;
  midiNotes: number[];
  omittedPitchClasses: number[];
}

export const STANDARD_GUITAR_TUNING = [40, 45, 50, 55, 59, 64] as const;

interface GuitarShape {
  name: string;
  frets: (number | null)[];
  fingers: (number | null)[];
  barres?: GuitarBarre[];
}

// Original, hand-entered common shapes. These are whole playable grips, not
// independent nearest-note choices on each string. Every candidate is checked
// against the requested complete pitch set and actual lowest sounding pitch.
const OPEN_SHAPES: GuitarShape[] = [
  { name: 'Open Dsus2', frets: [null, null, 0, 2, 3, 0], fingers: [null, null, 0, 1, 3, 0] },
  { name: 'Open Dsus4', frets: [null, null, 0, 2, 3, 3], fingers: [null, null, 0, 1, 3, 4] },
  { name: 'Open Asus2', frets: [null, 0, 2, 2, 0, 0], fingers: [null, 0, 1, 2, 0, 0] },
  { name: 'Open Asus4', frets: [null, 0, 2, 2, 3, 0], fingers: [null, 0, 1, 2, 3, 0] },
  {
    name: 'G power chord',
    frets: [3, 5, 5, null, null, null],
    fingers: [1, 3, 4, null, null, null],
  },
  {
    name: 'C augmented',
    frets: [null, 3, 2, 1, 1, null],
    fingers: [null, 4, 3, 1, 1, null],
    barres: [{ fret: 1, fromString: 3, toString: 4, finger: 1 }],
  },
  { name: 'C diminished', frets: [null, 3, 4, 5, 4, null], fingers: [null, 1, 2, 4, 3, null] },
  { name: 'B half diminished', frets: [null, 2, 3, 2, 3, null], fingers: [null, 1, 3, 2, 4, null] },
  { name: 'Open Cadd9', frets: [null, 3, 2, 0, 3, 3], fingers: [null, 2, 1, 0, 3, 4] },
  {
    name: 'C9 with fifth',
    frets: [null, 3, 2, 3, 3, 3],
    fingers: [null, 2, 1, 3, 3, 3],
    barres: [{ fret: 3, fromString: 3, toString: 5, finger: 3 }],
  },
  { name: 'Open C', frets: [null, 3, 2, 0, 1, 0], fingers: [null, 3, 2, 0, 1, 0] },
  { name: 'Open D', frets: [null, null, 0, 2, 3, 2], fingers: [null, null, 0, 1, 3, 2] },
  { name: 'Open E', frets: [0, 2, 2, 1, 0, 0], fingers: [0, 2, 3, 1, 0, 0] },
  { name: 'Open G', frets: [3, 2, 0, 0, 0, 3], fingers: [2, 1, 0, 0, 0, 3] },
  { name: 'Open A', frets: [null, 0, 2, 2, 2, 0], fingers: [null, 0, 1, 2, 3, 0] },
  { name: 'Open Am', frets: [null, 0, 2, 2, 1, 0], fingers: [null, 0, 2, 3, 1, 0] },
  { name: 'Open Em', frets: [0, 2, 2, 0, 0, 0], fingers: [0, 2, 3, 0, 0, 0] },
  { name: 'Open Dm', frets: [null, null, 0, 2, 3, 1], fingers: [null, null, 0, 2, 3, 1] },
  { name: 'Open C7', frets: [null, 3, 2, 3, 1, 0], fingers: [null, 3, 2, 4, 1, 0] },
  { name: 'Open D7', frets: [null, null, 0, 2, 1, 2], fingers: [null, null, 0, 2, 1, 3] },
  { name: 'Open E7', frets: [0, 2, 0, 1, 0, 0], fingers: [0, 2, 0, 1, 0, 0] },
  { name: 'Open G7', frets: [3, 2, 0, 0, 0, 1], fingers: [3, 2, 0, 0, 0, 1] },
  { name: 'Open A7', frets: [null, 0, 2, 0, 2, 0], fingers: [null, 0, 1, 0, 2, 0] },
  { name: 'Open Cmaj7', frets: [null, 3, 2, 0, 0, 0], fingers: [null, 3, 2, 0, 0, 0] },
  { name: 'Open Amaj7', frets: [null, 0, 2, 1, 2, 0], fingers: [null, 0, 2, 1, 3, 0] },
  { name: 'Open Em7', frets: [0, 2, 0, 0, 0, 0], fingers: [0, 2, 0, 0, 0, 0] },
  { name: 'Open Am7', frets: [null, 0, 2, 0, 1, 0], fingers: [null, 0, 2, 0, 1, 0] },
  { name: 'D with F# bass', frets: [2, null, 0, 2, 3, 2], fingers: [1, null, 0, 2, 4, 3] },
  { name: 'C with E bass', frets: [0, 3, 2, 0, 1, 0], fingers: [0, 3, 2, 0, 1, 0] },
  { name: 'G with B bass', frets: [null, 2, 0, 0, 0, 3], fingers: [null, 1, 0, 0, 0, 3] },
  { name: 'Am with C bass', frets: [null, 3, 2, 2, 1, 0], fingers: [null, 4, 2, 3, 1, 0] },
];

const MOVABLE_SHAPES: GuitarShape[] = [
  { name: 'E major shape', frets: [0, 2, 2, 1, 0, 0], fingers: [1, 3, 4, 2, 1, 1] },
  { name: 'E minor shape', frets: [0, 2, 2, 0, 0, 0], fingers: [1, 3, 4, 1, 1, 1] },
  { name: 'E7 shape', frets: [0, 2, 0, 1, 0, 0], fingers: [1, 3, 1, 2, 1, 1] },
  { name: 'Em7 shape', frets: [0, 2, 0, 0, 0, 0], fingers: [1, 3, 1, 1, 1, 1] },
  { name: 'Emaj7 shape', frets: [0, 2, 1, 1, 0, 0], fingers: [1, 4, 2, 3, 1, 1] },
  { name: 'A major shape', frets: [null, 0, 2, 2, 2, 0], fingers: [null, 1, 2, 3, 4, 1] },
  { name: 'A minor shape', frets: [null, 0, 2, 2, 1, 0], fingers: [null, 1, 3, 4, 2, 1] },
  { name: 'A7 shape', frets: [null, 0, 2, 0, 2, 0], fingers: [null, 1, 3, 1, 4, 1] },
  { name: 'Am7 shape', frets: [null, 0, 2, 0, 1, 0], fingers: [null, 1, 3, 1, 2, 1] },
  { name: 'Amaj7 shape', frets: [null, 0, 2, 1, 2, 0], fingers: [null, 1, 3, 2, 4, 1] },
];

function guitarVoicing(shape: GuitarShape, offset = 0): GuitarVoicing {
  const frets = shape.frets.map((fret) => (fret === null ? null : fret + offset));
  const pressed = frets.filter((fret): fret is number => fret !== null && fret > 0);
  const baseFret = Math.max(...pressed) <= 4 ? 1 : Math.min(...pressed);
  return {
    id: frets.map((fret) => fret ?? 'x').join('-'),
    name: offset ? `${shape.name}, barre at fret ${offset}` : shape.name,
    frets,
    fingers: [...shape.fingers],
    barres: offset
      ? [{ fret: offset, fromString: frets[0] === null ? 1 : 0, toString: 5, finger: 1 }]
      : (shape.barres ?? []).map((barre) => ({ ...barre })),
    baseFret,
    midiNotes: frets.flatMap((fret, i) =>
      fret === null ? [] : [STANDARD_GUITAR_TUNING[i] + fret],
    ),
  };
}

// Familiar full open/barre forms take precedence over partial library grips.
const CLASSIC_GUITAR_IDS = new Set([
  ...OPEN_SHAPES.map((shape) => guitarVoicing(shape).id),
  ...Array.from({ length: 12 }, (_, offset) =>
    MOVABLE_SHAPES.map((shape) => guitarVoicing(shape, offset + 1).id),
  ).flat(),
]);

const GUITAR_VOICINGS: GuitarVoicing[] = [
  ...OPEN_SHAPES.map((shape) => guitarVoicing(shape)),
  ...Array.from({ length: 12 }, (_, i) =>
    MOVABLE_SHAPES.map((shape) => guitarVoicing(shape, i + 1)),
  ).flat(),
  ...guitarShapes.shapes.map((shape) => guitarVoicing({ ...shape, name: 'Library grip' })),
];

// Omitting lower strings of an established grip preserves its physical fingering.
// Recalculate the barre endpoints: no synthetic nearest-note fret assignments.
const GUITAR_CANDIDATES = [
  ...GUITAR_VOICINGS.flatMap((voicing) => {
    const variants = [voicing];
    for (let muted = 1; muted <= 3; muted++) {
      if (voicing.frets[muted - 1] === null) continue;
      const frets = voicing.frets.map((fret, string) => (string < muted ? null : fret));
      if (frets.filter((fret) => fret !== null).length < 3) continue;
      const fingers = voicing.fingers.map((finger, string) => (string < muted ? null : finger));
      const barres = voicing.barres.flatMap((barre) => {
        const strings = fingers.flatMap((finger, string) =>
          finger === barre.finger ? [string] : [],
        );
        return strings.length > 1
          ? [{ ...barre, fromString: strings[0], toString: strings.at(-1)! }]
          : [];
      });
      variants.push(guitarVoicing({ name: 'Library inversion', frets, fingers, barres }));
    }
    return variants;
  })
    .reduce((unique, voicing) => {
      // Keep the conventional fingering when the licensed library has the same frets.
      if (!unique.has(voicing.id)) unique.set(voicing.id, voicing);
      return unique;
    }, new Map<string, GuitarVoicing>())
    .values(),
];

const pitchMask = (pitches: number[]) =>
  pitches.reduce((mask, pitch) => mask | (1 << (pitch % 12)), 0);
const difficulty = (voicing: GuitarVoicing) =>
  Math.max(...voicing.frets.map((fret) => fret ?? 0)) + voicing.barres.length * 2;

// Pitch and bass are computed once; ordinary library lookups are two Map reads.
const GUITAR_INDEX = new Map<number, Map<number, GuitarVoicing[]>>();
for (const voicing of GUITAR_CANDIDATES) {
  const bass = Math.min(...voicing.midiNotes) % 12;
  const mask = pitchMask(voicing.midiNotes);
  const byPitch = GUITAR_INDEX.get(bass) ?? new Map<number, GuitarVoicing[]>();
  const group = byPitch.get(mask) ?? [];
  group.push(voicing);
  byPitch.set(mask, group);
  GUITAR_INDEX.set(bass, byPitch);
}
for (const byPitch of GUITAR_INDEX.values()) {
  for (const group of byPitch.values())
    group.sort(
      (a, b) =>
        Number(CLASSIC_GUITAR_IDS.has(b.id)) - Number(CLASSIC_GUITAR_IDS.has(a.id)) ||
        difficulty(a) - difficulty(b),
    );
}

function reducedPitchClasses(chord: Extract<Chord, { kind: 'chord' }>): number[] {
  // Keep root, quality, seventh, highest extension, explicit adds/alterations,
  // altered fifths and slash bass. Only the natural fifth and lower implied
  // extensions can be omitted. In triads the fifth remains part of the quality.
  const hasColor =
    chord.seventh !== null || chord.extensions.length > 0 || chord.addedTones.length > 0;
  const omitFifth =
    hasColor &&
    chord.triad !== 'power' &&
    chord.triad !== 'diminished' &&
    chord.triad !== 'augmented' &&
    chord.fifth === 0 &&
    !chord.addedTones.some((degree) => (degree - 1) % 7 === 4) &&
    !chord.alterations.some((tone) => (tone.degree - 1) % 7 === 4);
  return chordPitchClasses({
    ...chord,
    extensions: chord.extensions.length ? [Math.max(...chord.extensions)] : [],
    omittedTones: [...chord.omittedTones, ...(omitFifth ? [5] : [])],
  });
}

// The fallback protects the basic quality; removed colors/bass are disclosed.
function qualityPitchClasses(chord: Extract<Chord, { kind: 'chord' }>): number[] {
  const full = chordPitchClasses(chord);
  return chordPitchClasses({
    ...chord,
    bass: null,
    seventh: null,
    extensions: [],
    addedTones: [],
    alterations: chord.alterations.filter((tone) => [2, 4].includes((tone.degree - 1) % 7)),
  }).filter((pitch) => full.includes(pitch));
}

function unavailable<T>(chord: Chord, explanation: string): VoicingResult<T> {
  return { requestedLabel: formatChord(chord), status: 'unavailable', explanation, voicings: [] };
}

export function getGuitarVoicings(
  chord: Chord,
  options: { limit?: number } = {},
): VoicingResult<GuitarVoicing> {
  if (chord.kind !== 'chord') return unavailable(chord, 'No pitched chord to play.');
  const wanted = chordPitchClasses(chord);
  const wantedMask = pitchMask(wanted);
  const essential = reducedPitchClasses(chord);
  const essentialMask = pitchMask(essential);
  const bass = chord.bass ?? chord.root;
  const byPitch = GUITAR_INDEX.get(bass);
  let matches = byPitch?.get(wantedMask) ?? [];
  let selectedMask = wantedMask;
  let bestScore = Infinity;
  if (!matches.length && byPitch) {
    for (const [mask, group] of byPitch) {
      if ((mask & wantedMask) !== mask || (mask & essentialMask) !== essentialMask) continue;
      const missing = wanted.filter((pitch) => !(mask & (1 << pitch))).length;
      const score = missing * 100 + difficulty(group[0]);
      if (score < bestScore) {
        bestScore = score;
        matches = group;
        selectedMask = mask;
      }
    }
  }
  // Last-resort accompaniment: keep the quality, retain as much color as a
  // validated whole grip supports, and try the requested bass before another bass.
  // Never invent independent string placements to satisfy an arbitrary pitch set.
  if (!matches.length) {
    const qualityMask = pitchMask(qualityPitchClasses(chord));
    for (const [actualBass, groups] of GUITAR_INDEX) {
      for (const [mask, group] of groups) {
        if ((mask & wantedMask) !== mask || (mask & qualityMask) !== qualityMask) continue;
        const missing = wanted.filter((pitch) => !(mask & (1 << pitch))).length;
        const missingEssential = essential.filter((pitch) => !(mask & (1 << pitch))).length;
        const score =
          (actualBass === bass ? 0 : 10000) +
          missingEssential * 100 +
          missing * 30 +
          difficulty(group[0]);
        if (score < bestScore) {
          bestScore = score;
          matches = group;
          selectedMask = mask;
        }
      }
    }
  }
  const omitted = wanted.filter((pitch) => !(selectedMask & (1 << pitch)));
  // All variants share the same omission disclosure and exact/reduced status.
  if (!matches.length)
    return unavailable(
      chord,
      'No verified practical guitar shape for this chord and bass yet. Use the piano voicing or chord-tone map.',
    );
  const actualBass = Math.min(...matches[0].midiNotes) % 12;
  const changedBass = actualBass !== bass;
  const simplified = omitted.length > 0 || changedBass;
  return {
    requestedLabel: formatChord(chord),
    status: simplified ? 'simplified' : 'exact',
    explanation: simplified
      ? `Guitar practice reduction${omitted.length ? ` omits ${omitted.map((pitch) => pitchName(pitch, chord.spelling)).join(', ')}` : ''}.${changedBass ? ` Requested bass ${pitchName(bass, chord.spelling)} is not the lowest played note; this grip uses ${pitchName(actualBass, chord.spelling)} bass.` : ' Requested bass retained.'} The analyzed chord is unchanged.`
      : null,
    voicings: matches.slice(0, Math.min(16, Math.max(1, options.limit ?? 3))).map((voicing) => ({
      ...voicing,
      name: `${formatChord(chord)}${omitted.length ? ' reduced' : ''} · ${voicing.baseFret === 1 ? 'open / low position' : `position ${voicing.baseFret}`}`,
      frets: [...voicing.frets],
      fingers: [...voicing.fingers],
      barres: voicing.barres.map((barre) => ({ ...barre })),
      midiNotes: [...voicing.midiNotes],
    })),
  };
}

export function getPianoVoicings(
  chord: Chord,
  options: { alternatives?: boolean } = {},
): VoicingResult<PianoVoicing> {
  if (chord.kind !== 'chord') return unavailable(chord, 'No pitched chord to play.');
  const full = chordPitchClasses(chord);
  let played = full;
  if (full.length > 5) {
    const core = new Set(qualityPitchClasses(chord));
    const preferred = new Set(reducedPitchClasses(chord));
    const seventh =
      chord.seventh === null
        ? null
        : (chord.root + { minor: 10, major: 11, diminished: 9 }[chord.seventh]) % 12;
    const priority = (pitch: number) =>
      (pitch === chord.bass ? 1000 : 0) +
      (core.has(pitch) && preferred.has(pitch) ? 100 : 0) +
      (pitch === seventh ? 80 : 0) +
      (preferred.has(pitch) ? 20 : 0);
    played = [...full]
      .sort(
        (a, b) =>
          priority(b) - priority(a) || ((a - chord.root + 12) % 12) - ((b - chord.root + 12) % 12),
      )
      .slice(0, 5);
  }
  const omittedPitchClasses = full.filter((pitch) => !played.includes(pitch));
  const candidates: { midiNotes: number[]; score: number }[] = [];
  // One close-position pitch per class: no detached bass or second hand.
  // Classic lookup uses root position; explicit slash bass selects that inversion.
  // Optional alternatives remain available for callers that explicitly request them.
  for (let first = 48; first <= 72; first++) {
    const bass = chord.bass ?? (options.alternatives ? null : chord.root);
    if (!played.includes(first % 12) || (bass !== null && first % 12 !== bass)) continue;
    const midiNotes = played
      .map((pitch) => first + ((pitch - (first % 12) + 12) % 12))
      .sort((a, b) => a - b);
    const span = midiNotes.at(-1)! - first;
    const center = (first + midiNotes.at(-1)!) / 2;
    candidates.push({
      midiNotes,
      score:
        Math.max(0, span - 9) * 4 +
        Math.abs(center - 64) * 0.5 +
        (first % 12 === chord.root ? 0 : 0.1),
    });
  }
  candidates.sort((a, b) => a.score - b.score);
  if (!candidates.length) return unavailable(chord, 'No compact voicing for these pitches.');
  const simplified = omittedPitchClasses.length > 0;
  return {
    requestedLabel: formatChord(chord),
    status: simplified ? 'simplified' : 'exact',
    explanation: simplified
      ? `One-hand piano reduction omits ${omittedPitchClasses.map((pitch) => pitchName(pitch, chord.spelling)).join(', ')}. The analyzed chord label is unchanged.`
      : null,
    voicings: candidates.slice(0, options.alternatives ? 12 : 1).map(({ midiNotes }) => ({
      id: midiNotes.join('-'),
      name: 'One-hand close voicing',
      midiNotes,
      omittedPitchClasses,
    })),
  };
}
