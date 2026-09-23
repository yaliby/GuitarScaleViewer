import { describe, expect, it } from 'vitest';
import {
  CERTAINTY_PCT,
  REVISION_MARGIN_PCT,
  clearsApplyGate,
  compareKeys,
  fuseKey,
  relativeHedge,
  shouldRevise,
  type FusedKey,
} from './keyFusion';
import { buildScaleNotes } from '../scaleSpell';

const verifiedDm = { key: 'D', mode: 'minor' as const, displayName: 'D minor' };

const engine = (over: Partial<Parameters<typeof fuseKey>[0]['detected']> = {}) => ({
  primaryKey: 'D',
  primaryScale: 'minor',
  displayName: 'D minor',
  confidence: 0.91,
  ambiguous: false,
  ...over,
});
const silent = engine({ primaryKey: null, primaryScale: null, displayName: null, confidence: 0, ambiguous: true });

const fuse = (over: Partial<Parameters<typeof fuseKey>[0]> = {}) =>
  fuseKey({ verified: null, detected: engine(), held: null, ...over });

describe('compareKeys', () => {
  it('reads an enharmonic spelling as the same key, not a conflict', () => {
    expect(compareKeys({ key: 'F#', mode: 'major' }, { key: 'Gb', mode: 'major' })).toBe('same');
  });

  it('recognises a relative pair in both directions', () => {
    expect(compareKeys({ key: 'A', mode: 'minor' }, { key: 'C', mode: 'major' })).toBe('relative');
    expect(compareKeys({ key: 'C', mode: 'major' }, { key: 'A', mode: 'minor' })).toBe('relative');
  });

  it('does not mistake a parallel key for a relative one', () => {
    expect(compareKeys({ key: 'A', mode: 'minor' }, { key: 'A', mode: 'major' })).toBe('unrelated');
  });

  it('calls two unrelated keys unrelated', () => {
    expect(compareKeys({ key: 'D', mode: 'minor' }, { key: 'F#', mode: 'major' })).toBe('unrelated');
  });
});

