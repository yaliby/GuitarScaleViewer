// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { chordPitchClasses, parseChord } from './chord';
import { buildPracticeArrangement } from './practice-arrangement';
import { getPianoVoicings } from './practice-voicings';
import type { ChordSegment } from './types';

function song(labels: string[]): ChordSegment[] {
  return labels.map((label, index) => ({
    id: String(index),
    start: index * 2,
    end: index * 2 + 2,
    chord: parseChord(label),
    score: 0.8,
    alternatives: [],
  }));
}
const pcs = (notes: number[]) => [...new Set(notes.map((note) => note % 12))].sort((a, b) => a - b);
describe('classic practice arrangement', () => {
  it('defaults to familiar static open grips while preserving the timeline', () => {
    const segments = song(['G', 'C', 'D', 'Am', 'G']);
    const before = JSON.stringify(segments);
    const result = buildPracticeArrangement(segments);
    expect(result.mode).toBe('classic');
    expect(result.capo).toBe(0);
    expect(result.entries.map((entry) => entry.guitar.voicings[0].frets)).toEqual([
      [3, 2, 0, 0, 0, 3],
      [null, 3, 2, 0, 1, 0],
      [null, null, 0, 2, 3, 2],
      [null, 0, 2, 2, 1, 0],
    ]);
    expect(result.entries[1].guitar.voicings[0].fingers).toEqual([null, 3, 2, 0, 1, 0]);
    expect(result.entries[0].count).toBe(2);
    expect(result.entries[0].occurrences.map((value) => value.start)).toEqual([0, 8]);
    expect(JSON.stringify(segments)).toBe(before);
  });

  it('uses the same conventional one-hand piano chord in every song and occurrence', () => {
    const first = buildPracticeArrangement(song(['C', 'Am', 'F', 'G', 'C']));
    const second = buildPracticeArrangement(song(['B', 'F#', 'C', 'Eb', 'C']));
    const c = getPianoVoicings(parseChord('C')).voicings[0];
    expect(c.midiNotes).toEqual([60, 64, 67]);
    for (const result of [first, second]) {
      for (const occurrence of result.occurrences.filter(
        (value) => value.piano.requestedLabel === 'C',
      )) {
        expect(occurrence.piano.voicings[0]).toEqual(c);
        expect(occurrence.guitar.voicings[0].frets).toEqual([null, 3, 2, 0, 1, 0]);
      }
    }
    for (const label of ['C', 'G', 'D', 'Am', 'Cmaj7', 'G7', 'D/F#']) {
      const chord = parseChord(label);
      const voicing = getPianoVoicings(chord).voicings[0];
      if (chord.kind !== 'chord') throw new Error('Pitched fixture');
      expect(voicing.midiNotes[0] % 12).toBe(chord.bass ?? chord.root);
      expect(pcs(voicing.midiNotes)).toEqual(chordPitchClasses(chord));
      expect(voicing.midiNotes.at(-1)! - voicing.midiNotes[0]).toBeLessThanOrEqual(11);
    }
  });

  it('recommends a songwide capo only when it improves playable shapes', () => {
    const difficult = buildPracticeArrangement(song(['Gb', 'Bbm', 'Db', 'Ebm', 'Gb', 'Db']), {
      mode: 'easy',
      capo: 'recommended',
    });
    expect(difficult.recommendedCapo).toBeGreaterThan(0);
    expect(difficult.capo).toBe(difficult.recommendedCapo);
    expect(difficult.capoExplanation).toMatch(/easier|open/i);
    const easy = buildPracticeArrangement(song(['G', 'C', 'D', 'Em', 'G', 'D']), {
      mode: 'easy',
      capo: 'recommended',
    });
    expect(easy.recommendedCapo).toBe(0);
    for (const entry of difficult.entries) {
      expect(entry.guitar.status).toBe('exact');
      const sounding = entry.guitar.voicings[0].midiNotes.map((note) => note + difficult.capo);
      expect(pcs(sounding)).toEqual(chordPitchClasses(entry.chord));
      expect(Math.min(...sounding) % 12).toBe(entry.chord.bass ?? entry.chord.root);
    }
  });

  it('makes Easy reductions explicit while preserving sounding identity and slash bass', () => {
    const segments = song(['Dbmaj9/F', 'Dbmaj9/F', 'Bbm11/Ab', 'N', 'X']);
    const before = JSON.stringify(segments);
    const result = buildPracticeArrangement(segments, { mode: 'easy', capo: 1 });
    expect(result.entries[0].count).toBe(2);
    expect(result.entries[0].label).toBe('Dbmaj9/F');
    expect(result.entries[0].shapeLabel).toBe('C/E');
    for (const entry of result.entries) {
      expect(entry.guitar.status).toBe('simplified');
      expect(entry.guitar.explanation).toMatch(/omits/i);
      expect(entry.piano.status).toBe('simplified');
      const actual = entry.guitar.voicings[0].midiNotes.map((note) => note + result.capo);
      expect(pcs(actual).every((pitch) => chordPitchClasses(entry.chord).includes(pitch))).toBe(
        true,
      );
      expect(Math.min(...actual) % 12).toBe(entry.chord.bass ?? entry.chord.root);
    }
    expect(result.occurrences).toHaveLength(3);
    expect(JSON.stringify(segments)).toBe(before);
    expect(buildPracticeArrangement(song(['N', 'X'])).entries).toEqual([]);
  });

  it('uses the same reference in the library and every occurrence', () => {
    const result = buildPracticeArrangement(song(['C', 'Am', 'F', 'G', 'C', 'Am', 'F', 'G']));
    for (const entry of result.entries) {
      const occurrences = result.occurrences.filter(
        (occurrence) => occurrence.entryId === entry.id,
      );
      expect(occurrences).toHaveLength(entry.count);
      expect(
        occurrences.every(
          (occurrence) => occurrence.piano.voicings[0].id === entry.piano.voicings[0].id,
        ),
      ).toBe(true);
    }
  });
});
