import { pitchClassForNoteLabel } from '../scaleSpell';

/**
 * The one place that decides what key is on the neck.
 *
 * The verified library is a bundled transcription. Everything else is an estimate from the
 * local engine that heard this recording. There is no server and no catalog leg.
 *
 * **Nothing is ever withheld.** A weak engine reading still goes up labelled weak, and is
 * replaced as better evidence arrives (see `shouldRevise`). A blank neck helps nobody.
 */

export type KeyMode = 'major' | 'minor';

/** How much the key on the neck is worth, in the order the revision policy compares them. */
export const CERTAINTY_PCT = {
  /** A person wrote it down. Nothing outranks it. */
  verified: 100,
  /** Ceiling for a lone engine reading. */
  loneMax: 85,
  /**
   * The engine cannot pick between a key and its relative — but both draw the same seven notes,
   * so the diagram is right and only the root marker is open. Measured on the 72-clip corpus
   * (`src-tauri/tests/key_accuracy_scoreboard.rs`), this is where 22 of the engine's 24 misses
   * live: note-set accuracy 97.2%, tonic accuracy 66.7%. Pricing it like a blind guess would
   * throw away a correct fretboard.
   */
  tonicOpen: 70,
  /** The engine is still hedging, but it is all we have. */
  hedged: 35,
} as const;

/**
 * How much better a new answer must be before it is allowed to move the neck.
 *
 * Without a margin the neck would twitch between two readings that keep trading a point of
 * confidence, which is worse than being briefly wrong: a player cannot use a diagram that
 * moves. This mirrors `KEY_SWITCH_HYSTERESIS_CONF_MARGIN` in the Rust engine.
 */
export const REVISION_MARGIN_PCT = 8;

export type KeyCertainty =
  | 'verified'
  | 'lone'
  /** Right notes, open root: the engine is torn between a key and its relative. */
  | 'tonic_open'
  | 'hedged'
  | 'held'
  | 'none';

export type FusedSource = 'verified' | 'detected' | 'held' | 'none';

export type KeyCandidate = {
  key: string;
  mode: KeyMode;
  displayName?: string | null;
};

export type DetectedCandidate = {
  primaryKey: string | null;
  primaryScale: string | null;
  displayName: string | null;
  /** The engine's own 0-1 confidence. */
  confidence: number;
  /** The engine could not separate its top candidates. */
  ambiguous: boolean;
  /**
   * The engine's runner-up readings, best first. The Rust side collapses every cause of doubt
   * into the single `ambiguous` boolean, so this list is the only way to tell "torn between G
   * major and E minor, which are the same notes" from "no idea at all".
   */
  alternatives?: ReadonlyArray<{ key: string; scale: string; displayName?: string | null }>;
};

export type FusionInput = {
  /** A human-entered key, from the bundled dictionary or the database. */
  verified: KeyCandidate | null;
  detected: DetectedCandidate;
  /** What is on the neck right now, so a momentary silence does not blank it. */
  held: FusedKey | null;
  /** The track this reading is about, so a new song is never held back by the old one's key. */
  trackIdentity?: string | null;
};

export type FusedKey = {
  root: string | null;
  scale: KeyMode | null;
  displayName: string | null;
  source: FusedSource;
  certainty: KeyCertainty;
  /** 0-100. Drives the meter and the revision margin; it no longer gates anything. */
  confidencePct: number;
  /**
   * The seven notes are corroborated by more than one estimator's top pick.
   *
   * True for a human transcription. Also true on a relative-pair hedge — not as a bet that the
   * engine is right, but because a key and its relative are *mathematically* one pitch-class
   * set, so the engine's own doubt provably does not reach the diagram.
   *
   * False for a lone engine reading however confident it sounds: a reading that is a semitone
   * out is confidently wrong, and "Scale tones confirmed" would be a lie. That invariant is
   * enforced by `keyPipeline.simulation.test.ts` — it fails any verdict that claims settled
   * notes while the notes are wrong.
   */
  notesSettled: boolean;
  /**
   * No rival reading contests *which* of those notes is home. False only on a relative-pair
   * hedge, where a specific, nameable alternative is in play and the root marker plus the degree
   * ruler are a coin flip. Independent of `notesSettled`: one is about corroboration of the
   * diagram, the other about a named rival for the root.
   */
  tonicSettled: boolean;
  /**
   * The other reading of the same seven notes, when there is one — "E minor" while the neck says
   * G major. Null unless `notesSettled && !tonicSettled`.
   */
  relativeAlternative: string | null;
  /** The track this reading describes. */
  trackIdentity: string | null;
  /** Machine-readable reason, mirrored into the trace log. */
  why: string;
};