describe('fuseKey', () => {
  it('lets a human-entered key win over the engine, instantly', () => {
    const fused = fuse({ verified: verifiedDm, detected: engine({ primaryKey: 'G', primaryScale: 'major' }) });
    expect(fused).toMatchObject({
      root: 'D',
      scale: 'minor',
      source: 'verified',
      certainty: 'verified',
      confidencePct: CERTAINTY_PCT.verified,
      notesSettled: true,
    });
  });

  /**
   * The measured shape of the engine's failure. On the 72-clip corpus
   * (`src-tauri/tests/key_accuracy_scoreboard.rs`) 22 of its 24 misses are this one: the right
   * seven notes under the wrong root. The old pipeline priced that identically to "no idea" and
   * left the player to press `Relative` — a touch, which the product promises never to require.
   */
  describe('a relative-pair hedge is not the same defect as no idea', () => {
    const torn = engine({
      primaryKey: 'G',
      primaryScale: 'major',
      displayName: 'G major',
      ambiguous: true,
      confidence: 0.62,
      alternatives: [{ key: 'E', scale: 'minor', displayName: 'E minor' }],
    });

    it('keeps the notes settled and says which root it cannot choose', () => {
      expect(fuse({ detected: torn })).toMatchObject({
        root: 'G',
        scale: 'major',
        certainty: 'tonic_open',
        confidencePct: CERTAINTY_PCT.tonicOpen,
        notesSettled: true,
        tonicSettled: false,
        relativeAlternative: 'E minor',
        noteSetP: null,
        why: 'engine_relative_pair_unresolved',
      });
    });

    it('is worth more than a blind hedge and less than a lone confident reading', () => {
      expect(CERTAINTY_PCT.tonicOpen).toBeGreaterThan(CERTAINTY_PCT.hedged);
      expect(CERTAINTY_PCT.tonicOpen).toBeLessThan(CERTAINTY_PCT.loneMax);
    });

    it('draws the identical seven notes either way — which is why the claim is safe', () => {
      const shown = buildScaleNotes('G', 'major').map((n) => n.pitchClass).sort();
      const other = buildScaleNotes('E', 'minor').map((n) => n.pitchClass).sort();
      expect(shown).toEqual(other);
    });

    it('still hedges when the runner-up is a different set of notes', () => {
      const unrelated = engine({
        primaryKey: 'G',
        primaryScale: 'major',
        ambiguous: true,
        alternatives: [{ key: 'D', scale: 'minor', displayName: 'D minor' }],
      });
      expect(fuse({ detected: unrelated })).toMatchObject({
        certainty: 'hedged',
        notesSettled: false,
        tonicSettled: false,
        relativeAlternative: null,
        noteSetP: null,
      });
    });

    /**
     * Taken from a field recording of "Dimyon Hofshi" (E minor). The readout hedged E minor at a
     * pair margin of 0.288, and four seconds later moved the root marker to G major at 0.107 — it
     * followed the *weaker* evidence, because nothing gave the answer already on the neck a tie.
     */
    describe('a coin flip does not get to repaint the neck every four seconds', () => {
      const showingEmin: FusedKey = {
        root: 'E',
        scale: 'minor',
        displayName: 'E minor',
        source: 'detected',
        certainty: 'tonic_open',
        confidencePct: CERTAINTY_PCT.tonicOpen,
        notesSettled: true,
        tonicSettled: false,
        relativeAlternative: 'G major',
        noteSetP: null,
        trackIdentity: null,
        why: 'engine_relative_pair_unresolved',
      };

      it('keeps the end of the pair the neck already shows', () => {
        expect(fuse({ detected: torn, held: showingEmin })).toMatchObject({
          root: 'E',
          scale: 'minor',
          certainty: 'tonic_open',
          notesSettled: true,
          tonicSettled: false,
          relativeAlternative: 'G major',
          noteSetP: null,
          why: 'relative_flip_resisted',
        });
      });

      /**
       * The engine reaches `likely_key` at 100% by counting agreeing windows, and window agreement
       * is the one thing that cannot separate two names for the same seven notes. In the live
       * capture this is precisely how G major got in after a minute of being held off.
       */
      it('does not yield to a confident reading of the same seven notes', () => {
        expect(fuse({ detected: { ...torn, ambiguous: false }, held: showingEmin })).toMatchObject({
          root: 'E',
          scale: 'minor',
          certainty: 'tonic_open',
          why: 'relative_flip_resisted',
        });
      });

      /** The anchor is about one note set with two names. A different note set is not its business. */
      it('lets a genuinely different key through at any confidence', () => {
        const elsewhere = engine({
          primaryKey: 'Bb',
          primaryScale: 'major',
          displayName: 'Bb major',
          ambiguous: false,
        });
        expect(fuse({ detected: elsewhere, held: showingEmin })).toMatchObject({
          root: 'Bb',
          scale: 'major',
          certainty: 'lone',
        });
      });

      /**
       * The hole the second live run found: the engine attributed the same doubt to `gating_denied`
       * on one cycle and sent no alternatives with it, and the neck flipped on that single gap.
       * The anchor must not depend on the engine naming the pair.
       */
      it('holds even when the engine names no alternative at all', () => {
        const unnamed = engine({
          primaryKey: 'G',
          primaryScale: 'major',
          displayName: 'G major',
          ambiguous: true,
          alternatives: [],
        });
        expect(fuse({ detected: unnamed, held: showingEmin })).toMatchObject({
          root: 'E',
          scale: 'minor',
          why: 'relative_flip_resisted',
        });
      });

      it('does not hold a new song back with the last one\'s root', () => {
        expect(
          fuse({ detected: torn, held: showingEmin, trackIdentity: 'a-different-song' }),
        ).toMatchObject({ root: 'G', why: 'engine_relative_pair_unresolved' });
      });

      it('does not anchor to a merely held leftover', () => {
        const leftover: FusedKey = { ...showingEmin, source: 'held', certainty: 'held' };
        expect(fuse({ detected: torn, held: leftover })).toMatchObject({
          root: 'G',
          why: 'engine_relative_pair_unresolved',
        });
      });

      it('does not anchor to an unrelated key that happens to be on the neck', () => {
        const unrelated: FusedKey = { ...showingEmin, root: 'D', scale: 'minor', displayName: 'D minor' };
        expect(fuse({ detected: torn, held: unrelated })).toMatchObject({
          root: 'G',
          why: 'engine_relative_pair_unresolved',
        });
      });
    });

    /**
     * With calibrated evidence the neck weighs one reading against what it already shows: by
     * repetition for the other end of the same notes, by probability for different notes. See
     * `neckHold` for the 666-clip replay behind both.
     */
    describe('one reading against the neck, when the engine sends its evidence', () => {
      const evidence = (confidence: number, noteSetRun: number, keyRun: number) => ({
        noteSetEvidence: { confidence, noteSetRun, keyRun },
      });
      const neck = (over: Partial<FusedKey>): FusedKey => ({
        root: 'A',
        scale: 'major',
        displayName: 'A major',
        source: 'detected',
        certainty: 'lone',
        confidencePct: 80,
        notesSettled: false,
        tonicSettled: true,
        relativeAlternative: null,
        trackIdentity: null,
        noteSetP: 0.8,
        why: 'engine_only',
        ...over,
      });
      const Fsharp = { primaryKey: 'F#', primaryScale: 'minor', displayName: 'F# minor' };
      const D = { primaryKey: 'D', primaryScale: 'major', displayName: 'D major' };

      it('holds the root against the other end of its notes read once', () => {
        const fused = fuse({ detected: engine({ ...Fsharp, ...evidence(0.9, 4, 0) }), held: neck({}) });
        expect(fused).toMatchObject({
          root: 'A',
          scale: 'major',
          certainty: 'tonic_open',
          relativeAlternative: 'F# minor',
          noteSetP: 0.8,
          why: 'relative_flip_resisted',
        });
        expect(shouldRevise(neck({}), fused)).toBe(false);
      });

      it('moves the root once the other end has been read twice running', () => {
        const held = neck({});
        const fused = fuse({ detected: engine({ ...Fsharp, ...evidence(0.7, 4, 1) }), held });
        expect(fused).toMatchObject({ root: 'F#', scale: 'minor', noteSetP: 0.7 });
        expect(shouldRevise(held, fused)).toBe(true);
      });

      it('keeps the diagram against one reading of different notes that is less likely right', () => {
        const held = neck({});
        const fused = fuse({ detected: engine({ ...D, ambiguous: true, ...evidence(0.6, 0, 0) }), held });
        // The card names what the neck shows rather than a key the neck is not drawing.
        expect(fused).toMatchObject({ root: 'A', scale: 'major', certainty: 'lone', why: 'weaker_reading_resisted' });
        expect(shouldRevise(held, fused)).toBe(false);
      });

      it('lets different notes in when they are at least as likely right', () => {
        const held = neck({});
        const fused = fuse({ detected: engine({ ...D, ...evidence(0.85, 0, 0) }), held });
        expect(fused).toMatchObject({ root: 'D', scale: 'major', noteSetP: 0.85 });
        expect(shouldRevise(held, fused)).toBe(true);
      });

      /**
       * The case the old margin got wrong: the second reading of new notes is hedged, and a hedged
       * 35% could never displace a lone 80% however long the analyzer went on naming it.
       */
      it('lets different notes in once they have been read twice running, however unsure', () => {
        const held = neck({});
        const fused = fuse({ detected: engine({ ...D, ambiguous: true, ...evidence(0.5, 1, 1) }), held });
        expect(fused).toMatchObject({ root: 'D', certainty: 'hedged', noteSetP: 0.5 });
        expect(shouldRevise(held, fused)).toBe(true);
      });

      it('never holds a new song back with the last one\'s notes', () => {
        const held = neck({ trackIdentity: 'song-1' });
        const fused = fuse({
          detected: engine({ ...D, ambiguous: true, ...evidence(0.3, 0, 0) }),
          held,
          trackIdentity: 'song-2',
        });
        expect(fused).toMatchObject({ root: 'D', trackIdentity: 'song-2' });
        expect(shouldRevise(held, fused)).toBe(true);
      });

      it('hands a neck with no evidence the first calibrated reading of its own key', () => {
        const held = neck({ root: 'D', scale: 'major', displayName: 'D major', noteSetP: null });
        const fused = fuse({ detected: engine({ ...D, ...evidence(0.8, 2, 2) }), held });
        expect(fused).toMatchObject({ root: 'D', noteSetP: 0.8 });
        expect(shouldRevise(held, fused)).toBe(true);
        // Once it has one, an agreeing reading does not keep replacing it.
        const again = fuse({ detected: engine({ ...D, ...evidence(0.7, 3, 3) }), held: fused });
        expect(shouldRevise(fused, again)).toBe(false);
      });

      it('falls back to the old margin when the neck was never calibrated', () => {
        const held = neck({ noteSetP: null });
        const fused = fuse({ detected: engine({ ...D, ambiguous: true, ...evidence(0.9, 0, 0) }), held });
        expect(fused).toMatchObject({ root: 'D', certainty: 'hedged' });
        expect(shouldRevise(held, fused)).toBe(false);
      });
    });

    it('never claims an open tonic when the engine is not hedging at all', () => {
      expect(relativeHedge({ ...torn, ambiguous: false })).toBeNull();
      expect(fuse({ detected: { ...torn, ambiguous: false } })).toMatchObject({
        certainty: 'lone',
        tonicSettled: true,
        relativeAlternative: null,
        noteSetP: null,
      });
    });

    it('does not claim settled notes for a lone reading that could be a semitone out', () => {
      expect(fuse({ detected: engine({ confidence: 1 }) })).toMatchObject({
        certainty: 'lone',
        notesSettled: false,
      });
    });

    it('lets a verified row close the root the engine left open', () => {
      expect(fuse({ verified: verifiedDm, detected: torn })).toMatchObject({
        root: 'D',
        certainty: 'verified',
        tonicSettled: true,
        relativeAlternative: null,
        noteSetP: null,
      });
    });
  });

  it('shows an ambiguous engine reading rather than an empty neck', () => {
    const fused = fuse({ detected: engine({ ambiguous: true, confidence: 0.4 }) });
    expect(fused).toMatchObject({ root: 'D', scale: 'minor', certainty: 'hedged' });
    expect(fused.confidencePct).toBeGreaterThan(0);
  });

  it('caps a lone engine reading below a verified one however sure the engine is', () => {
    const fused = fuse({ detected: engine({ confidence: 1 }) });
    expect(fused.confidencePct).toBe(CERTAINTY_PCT.loneMax);
    expect(fused.confidencePct).toBeLessThan(CERTAINTY_PCT.verified);
  });

  it('holds the last key when no leg answers, instead of blanking the neck', () => {
    const held: FusedKey = {
      root: 'D',
      scale: 'minor',
      displayName: 'D minor',
      source: 'detected',
      certainty: 'lone',
      confidencePct: CERTAINTY_PCT.loneMax,
      notesSettled: true,
      tonicSettled: true,
      relativeAlternative: null,
      noteSetP: null,
      trackIdentity: 'track-1',
      why: 'engine_only',
    };
    const fused = fuse({ detected: silent, held });
    expect(fused).toMatchObject({ root: 'D', scale: 'minor', source: 'held', certainty: 'held' });
  });

  it('reports nothing only when no leg has ever answered', () => {
    expect(fuse({ detected: silent })).toMatchObject({ root: null, source: 'none', certainty: 'none' });
  });

  it('ignores an engine scale the fretboard cannot draw', () => {
    const modal = engine({ primaryScale: 'dorian', displayName: 'D dorian' });
    expect(fuse({ detected: modal }).source).toBe('none');
  });
});

