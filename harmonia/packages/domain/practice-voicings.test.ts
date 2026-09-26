// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { chordPitchClasses, parseChord } from './chord';
import { getGuitarVoicings, getPianoVoicings } from './practice-voicings';
import guitarShapes from './data/guitar-shapes.json';

const tuning = [40, 45, 50, 55, 59, 64];
const pcs = (notes: number[]) => [...new Set(notes.map((note) => note % 12))].sort((a, b) => a - b);

describe('practical guitar voicings', () => {
  it('ships only bounded grips with coherent fingers and barres', () => {
    expect(guitarShapes.shapes.length).toBeGreaterThan(2500);
    for (const shape of guitarShapes.shapes) {
      expect(shape.frets).toHaveLength(6);
      expect(shape.fingers).toHaveLength(6);
      const pressed = shape.frets.filter((fret): fret is number => fret !== null && fret > 0);
      expect(Math.max(...pressed) - Math.min(...pressed)).toBeLessThanOrEqual(3);
      shape.frets.forEach((fret, string) => {
        const finger = shape.fingers[string];
        if (fret === null) expect(finger).toBeNull();
        else if (fret === 0) expect(finger).toBe(0);
        else {
          expect(fret).toBeLessThanOrEqual(15);
          expect([1, 2, 3, 4]).toContain(finger);
        }
      });
      for (const finger of [1, 2, 3, 4]) {
        const strings = shape.fingers.flatMap((value, string) =>
          value === finger ? [string] : [],
        );
        if (strings.length < 2) continue;
        const barre = shape.barres.find((value) => value.finger === finger);
        expect(barre).toBeDefined();
        expect(barre!.fromString).toBe(strings[0]);
        expect(barre!.toString).toBe(strings.at(-1));
        for (let string = barre!.fromString; string <= barre!.toString; string++) {
          const fret = shape.frets[string];
          if (fret !== null) expect(fret).toBeGreaterThanOrEqual(barre!.fret);
        }
        expect(strings.every((string) => shape.frets[string] === barre!.fret)).toBe(true);
      }
    }
  });
  it.each([
    ['C', [0, 4, 7], 0],
    ['D', [2, 6, 9], 2],
    ['E', [4, 8, 11], 4],
    ['F', [0, 5, 9], 5],
    ['G', [2, 7, 11], 7],
    ['A', [1, 4, 9], 9],
    ['Am', [0, 4, 9], 9],
    ['Em', [4, 7, 11], 4],
    ['Dm', [2, 5, 9], 2],
    ['G7', [2, 5, 7, 11], 7],
    ['Cmaj7', [0, 4, 7, 11], 0],
    ['Am7', [0, 4, 7, 9], 9],
    ['Bb', [2, 5, 10], 10],
    ['F#m', [1, 6, 9], 6],
    ['Dbmaj7', [0, 1, 5, 8], 1],
    ['D/F#', [2, 6, 9], 6],
    ['C/E', [0, 4, 7], 4],
    ['G/B', [2, 7, 11], 11],
    ['Am/C', [0, 4, 9], 0],
    ['Dsus2', [2, 4, 9], 2],
    ['Dsus4', [2, 7, 9], 2],
    ['Asus2', [4, 9, 11], 9],
    ['Asus4', [2, 4, 9], 9],
    ['G5', [2, 7], 7],
    ['Caug', [0, 4, 8], 0],
    ['Cdim', [0, 3, 6], 0],
    ['Bm7b5', [2, 5, 9, 11], 11],
    ['Cadd9', [0, 2, 4, 7], 0],
    ['C9', [0, 2, 4, 7, 10], 0],
  ] as const)(
    'plays all and only the notes of %s with its requested lowest bass',
    (label, tones, bass) => {
      const result = getGuitarVoicings(parseChord(label));
      expect(result.status).toBe('exact');
      expect(result.voicings.length).toBeGreaterThan(0);
      for (const voicing of result.voicings) {
        const sounding = voicing.frets.flatMap((fret, i) =>
          fret === null ? [] : [tuning[i] + fret],
        );
        expect(pcs(sounding)).toEqual(tones);
        expect(Math.min(...sounding) % 12).toBe(bass);
        expect(voicing.midiNotes).toEqual(sounding);
        expect(voicing.frets).toHaveLength(6);
        expect(voicing.fingers).toHaveLength(6);
        voicing.frets.forEach((fret, string) => {
          const finger = voicing.fingers[string];
          if (fret === null) expect(finger).toBeNull();
          else if (fret === 0) expect(finger).toBe(0);
          else expect(finger).toBeGreaterThan(0);
        });
        for (const finger of [1, 2, 3, 4]) {
          const strings = voicing.fingers.flatMap((value, string) =>
            value === finger ? [string] : [],
          );
          if (strings.length <= 1) continue;
          const first = strings[0];
          const last = strings[strings.length - 1];
          expect(
            voicing.barres.some(
              (barre) =>
                barre.finger === finger &&
                barre.fromString <= first &&
                barre.toString >= last &&
                strings.every((string) => voicing.frets[string] === barre.fret),
            ),
          ).toBe(true);
        }
        expect(
          voicing.fingers.every((finger) => finger === null || (finger >= 0 && finger <= 4)),
        ).toBe(true);
        const pressed = voicing.frets.filter((fret): fret is number => fret !== null && fret > 0);
        expect(Math.max(...pressed) - Math.min(...pressed)).toBeLessThanOrEqual(3);
      }
    },
  );

  it('does not mislabel unsupported dense harmony as an exact basic chord', () => {
    for (const label of ['C13(b9,#9,#11,b13)/F#']) {
      const result = getGuitarVoicings(parseChord(label));
      expect(result.status).toBe('simplified');
      expect(result.voicings.length).toBeGreaterThan(0);
      expect(result.explanation).toMatch(/omits/i);
      expect(result.requestedLabel).toContain('C');
      expect(result.explanation).toBeTruthy();
    }
  });

  it.each(['E13/C#', 'Cmaj9/B', 'Eb7(#9)/Bb', 'D11/G', 'C13(b9,#9,#11,b13)/F#'])(
    'offers a playable disclosed reduction for %s',
    (label) => {
      const chord = parseChord(label);
      const result = getGuitarVoicings(chord);
      expect(result.status).not.toBe('unavailable');
      for (const grip of result.voicings) {
        expect(pcs(grip.midiNotes).every((p) => chordPitchClasses(chord).includes(p))).toBe(true);
        expect(grip.midiNotes.length).toBeGreaterThanOrEqual(3);
        if (result.status === 'simplified') expect(result.explanation).toMatch(/omits|bass/i);
      }
    },
  );

  it('covers common extended and inverted grips with truthful omissions', () => {
    for (const root of ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']) {
      for (const suffix of ['dim7', 'm7b5', 'sus2', 'sus4', '6', 'm6', '9', 'maj9', 'm9', '7b9']) {
        const chord = parseChord(root + suffix);
        const result = getGuitarVoicings(chord);
        expect(result.status, root + suffix).not.toBe('unavailable');
        for (const grip of result.voicings) {
          const wanted = chordPitchClasses(chord);
          expect(pcs(grip.midiNotes).every((pitch) => wanted.includes(pitch))).toBe(true);
          expect(Math.min(...grip.midiNotes) % 12).toBe(chord.kind === 'chord' ? chord.root : -1);
          if (result.status === 'exact') expect(pcs(grip.midiNotes)).toEqual(wanted);
          else expect(result.explanation).toMatch(/omits/i);
        }
      }
    }
    for (const label of ['C/G', 'D/A', 'A/C#', 'Am/G', 'G/F#', 'F/C']) {
      const chord = parseChord(label);
      const result = getGuitarVoicings(chord);
      expect(result.status, label).toBe('exact');
      expect(Math.min(...result.voicings[0].midiNotes) % 12).toBe(
        chord.kind === 'chord' ? chord.bass : -1,
      );
    }
  });

  it('preserves quality and altered tones across chromatic transposition even when reduced', () => {
    for (const root of ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']) {
      for (const [suffix, essentialIntervals] of [
        ['13', [0, 4, 9, 10]],
        ['m11', [0, 3, 5, 10]],
        ['7b9', [0, 1, 4, 10]],
        ['7#9', [0, 3, 4, 10]],
        ['7b5', [0, 4, 6, 10]],
        ['7#5', [0, 4, 8, 10]],
        ['m7b5', [0, 3, 6, 10]],
        ['dim7', [0, 3, 6, 9]],
      ] as const) {
        const chord = parseChord(root + suffix);
        if (chord.kind !== 'chord') throw new Error('Fixture is pitched');
        const result = getGuitarVoicings(chord);
        expect(result.status, root + suffix).not.toBe('unavailable');
        for (const grip of result.voicings) {
          const played = pcs(grip.midiNotes);
          for (const interval of essentialIntervals)
            expect(played).toContain((chord.root + interval) % 12);
          expect(
            grip.frets.every(
              (fret) =>
                fret === null || fret === 0 || (fret >= grip.baseFret && fret < grip.baseFret + 5),
            ),
          ).toBe(true);
        }
      }
    }
  });
});