const NOTHING: Omit<FusedKey, 'trackIdentity'> = {
  root: null,
  scale: null,
  displayName: null,
  source: 'none',
  certainty: 'none',
  confidencePct: 0,
  notesSettled: false,
  tonicSettled: false,
  relativeAlternative: null,
  why: 'no_leg_answered',
};

function displayOf(candidate: { key: string; mode: KeyMode; displayName?: string | null }): string {
  return candidate.displayName?.trim() || `${candidate.key} ${candidate.mode}`;
}

function isMode(value: string | null): value is KeyMode {
  return value === 'major' || value === 'minor';
}

/** The engine's reading, but only when the fretboard can actually draw it. */
function usableDetected(detected: DetectedCandidate): KeyCandidate | null {
  if (!detected.primaryKey || !isMode(detected.primaryScale)) {
    return null;
  }
  if (pitchClassForNoteLabel(detected.primaryKey) === null) {
    return null;
  }
  return {
    key: detected.primaryKey,
    mode: detected.primaryScale,
    displayName: detected.displayName,
  };
}

export type KeyRelation = 'same' | 'relative' | 'unrelated';

/**
 * Compared by pitch class, never by spelling: "Gb" and "F#" are the same key.
 */
export function compareKeys(
  a: { key: string; mode: KeyMode },
  b: { key: string; mode: KeyMode },
): KeyRelation {
  const pcA = pitchClassForNoteLabel(a.key);
  const pcB = pitchClassForNoteLabel(b.key);
  if (pcA === null || pcB === null) {
    return 'unrelated';
  }
  if (pcA === pcB && a.mode === b.mode) {
    return 'same';
  }
  // A relative pair is one note set with two names: the minor tonic sits three semitones below
  // the major one. Anything else is two different sets of notes.
  if (a.mode === 'minor' && b.mode === 'major' && (pcA + 3) % 12 === pcB) {
    return 'relative';
  }
  if (a.mode === 'major' && b.mode === 'minor' && (pcB + 3) % 12 === pcA) {
    return 'relative';
  }
  return 'unrelated';
}

type Verdict = {
  source: FusedSource;
  certainty: KeyCertainty;
  confidencePct: number;
  notesSettled: boolean;
  tonicSettled: boolean;
  relativeAlternative?: string | null;
  why: string;
};

function fromCandidate(
  candidate: KeyCandidate,
  verdict: Verdict,
  trackIdentity: string | null,
): FusedKey {
  return {
    root: candidate.key,
    scale: candidate.mode,
    displayName: displayOf(candidate),
    relativeAlternative: verdict.relativeAlternative ?? null,
    trackIdentity,
    ...verdict,
  };
}

/**
 * The engine's runner-up, but only when it is the relative of its own top answer.
 *
 * This is the one case where "ambiguous" does not mean "we do not know the notes". A key and its
 * relative are one pitch-class set with two names, so when these are the two candidates in play
 * the fretboard is already correct and the only open question is which note is home. The Rust
 * engine knows this (`relative_pair_unresolved` in `key_engine.rs`) but flattens it into the same
 * `ambiguous` flag it uses for "not enough audio yet", so we recover it from the candidate list.
 */