describe('shouldRevise', () => {
  const at = (confidencePct: number, over: Partial<FusedKey> = {}): FusedKey => ({
    root: 'D',
    scale: 'minor',
    displayName: 'D minor',
    source: 'detected',
    certainty: 'lone',
    confidencePct,
    notesSettled: true,
    tonicSettled: true,
    relativeAlternative: null,
    noteSetP: null,
    trackIdentity: 'track-1',
    why: 'test',
    ...over,
  });

  it('puts the first answer up with nothing to compare against', () => {
    expect(shouldRevise(null, at(35))).toBe(true);
  });

  it('does not re-apply the key already on the neck', () => {
    expect(shouldRevise(at(70), at(90))).toBe(false);
  });

  it('holds a diagram still against a slightly weaker different key from the same engine', () => {
    const current = at(70, { source: 'detected' });
    const next = at(70 - 1, {
      root: 'G',
      scale: 'major',
      source: 'detected',
    });
    expect(shouldRevise(current, next)).toBe(false);
  });

  it('moves the neck once a rival reading clears the margin', () => {
    const current = at(70, { source: 'detected' });
    const next = at(70 + REVISION_MARGIN_PCT, { root: 'G', scale: 'major', source: 'detected' });
    expect(shouldRevise(current, next)).toBe(true);
  });

  it('follows a leg that revised itself, without charging it the margin twice', () => {
    const current = at(85, { source: 'detected' });
    const next = at(85, { root: 'G', scale: 'major', source: 'detected' });
    expect(shouldRevise(current, next)).toBe(true);
  });

  it('does not let a leg hedge its way out of a confident reading', () => {
    const current = at(85, { source: 'detected', certainty: 'lone' });
    const next = at(35, { root: 'G', scale: 'major', source: 'detected', certainty: 'hedged' });
    expect(shouldRevise(current, next)).toBe(false);
  });

  it('never lets the previous song hold the neck against the new one', () => {
    const current = at(85, { source: 'detected', certainty: 'lone', trackIdentity: 'track-1' });
    const next = at(35, { root: 'G', scale: 'major', source: 'detected', certainty: 'hedged', trackIdentity: 'track-2' });
    expect(shouldRevise(current, next)).toBe(true);
  });

  it('never makes a human-entered key wait its turn', () => {
    const current = at(85, { certainty: 'lone' });
    const next = at(CERTAINTY_PCT.verified, { root: 'G', scale: 'major', certainty: 'verified', source: 'verified' });
    expect(shouldRevise(current, next)).toBe(true);
  });

  it('yields a merely held key to any real answer', () => {
    const current = at(85, { certainty: 'held' });
    const next = at(35, { root: 'G', scale: 'major', certainty: 'hedged' });
    expect(shouldRevise(current, next)).toBe(true);
  });
});

