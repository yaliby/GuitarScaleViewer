// @ts-nocheck
import type { ChordSegment, PitchedChord } from './types';
import { chordPitchClasses, formatChord, normalizeChord } from './chord';

export interface PracticeChordOccurrence {
  segmentId: string;
  start: number;
  end: number;
}

export interface PracticeChordEntry {
  id: string;
  chord: PitchedChord;
  label: string;
  labels: string[];
  count: number;
  totalDuration: number;
  occurrences: PracticeChordOccurrence[];
}

/** A projection of the frozen timeline; aliases share identity, inversions do not. */
export function buildPracticeLibrary(segments: readonly ChordSegment[]): PracticeChordEntry[] {
  const entries = new Map<string, PracticeChordEntry>();
  for (const segment of segments) {
    const chord = normalizeChord(segment.chord);
    if (chord.kind !== 'chord') continue;
    const label = formatChord(chord);
    // Root is part of harmonic identity: C6 and Am7 must remain separate.
    // A root slash is the same inversion as an implicit root bass.
    const id = `${chord.root}:${chord.bass ?? chord.root}:${chordPitchClasses(chord).join(',')}`;
    let entry = entries.get(id);
    if (!entry) {
      entry = { id, chord, label, labels: [], count: 0, totalDuration: 0, occurrences: [] };
      entries.set(id, entry);
    }
    if (!entry.labels.includes(label)) entry.labels.push(label);
    entry.count += 1;
    entry.totalDuration += segment.end - segment.start;
    entry.occurrences.push({ segmentId: segment.id, start: segment.start, end: segment.end });
  }
  return [...entries.values()];
}