describe('practical piano voicings', () => {
  it.each([
    ['C', [0, 4, 7], 0],
    ['Dm7', [0, 2, 5, 9], 2],
    ['D/F#', [2, 6, 9], 6],
    ['C/F#', [0, 4, 6, 7], 6],
    ['C7b9', [0, 1, 4, 7, 10], 0],
    ['F#m7b5', [0, 4, 6, 9], 6],
  ] as const)(
    'supplies compact playable pitches and a genuine lowest bass for %s',
    (label, tones, bass) => {
      const result = getPianoVoicings(parseChord(label));
      expect(result.status).toBe('exact');
      const voicing = result.voicings[0];
      expect(pcs(voicing.midiNotes)).toEqual(tones);
      if (label.includes('/')) expect(voicing.midiNotes[0] % 12).toBe(bass);
      expect(voicing.midiNotes.length).toBeLessThanOrEqual(5);
      expect(Math.max(...voicing.midiNotes) - Math.min(...voicing.midiNotes)).toBeLessThanOrEqual(
        11,
      );
      expect(voicing.omittedPitchClasses).toEqual([]);
    },
  );

  it('reduces dense harmony to one hand with explicit omitted tones', () => {
    const result = getPianoVoicings(parseChord('C13#11/E'));
    expect(result.status).toBe('simplified');
    expect(result.requestedLabel).toBe('C13(#11)/E');
    const voicing = result.voicings[0];
    expect(voicing.midiNotes[0] % 12).toBe(4);
    expect(voicing.midiNotes.length).toBeLessThanOrEqual(5);
    expect(pcs(voicing.midiNotes)).toEqual([0, 4, 6, 9, 10]);
    expect(voicing.omittedPitchClasses.length).toBeGreaterThan(0);
    expect(result.explanation).toMatch(/omits/i);
  });

  it('keeps one reachable hand across roots, dense colors and slash basses', () => {
    for (const root of ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']) {
      for (const suffix of [
        'maj7',
        'm7',
        '7b9',
        '13#11',
        '13(b9,#9,#11)',
        'augmaj7',
        'dim7',
        'sus4',
      ]) {
        for (const bass of [
          '',
          '/C',
          '/Db',
          '/D',
          '/Eb',
          '/E',
          '/F',
          '/F#',
          '/G',
          '/Ab',
          '/A',
          '/Bb',
          '/B',
        ]) {
          const chord = parseChord(root + suffix + bass);
          const result = getPianoVoicings(chord);
          expect(result.status, root + suffix + bass).not.toBe('unavailable');
          const voicing = result.voicings[0];
          expect(voicing.midiNotes.length).toBeLessThanOrEqual(5);
          expect(voicing.midiNotes.length).toBeGreaterThanOrEqual(3);
          expect(
            Math.max(...voicing.midiNotes) - Math.min(...voicing.midiNotes),
          ).toBeLessThanOrEqual(11);
          if (chord.kind === 'chord' && chord.bass !== null)
            expect(Math.min(...voicing.midiNotes) % 12).toBe(chord.bass);
          const omitted = chordPitchClasses(chord).filter(
            (pitch) => !pcs(voicing.midiNotes).includes(pitch),
          );
          expect(voicing.omittedPitchClasses).toEqual(omitted);
          expect(result.status === 'exact').toBe(omitted.length === 0);
          expect(
            pcs(voicing.midiNotes).every((pitch) => chordPitchClasses(chord).includes(pitch)),
          ).toBe(true);
        }
      }
    }
  });

  it('plays a triad as three close notes and offers inversions for voice leading', () => {
    const result = getPianoVoicings(parseChord('C'), { alternatives: true });
    expect(new Set(result.voicings.map((v) => v.midiNotes[0] % 12)).size).toBe(3);
    for (const voicing of result.voicings) {
      expect(voicing.midiNotes).toHaveLength(3);
      expect(voicing.midiNotes.at(-1)! - voicing.midiNotes[0]).toBeLessThanOrEqual(9);
    }
  });

  it('does not invent voicings for unknown or no chord', () => {
    for (const chord of [parseChord('N'), parseChord('X')]) {
      expect(getPianoVoicings(chord).status).toBe('unavailable');
      expect(getGuitarVoicings(chord).status).toBe('unavailable');
    }
  });
});