describe('clearsApplyGate', () => {
  const at = (confidencePct: number): FusedKey => ({
    root: 'D',
    scale: 'minor',
    displayName: 'D minor',
    source: 'detected',
    certainty: 'lone',
    confidencePct,
    notesSettled: true,
    tonicSettled: true,
    relativeAlternative: null,
    noteSetP: null,
    trackIdentity: 'track-1',
    why: 'test',
  });

  it('passes everything at the gate it ships with, so a scale still costs zero touches', () => {
    for (const pct of [0, CERTAINTY_PCT.hedged, CERTAINTY_PCT.tonicOpen, CERTAINTY_PCT.verified]) {
      expect(clearsApplyGate(at(pct), 0)).toBe(true);
    }
  });

  it('holds a reading back only while it is under the gate, and takes it on the nose', () => {
    expect(clearsApplyGate(at(CERTAINTY_PCT.hedged), 70)).toBe(false);
    expect(clearsApplyGate(at(69), 70)).toBe(false);
    expect(clearsApplyGate(at(70), 70)).toBe(true);
    expect(clearsApplyGate(at(CERTAINTY_PCT.loneMax), 70)).toBe(true);
  });

  it('never gates out a human transcription, whatever the slider says', () => {
    expect(clearsApplyGate(at(CERTAINTY_PCT.verified), 100)).toBe(true);
  });

  it('treats a missing or nonsense gate as open rather than as a wall', () => {
    expect(clearsApplyGate(at(CERTAINTY_PCT.hedged), Number.NaN)).toBe(true);
    expect(clearsApplyGate(at(CERTAINTY_PCT.hedged), -40)).toBe(true);
    // Above the top of the scale the gate clamps to 100, which only verified can reach.
    expect(clearsApplyGate(at(CERTAINTY_PCT.loneMax), 400)).toBe(false);
    expect(clearsApplyGate(at(CERTAINTY_PCT.verified), 400)).toBe(true);
  });
});

