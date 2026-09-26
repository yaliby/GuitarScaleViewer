// @ts-nocheck
import { chordPitchClasses, formatChord, pitchName, transposeChord } from './chord';
import { buildPracticeLibrary, type PracticeChordEntry } from './practice-library';
import {
  getGuitarVoicings,
  getPianoVoicings,
  type GuitarVoicing,
  type PianoVoicing,
  type VoicingResult,
} from './practice-voicings';
import type { ChordSegment, PitchedChord } from './types';

export type PracticeArrangementMode = 'classic' | 'easy';
export interface PracticeArrangementEntry extends PracticeChordEntry {
  shapeLabel: string;
  guitar: VoicingResult<GuitarVoicing>;
  piano: VoicingResult<PianoVoicing>;
}
export interface PracticeArrangementOccurrence {
  segmentId: string;
  entryId: string;
  shapeLabel: string;
  guitar: VoicingResult<GuitarVoicing>;
  piano: VoicingResult<PianoVoicing>;
}
export interface PracticeArrangement {
  mode: PracticeArrangementMode;
  capo: number;
  recommendedCapo: number;
  capoExplanation: string;
  entries: PracticeArrangementEntry[];
  occurrences: PracticeArrangementOccurrence[];
}

function easyChord(chord: PitchedChord): PitchedChord {
  const simple: PitchedChord = {
    ...chord,
    seventh: null,
    extensions: [],
    addedTones: [],
    alterations: chord.alterations.filter((tone) => [2, 4].includes((tone.degree - 1) % 7)),
    omittedTones: [...chord.omittedTones],
  };
  const original = chordPitchClasses(chord);
  // A reduction cannot restore a tone explicitly replaced in the original.
  return chordPitchClasses(simple).every((pitch) => original.includes(pitch)) ? simple : chord;
}

function guitarEase(voicing: GuitarVoicing): number {
  const pressed = voicing.frets.filter((fret): fret is number => fret !== null && fret > 0);
  return (
    voicing.barres.length * 5 +
    Math.max(0, ...pressed) * 0.65 +
    new Set(voicing.fingers.filter((finger) => finger !== null && finger > 0)).size * 0.8 -
    voicing.frets.filter((fret) => fret === 0).length * 0.5
  );
}

function recommendCapo(entries: PracticeChordEntry[]): { fret: number; explanation: string } {
  if (!entries.length) return { fret: 0, explanation: 'No pitched chords need a capo.' };
  const weight = entries.reduce(
    (sum, entry) => sum + Math.max(entry.totalDuration, entry.count),
    0,
  );
  const scores = Array.from({ length: 8 }, (_, fret) => {
    let cost = 0;
    let unavailable = 0;
    for (const entry of entries) {
      const duration = Math.max(entry.totalDuration, entry.count);
      const result = getGuitarVoicings(transposeChord(easyChord(entry.chord), -fret), {
        limit: 16,
      });
      if (!result.voicings.length) unavailable += duration;
      cost +=
        duration *
        (result.voicings.length
          ? Math.min(...result.voicings.map(guitarEase)) + (result.status === 'simplified' ? 3 : 0)
          : 100);
    }
    return { fret, cost: cost / weight + fret * 0.2, unavailable };
  });
  const baseline = scores[0];
  const best = scores
    .filter((score) => score.unavailable <= baseline.unavailable)
    .sort((a, b) => a.cost - b.cost || a.fret - b.fret)[0];
  const saving = baseline.cost - best.cost;
  if (!best.fret || saving < 1 || saving < Math.abs(baseline.cost) * 0.15) {
    return {
      fret: 0,
      explanation: 'No capo gives a meaningful whole-song improvement over these shapes.',
    };
  }
  return {
    fret: best.fret,
    explanation: `Capo ${best.fret} gives easier or more open shapes across this song. Sounding chords and playback stay unchanged.`,
  };
}