export function relativeHedge(detected: DetectedCandidate): KeyCandidate | null {
  if (!detected.ambiguous) {
    return null;
  }
  const primary = usableDetected(detected);
  if (!primary) {
    return null;
  }
  for (const alternative of detected.alternatives ?? []) {
    if (!isMode(alternative.scale) || pitchClassForNoteLabel(alternative.key) === null) {
      continue;
    }
    const candidate: KeyCandidate = {
      key: alternative.key,
      mode: alternative.scale,
      displayName: alternative.displayName,
    };
    if (compareKeys(primary, candidate) === 'relative') {
      return candidate;
    }
  }
  return null;
}

export function fuseKey({ verified, detected, held, trackIdentity = null }: FusionInput): FusedKey {
  if (verified) {
    return fromCandidate(
      verified,
      {
        source: 'verified',
        certainty: 'verified',
        confidencePct: CERTAINTY_PCT.verified,
        notesSettled: true,
        tonicSettled: true,
        why: 'human_entered',
      },
      trackIdentity,
    );
  }

  const local = usableDetected(detected);
  if (local) {
    const engine = Math.round(Math.max(0, Math.min(1, detected.confidence || 0)) * 100);
    if (detected.ambiguous) {
      // A relative-pair hedge is not the same defect as "no idea". The seven notes are agreed;
      // only the root is open. Saying "unsure" here would understate a correct fretboard, and
      // silently committing to one root would overstate a coin flip.
      const relative = relativeHedge(detected);
      if (relative) {
        return fromCandidate(
          local,
          {
            source: 'detected',
            certainty: 'tonic_open',
            confidencePct: CERTAINTY_PCT.tonicOpen,
            notesSettled: true,
            tonicSettled: false,
            relativeAlternative: displayOf(relative),
            why: 'engine_relative_pair_unresolved',
          },
          trackIdentity,
        );
      }
      return fromCandidate(
        local,
        {
          source: 'detected',
          certainty: 'hedged',
          confidencePct: CERTAINTY_PCT.hedged,
          notesSettled: false,
          tonicSettled: false,
          why: 'engine_ambiguous_but_shown',
        },
        trackIdentity,
      );
    }
    return fromCandidate(
      local,
      {
        source: 'detected',
        certainty: 'lone',
        confidencePct: Math.min(engine, CERTAINTY_PCT.loneMax),
        // One estimator's top pick, with nothing corroborating the note set — a confident engine
        // reading that is a semitone out is confidently wrong, so this must not claim settled
        // notes. (`keyPipeline.simulation.test.ts` fails the moment it does.)
        notesSettled: false,
        // Nothing *specific* contests the root either: there is no named rival reading the way
        // there is in a relative-pair hedge, so the card has no second name to offer.
        tonicSettled: true,
        why: 'engine_only',
      },
      trackIdentity,
    );
  }

  if (held && held.root && held.scale) {
    return { ...held, source: 'held', certainty: 'held', why: 'holding_last_key' };
  }

  return { ...NOTHING, trackIdentity };
}

/**
 * Should `next` replace what is on the neck?
 *
 * The margin exists for one situation: two rival answers about the same song, arriving at the
 * same time, trading a point of confidence. A diagram that twitches is unusable.
 *
 * It must not apply to a new song, a verified transcription, a merely held leftover, or a leg
 * revising itself upward — the Rust engine already ran its own hysteresis to earn that change.
 */
export function shouldRevise(current: FusedKey | null, next: FusedKey): boolean {
  if (!next.root || !next.scale) {
    return false;
  }
  if (!current || !current.root || !current.scale) {
    return true;
  }
  if (compareKeys({ key: current.root, mode: current.scale }, { key: next.root, mode: next.scale }) === 'same') {
    return false;
  }
  if (next.certainty === 'verified') {
    return true;
  }
  if (current.certainty === 'held' || current.certainty === 'none') {
    return true;
  }
  if (next.trackIdentity !== current.trackIdentity) {
    return true;
  }
  if (next.source === current.source && next.confidencePct >= current.confidencePct) {
    return true;
  }
  return next.confidencePct >= current.confidencePct + REVISION_MARGIN_PCT;
}