describe('engine sequence', () => {
  it('lets the engine take the neck once it fills its buffer', () => {
    const first = fuse({ detected: silent, trackIdentity: 'stairway' });
    expect(first).toMatchObject({ root: null, source: 'none' });

    const later = fuse({
      detected: engine({ primaryKey: 'A', primaryScale: 'minor', displayName: 'A minor', confidence: 1, ambiguous: false }),
      held: first,
      trackIdentity: 'stairway',
    });
    expect(later).toMatchObject({
      root: 'A',
      scale: 'minor',
      source: 'detected',
      certainty: 'lone',
      why: 'engine_only',
    });
    expect(shouldRevise(first, later)).toBe(true);
  });
});

/**
 * From a real capture of "You've Got a Friend in Me" (E♭ major). The engine had the seven notes
 * exactly right on every cycle and the readout still said "A# major", then "D# major" — because
 * `key_engine.rs` indexes a sharp-only table and nothing between it and the neck respelled the
 * result. `buildScaleNotes` drew those names literally, so the fretboard carried four double
 * sharps and then three.
 */
describe('the engine names a pitch class, not a key', () => {
  const neck = (key: string, mode: 'major' | 'minor') =>
    buildScaleNotes(key, mode)
      .map((n) => n.label)
      .join(' ');

  it('spells the flat major keys the way a chart does', () => {
    for (const [heard, expected] of [
      ['D#', 'Eb'],
      ['A#', 'Bb'],
      ['G#', 'Ab'],
      ['C#', 'Db'],
    ] as const) {
      expect(
        fuse({ detected: engine({ primaryKey: heard, primaryScale: 'major', displayName: `${heard} major` }) }),
      ).toMatchObject({ root: expected, scale: 'major', displayName: `${expected} major` });
    }
  });

  /** Not "always flats": the spelling with the fewest accidentals depends on the mode. */
  it('keeps the sharp spelling where that is the one with fewer accidentals', () => {
    for (const [heard, expected] of [
      ['G#', 'G#'],
      ['C#', 'C#'],
      ['F#', 'F#'],
    ] as const) {
      expect(
        fuse({ detected: engine({ primaryKey: heard, primaryScale: 'minor', displayName: `${heard} minor` }) }),
      ).toMatchObject({ root: expected, scale: 'minor' });
    }
    expect(fuse({ detected: engine({ primaryKey: 'A#', primaryScale: 'minor' }) })).toMatchObject({ root: 'Bb' });
  });

  it('never puts a double accidental on the neck', () => {
    for (let pitchClass = 0; pitchClass < 12; pitchClass += 1) {
      for (const mode of ['major', 'minor'] as const) {
        const heard = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][pitchClass] as string;
        const fused = fuse({ detected: engine({ primaryKey: heard, primaryScale: mode }) });
        expect(fused.root).not.toBeNull();
        expect(neck(fused.root as string, mode)).not.toContain('##');
        expect(neck(fused.root as string, mode)).not.toContain('bb');
      }
    }
  });

  it('respells the alternative it reads out beside the root', () => {
    const hedging = engine({
      primaryKey: 'D#',
      primaryScale: 'major',
      displayName: 'D# major',
      ambiguous: true,
      alternatives: [{ key: 'C', scale: 'minor', displayName: 'C minor' }],
    });
    expect(relativeHedge(hedging)).toMatchObject({ key: 'C', mode: 'minor' });
    expect(fuse({ detected: hedging })).toMatchObject({ root: 'Eb', scale: 'major', certainty: 'tonic_open' });
  });

  it('leaves the spelling a human transcription chose alone', () => {
    expect(
      fuse({ verified: { key: 'D#', mode: 'minor', displayName: 'D# minor' }, detected: silent }),
    ).toMatchObject({ root: 'D#', scale: 'minor', source: 'verified' });
  });
});