function disclose<T extends GuitarVoicing | PianoVoicing>(
  original: PitchedChord,
  result: VoicingResult<T>,
  capo: number,
  instrument: string,
): VoicingResult<T> {
  if (!result.voicings.length) return { ...result, requestedLabel: formatChord(original) };
  const played = new Set(result.voicings[0].midiNotes.map((note) => (note + capo) % 12));
  const omitted = chordPitchClasses(original).filter((pitch) => !played.has(pitch));
  const actualBass = Math.min(...result.voicings[0].midiNotes.map((note) => note + capo)) % 12;
  const expectedBass = original.bass ?? (instrument === 'Guitar' ? original.root : null);
  const changedBass = expectedBass !== null && actualBass !== expectedBass;
  return {
    ...result,
    requestedLabel: formatChord(original),
    status: omitted.length || changedBass ? 'simplified' : 'exact',
    explanation:
      omitted.length || changedBass
        ? `${instrument} practice reduction${omitted.length ? ` omits ${omitted.map((pitch) => pitchName(pitch, original.spelling)).join(', ')}` : ''}.${changedBass ? ` Requested bass ${pitchName(expectedBass!, original.spelling)} is not the lowest played note; this voicing uses ${pitchName(actualBass, original.spelling)} bass.` : ''} The analyzed song chord is unchanged.`
        : null,
    voicings: result.voicings.map((voicing) =>
      'omittedPitchClasses' in voicing ? { ...voicing, omittedPitchClasses: omitted } : voicing,
    ),
  };
}

function selected<T extends { id: string }>(
  result: VoicingResult<T>,
  choice: T | undefined,
): VoicingResult<T> {
  return choice
    ? {
        ...result,
        voicings: [
          choice,
          ...result.voicings.filter((value) => value.id !== choice.id).slice(0, 2),
        ],
      }
    : result;
}

/** Static conventional chord references; practice choices never alter frozen harmony. */
export function buildPracticeArrangement(
  segments: readonly ChordSegment[],
  options: { mode?: PracticeArrangementMode; capo?: number | 'recommended' } = {},
): PracticeArrangement {
  const mode = options.mode ?? 'classic';
  const library = buildPracticeLibrary(segments);
  const recommendation = recommendCapo(library);
  const requestedCapo = options.capo === 'recommended' ? recommendation.fret : (options.capo ?? 0);
  if (!Number.isInteger(requestedCapo) || requestedCapo < 0 || requestedCapo > 7)
    throw new Error('Capo must be a fret from 0 to 7');
  const capo = mode === 'classic' ? 0 : requestedCapo;
  const entries: PracticeArrangementEntry[] = library.map((entry) => {
    const practiceChord = mode === 'easy' ? easyChord(entry.chord) : entry.chord;
    const shape = transposeChord(practiceChord, -capo);
    const guitar = disclose(entry.chord, getGuitarVoicings(shape, { limit: 16 }), capo, 'Guitar');
    const piano = disclose(entry.chord, getPianoVoicings(practiceChord), 0, 'Piano');
    return { ...entry, shapeLabel: formatChord(shape), guitar, piano };
  });
  const bySegment = new Map(
    entries.flatMap((entry) =>
      entry.occurrences.map((occurrence) => [occurrence.segmentId, entry] as const),
    ),
  );
  const pitched = segments.flatMap((segment) => {
    const entry = bySegment.get(segment.id);
    return entry ? [{ segment, entry }] : [];
  });
  // Every occurrence uses the same reference as its library card. The normal
  // mode never changes a familiar shape in response to neighboring chords.
  for (const entry of entries) {
    const guitar =
      mode === 'easy'
        ? [...entry.guitar.voicings].sort((a, b) => guitarEase(a) - guitarEase(b))[0]
        : entry.guitar.voicings[0];
    entry.guitar = selected(entry.guitar, guitar);
  }
  const occurrences = pitched.map(({ segment, entry }) => ({
    segmentId: segment.id,
    entryId: entry.id,
    shapeLabel: entry.shapeLabel,
    guitar: entry.guitar,
    piano: entry.piano,
  }));
  return {
    mode,
    capo,
    recommendedCapo: recommendation.fret,
    capoExplanation: recommendation.explanation,
    entries,
    occurrences,
  };
}
