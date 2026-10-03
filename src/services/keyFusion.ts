import { pitchClassForNoteLabel } from '../scaleSpell';
import { ADVICE_TONIC_FIRM, noteSetOf, type AdviceSource, type KeyAdvice } from './keyAdvice';
import { pitchClassToKey } from './keyParse';

/**
 * The one place that decides what key is on the neck.
 *
 * The verified library is a bundled transcription. The local engine is an estimate from the audio
 * it heard. Between them sit the chords (`keyAdvice.ts`): the chart scraped for the song, and the
 * chords the recogniser read off its saved copy — estimates too, but ones that arrive before the
 * engine has heard enough, and that are good at the half of the question the engine is bad at.
 *
 * The chords **advise; they do not dictate.** They fill the neck while the engine is still
 * listening; when the engine hears the same seven notes, the two witnesses confirm each other and
 * the chords name the root; when it hears different notes, the neck goes with whichever is likelier
 * to be right — the chords until the engine's calibrated probability passes theirs, the engine from
 * then on. The engine never hears the chords: its readings stay an independent witness, which is
 * what makes their agreement worth anything.
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
  /**
   * The chords and the engine heard the same seven notes. Two witnesses that cannot have copied
   * each other — one read chords, the other a chromagram — agreeing on one of twelve note sets;
   * above any lone reading, below a person. A rung rather than a computed posterior because what it
   * would be computed from, how often the two are wrong the *same* way, has not been measured.
   */
  confirmed: 90,
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
  /** The chords and the engine agree on the seven notes; the chords named the root. */
  | 'confirmed'
  | 'lone'
  /** Right notes, open root: the engine is torn between a key and its relative. */
  | 'tonic_open'
  /** The chords' key, before the engine has heard it — or while it hears something it is less sure of. */
  | 'advised'
  | 'hedged'
  | 'held'
  | 'none';

export type FusedSource = 'verified' | 'confirmed' | 'advised' | 'detected' | 'held' | 'none';

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
  /**
   * What the engine's calibrated model read off the analyzer about this key. Absent or null when
   * the backend could not supply it (the python sidecar never does), and then the neck falls back
   * to comparing `confidence`, which is a vote share rather than a probability.
   */
  noteSetEvidence?: NoteSetEvidence | null;
};

/** Mirrors `NoteSetEvidence` in `audio_models.rs`. */
export type NoteSetEvidence = {
  /** The probability that the key's seven notes are the song's. */
  confidence: number;
  /** How many analyzer readings immediately before this one named the same seven notes. */
  noteSetRun: number;
  /** How many analyzer readings immediately before this one named this exact key. */
  keyRun: number;
};

export type FusionInput = {
  /** A human-entered key, from the bundled dictionary or the database. */
  verified: KeyCandidate | null;
  detected: DetectedCandidate;
  /** What is on the neck right now, so a momentary silence does not blank it. */
  held: FusedKey | null;
  /** The track this reading is about, so a new song is never held back by the old one's key. */
  trackIdentity?: string | null;
  /** What the chords say — see `keyAdvice.ts`. Ignored unless it is about `trackIdentity`. */
  advice?: KeyAdvice | null;
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
  /**
   * The engine's calibrated probability that these seven notes are right, as it stood when this
   * key was read. Null for anything the engine did not calibrate — a verified row, a vote-share
   * backend. This, not `confidencePct`, is what a later reading of different notes has to beat.
   */
  noteSetP: number | null;
  /** Machine-readable reason, mirrored into the trace log. */
  why: string;
  /** The chord legs behind this key — the scraped chart, the recording's chords — when any are. */
  advisedBy?: AdviceSource[] | null;
  /** The engine's reading, when it hears other notes than the chords and has not yet earned the neck. */
  contestedBy?: string | null;
  /**
   * The seven notes (`noteSetOf`) of the chords' key this engine reading displaced. Carried while the
   * engine goes on hearing its own notes, so a reading that dips back under the chords' price does
   * not hand the neck back to them and the diagram does not swap on every reading.
   */
  overruledAdvice?: number | null;
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
  noteSetP: null,
  why: 'no_leg_answered',
};

function displayOf(candidate: { key: string; mode: KeyMode; displayName?: string | null }): string {
  return candidate.displayName?.trim() || `${candidate.key} ${candidate.mode}`;
}

function isMode(value: string | null): value is KeyMode {
  return value === 'major' || value === 'minor';
}

/**
 * The engine names a pitch class. It does not name a key, and the difference reaches the neck.
 *
 * `key_engine.rs` indexes a fixed sharp-only table, so `PITCH_NAMES[3]` is `"D#"` because that is
 * what sits at index 3 — not because anything decided the song was in D sharp. `keyParse`'s
 * `normalizeTonic` then preserves that spelling, which is right for the job it was written for: a
 * catalog row that says "Bb minor" has *chosen* a spelling and must keep it. The engine chose
 * nothing, so preserving its spelling preserves an artefact of a lookup table.
 *
 * What a player saw, from a real capture of "You've Got a Friend in Me" (E♭ major): the readout
 * said "A# major", then "D# major", and `buildScaleNotes` drew them literally —
 * `A# B# C## D# E# F## G##` and `D# E# F## G# A# B# C##`. Four double sharps and three, key
 * signatures no chart is written in, for a song whose seven notes the engine had exactly right.
 *
 * `pitchClassToKey` already holds the mode-aware answer and says so in its own comment — pc 3 is
 * E♭ major but D#/E♭ minor, pc 8 is A♭ major but G# minor, so a pitch class alone cannot decide
 * it. It was simply never reached from here: it is on the branch for sources that report a
 * numeric pitch class, and the local detector reports strings.
 */
function spellForMode(key: string, mode: KeyMode): string | null {
  const pitchClass = pitchClassForNoteLabel(key);
  if (pitchClass === null) {
    return null;
  }
  return pitchClassToKey(pitchClass, mode);
}

/** The engine's reading, but only when the fretboard can actually draw it. */
function usableDetected(detected: DetectedCandidate): KeyCandidate | null {
  if (!detected.primaryKey || !isMode(detected.primaryScale)) {
    return null;
  }
  const key = spellForMode(detected.primaryKey, detected.primaryScale);
  if (key === null) {
    return null;
  }
  return {
    key,
    mode: detected.primaryScale,
    // Dropped rather than passed through: the Rust side builds `display_name` as
    // `format!("{key} {scale}")` off the same sharp table, so it carries nothing the pair does not
    // and would put the spelling we just discarded straight back on screen. `displayOf` composes
    // the same string from the corrected key.
    displayName: null,
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
  noteSetP?: number | null;
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
    noteSetP: verdict.noteSetP ?? null,
  };
}

/** A calibrated probability, and not a missing one: a key built by hand may leave it undefined. */
function isProbability(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** The engine's calibrated evidence, when it sent some that is usable. */
function evidenceOf(detected: DetectedCandidate): NoteSetEvidence | null {
  const evidence = detected.noteSetEvidence;
  if (!evidence || !isProbability(evidence.confidence)) {
    return null;
  }
  return evidence;
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
    if (!isMode(alternative.scale)) {
      continue;
    }
    // The named alternative is read out to the player — "or C minor, same notes" — so it needs
    // the same spelling as the primary. It comes off the same sharp table.
    const key = spellForMode(alternative.key, alternative.scale);
    if (key === null) {
      continue;
    }
    const candidate: KeyCandidate = {
      key,
      mode: alternative.scale,
      displayName: null,
    };
    if (compareKeys(primary, candidate) === 'relative') {
      return candidate;
    }
  }
  return null;
}

/**
 * What the neck keeps showing when the reading that just arrived has not earned the move.
 *
 * Two cases, and both are about one reading against the neck rather than about how sure either
 * one sounds:
 *
 * **The other end of the same note set** (`relative`). Derived from the two keys themselves rather
 * than from `detected.alternatives`: an earlier version asked the engine "is this a relative
 * pair?", and a live run showed the engine attributing the same doubt to `gating_denied` on one
 * cycle, sending no alternatives, and the neck flipping E minor -> G major on that one gap. Holding
 * is safe by construction — the two names draw the identical seven notes — so the only question is
 * when to *stop* holding. It used to be never, and on the engine that shipped then that was right:
 * its later confidence was a window vote consolidating over the same audio, which cannot tell two
 * names for one note set apart. Every reading is now the analyzer over a longer buffer, and the
 * root gets better with the audio (55.6% of clips have it at twelve seconds, 64.4% at forty).
 * Replayed over 666 real clips, letting the other end in once it has been read twice running moved
 * 42 roots from wrong to right and 19 from right to wrong, and the root was right 1.9 points more
 * of the time between 12 and 40 seconds — 3.5 points more at forty. A single reading still never
 * moves it, and neither does anything from an engine that sends no evidence.
 *
 * **A different note set, read once, less likely than what is on the neck** (`unrelated`). The
 * engine's calibrated probability is comparable across readings — it was fitted on readings of
 * every length — so a reading that is *less* likely to be right than the one on the neck is not a
 * reason to redraw every note of it. Twice running is, whatever the probability says: by then the
 * neck is showing a key the analyzer has stopped naming. Same 666 clips: the neck changed note set
 * 0.32 times per clip instead of 0.62, moved from right notes to wrong 49 times instead of 111, and
 * was right exactly as often.
 *
 * Not applied to a new song — `trackIdentity` changing means there is nothing to hold — and not to
 * a merely held leftover, which is not evidence about the song now playing. A verified key
 * short-circuits above this and is never resisted.
 */
function neckHold(
  held: FusedKey | null,
  local: KeyCandidate,
  detected: DetectedCandidate,
  trackIdentity: string | null,
): { key: KeyCandidate; relation: 'relative' | 'unrelated' } | null {
  if (!held || held.source !== 'detected' || !held.root || !held.scale) {
    return null;
  }
  if (held.trackIdentity !== trackIdentity) {
    return null;
  }
  const current = { key: held.root, mode: held.scale };
  const relation = compareKeys(current, local);
  const evidence = evidenceOf(detected);
  if (relation === 'relative') {
    return evidence && evidence.keyRun >= 1 ? null : { key: current, relation };
  }
  if (relation === 'unrelated' && evidence && isProbability(held.noteSetP)) {
    const earned = evidence.confidence >= held.noteSetP || evidence.noteSetRun >= 1;
    return earned ? null : { key: current, relation };
  }
  return null;
}

export function fuseKey({ verified, detected, held, trackIdentity = null, advice = null }: FusionInput): FusedKey {
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

  const chords = advice && advice.trackIdentity === trackIdentity ? usableAdvice(advice) : null;
  if (chords) {
    const decided = fuseWithChords(chords, detected, held, trackIdentity);
    if (decided) {
      return decided;
    }
    // The engine has earned the neck against the chords. Its own policy decides what it shows, and
    // the result remembers whose notes it displaced.
    const engine = fuseEngine(detected, held, trackIdentity);
    return engine.root && engine.scale && notesOf({ key: engine.root, mode: engine.scale }) !== chords.notes
      ? { ...engine, overruledAdvice: chords.notes }
      : engine;
  }
  return fuseEngine(detected, held, trackIdentity);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

/** The seven notes of a key, as `noteSetOf` numbers them; -1 for a key the fretboard cannot draw. */
function notesOf(candidate: { key: string; mode: KeyMode }): number {
  const pc = pitchClassForNoteLabel(candidate.key);
  return pc === null ? -1 : noteSetOf(pc, candidate.mode);
}

type UsableAdvice = {
  candidate: KeyCandidate;
  /** The other name for the same seven notes. */
  relative: KeyCandidate;
  notes: number;
  worth: number;
  tonicShare: number;
  sources: AdviceSource[];
  why: string;
};

/** The chords' key, but only when the fretboard can draw it and its price is a probability. */
function usableAdvice(advice: KeyAdvice): UsableAdvice | null {
  if (!isMode(advice.mode) || !isProbability(advice.noteSetP)) {
    return null;
  }
  const key = spellForMode(advice.key, advice.mode);
  const pc = pitchClassForNoteLabel(advice.key);
  if (key === null || pc === null) {
    return null;
  }
  const relativeMode: KeyMode = advice.mode === 'major' ? 'minor' : 'major';
  const relativePc = advice.mode === 'major' ? (pc + 9) % 12 : (pc + 3) % 12;
  return {
    candidate: { key, mode: advice.mode, displayName: null },
    relative: { key: pitchClassToKey(relativePc, relativeMode) ?? key, mode: relativeMode, displayName: null },
    notes: noteSetOf(pc, advice.mode),
    worth: clamp01(advice.noteSetP),
    tonicShare: isProbability(advice.tonicShare) ? advice.tonicShare : 0.5,
    sources: advice.sources,
    why: advice.why,
  };
}

/** The chords' key on the neck, priced at `p`: the chance its notes are right given what the engine hears. */
function advised(
  chords: UsableAdvice,
  p: number,
  contestedBy: string | null,
  trackIdentity: string | null,
  why: string,
): FusedKey {
  // A root the chords name firmly is not contested; a soft one names its rival like a relative hedge.
  const firm = chords.tonicShare >= ADVICE_TONIC_FIRM;
  return {
    ...fromCandidate(
      chords.candidate,
      {
        source: 'advised',
        certainty: 'advised',
        confidencePct: Math.min(CERTAINTY_PCT.loneMax, Math.round(100 * clamp01(p))),
        // One estimator's pick, and the chart may not be in the recording's key at all: the notes
        // are not settled until the audio says so. Two chord legs agreeing do not settle them either
        // — they are one model, and they fail together.
        notesSettled: false,
        tonicSettled: firm,
        relativeAlternative: firm ? null : displayOf(chords.relative),
        noteSetP: null,
        why,
      },
      trackIdentity,
    ),
    advisedBy: chords.sources,
    contestedBy,
  };
}

/**
 * The chords against the engine's reading. Returns the neck's key when the chords decide it, and
 * null when the engine has earned it.
 *
 * **Same seven notes** (the same key, or its relative): confirmed. The chords name the root, since
 * that is the half they are good at and the engine is not — out of fold, when the chart model's
 * notes are right its root is right for 99.4% of songs, while the engine's slips are almost all to
 * the relative. A root the chords only lean towards stays open, with the engine's name beside it.
 *
 * **Different notes**: the likelier witness keeps the neck. The engine's calibrated probability and
 * the chords' price are both the chance of the same event — these seven notes are the song's — so the
 * engine takes the neck when its number passes the chords', and until then the chords hold it at
 * what they are still worth against the disagreement, `w(1-p) / (1-pw)`. A reading of the python
 * backend, which sends no probability, has to be unhedged and vote above the chords' price.
 *
 * Once the engine has displaced the chords (`overruledAdvice`) it keeps the neck for as long as it
 * goes on hearing those notes, whatever its next reading's probability: a dip is not a retraction.
 */
function fuseWithChords(
  chords: UsableAdvice,
  detected: DetectedCandidate,
  held: FusedKey | null,
  trackIdentity: string | null,
): FusedKey | null {
  const local = usableDetected(detected);
  const displaced =
    held !== null &&
    held.trackIdentity === trackIdentity &&
    Boolean(held.root && held.scale) &&
    held.overruledAdvice === chords.notes;
  if (!local) {
    // Nothing heard yet — or the engine went quiet after displacing these chords, when the neck
    // holds what the engine last heard exactly as it would with no chords at all.
    return displaced ? null : advised(chords, chords.worth, null, trackIdentity, `chords_before_engine:${chords.why}`);
  }
  const heard = evidenceOf(detected)?.confidence ?? null;
  const relation = compareKeys(chords.candidate, local);
  if (relation !== 'unrelated') {
    const firm = chords.tonicShare >= ADVICE_TONIC_FIRM;
    const tonicSettled = relation === 'same' || firm;
    return {
      ...fromCandidate(
        chords.candidate,
        {
          source: 'confirmed',
          certainty: 'confirmed',
          confidencePct: CERTAINTY_PCT.confirmed,
          notesSettled: true,
          tonicSettled,
          relativeAlternative: tonicSettled ? null : displayOf(local),
          noteSetP: heard,
          why:
            relation === 'same'
              ? `engine_confirms_chords:${chords.why}`
              : firm
                ? `chords_name_the_root:${chords.why}`
                : `chords_lean_on_the_root:${chords.why}`,
        },
        trackIdentity,
      ),
      advisedBy: chords.sources,
    };
  }
  if (displaced && compareKeys({ key: held!.root!, mode: held!.scale! }, local) !== 'unrelated') {
    return null;
  }
  const earned =
    heard !== null ? heard >= chords.worth : !detected.ambiguous && clamp01(detected.confidence) >= chords.worth;
  if (earned) {
    return null;
  }
  const p = heard ?? clamp01(detected.confidence);
  const stillLikelier = (chords.worth * (1 - p)) / Math.max(1e-9, 1 - p * chords.worth);
  return advised(chords, stillLikelier, displayOf(local), trackIdentity, `chords_hold_against_engine:${chords.why}`);
}

/** The engine's reading on its own: what the neck shows when no chords are about this track. */
function fuseEngine(detected: DetectedCandidate, held: FusedKey | null, trackIdentity: string | null): FusedKey {
  const local = usableDetected(detected);
  if (local) {
    const engine = Math.round(Math.max(0, Math.min(1, detected.confidence || 0)) * 100);
    const noteSetP = evidenceOf(detected)?.confidence ?? null;
    // Checked before the engine's own `ambiguous` flag, and that placement is the whole point.
    //
    // A first version held only while the engine was hedging, on the reasoning that a confident
    // reading has earned the change. A live capture of "Dimyon Hofshi" (E minor) showed why that is
    // wrong: the neck held E minor for a full minute of hedged G major readings, the engine then
    // promoted G major to `likely_key` at 100% on four agreeing windows, and the wrong root walked
    // straight in. That confidence was the window vote consolidating — the one thing that provably
    // cannot separate two names for the same seven notes. So the hold asks how many readings named
    // the other key, never how confident the engine sounds about it.
    const hold = neckHold(held, local, detected, trackIdentity);
    if (hold?.relation === 'relative') {
      return fromCandidate(
        hold.key,
        {
          source: 'detected',
          certainty: 'tonic_open',
          confidencePct: CERTAINTY_PCT.tonicOpen,
          notesSettled: true,
          tonicSettled: false,
          relativeAlternative: displayOf(local),
          // What the neck's notes were worth when they were read: the reading that just arrived
          // agrees with them, but it has not replaced them.
          noteSetP: held?.noteSetP ?? null,
          why: 'relative_flip_resisted',
        },
        trackIdentity,
      );
    }
    if (hold && held) {
      // The card goes on naming what the neck shows. A card saying D major over a neck drawn in A
      // major would ask the player which one to believe, which is the decision this module exists
      // to take away from them.
      return { ...held, trackIdentity, why: 'weaker_reading_resisted' };
    }
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
            noteSetP,
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
          noteSetP,
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
        noteSetP,
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
 * Is this reading sure enough that the player has agreed to let it on the neck?
 *
 * The gate belongs to the player, not to the pipeline: `fuseKey` always commits to its best
 * answer and `confidencePct` gates nothing by itself. This is the one thing that holds that
 * answer back, and it holds it back exactly as far as the slider was set and no further.
 *
 * A gate of 0 — what ships — passes everything, so the neck still fills itself in unasked.
 */
export function clearsApplyGate(next: FusedKey, thresholdPct: number): boolean {
  const gate = Number.isFinite(thresholdPct) ? Math.max(0, Math.min(100, thresholdPct)) : 0;
  return next.confidencePct >= gate;
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
  const chordsDecided = weighedAgainstChords(current) || weighedAgainstChords(next);
  if (compareKeys({ key: current.root, mode: current.scale }, { key: next.root, mode: next.scale }) === 'same') {
    // Not a move — but a neck put up by a reading with no evidence behind it (the first cycle of a
    // backend switch, a consensus that settled on another key than the newest reading) has no
    // probability of its own, and `neckHold` cannot weigh anything against nothing. The first
    // calibrated reading of the same key hands it one. Otherwise the neck keeps the value it was
    // set with: refreshing it from every agreeing reading was measured and changed nothing.
    //
    // The one other thing worth refreshing is the record of which chords the engine displaced: it
    // is what stops the neck handing the key back to them on the engine's next weaker reading, and
    // a neck that the engine held before the chords arrived does not carry it yet.
    return (
      (next.source === 'detected' && current.source === 'detected'
        && isProbability(next.noteSetP) && !isProbability(current.noteSetP))
      || (chordsDecided && (next.overruledAdvice ?? null) !== (current.overruledAdvice ?? null))
    );
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
  // The chords and the engine have already been weighed against each other in `fuseKey`, by
  // probability, with the hysteresis of `overruledAdvice` on top. A margin on `confidencePct` here
  // would overrule that with a label: the engine displacing a chart at p = 0.80 reads as a `lone` 80,
  // which could never pass the chart's 79 plus the margin.
  if (chordsDecided) {
    return true;
  }
  // Both calibrated engine readings: `fuseKey` has already weighed this one against the neck in
  // `neckHold` — by probability for different notes, by repetition for the other root — and a
  // reading that reached here earned the move there. Comparing `confidencePct` as well would
  // overrule it with a label: a second reading of new notes at p = 0.6 is `hedged` (35) and could
  // never displace a `lone` 80, which is exactly the neck showing a key the analyzer has stopped
  // naming.
  if (
    current.source === 'detected' &&
    next.source === 'detected' &&
    isProbability(current.noteSetP) &&
    isProbability(next.noteSetP)
  ) {
    return true;
  }
  if (next.source === current.source && next.confidencePct >= current.confidencePct) {
    return true;
  }
  return next.confidencePct >= current.confidencePct + REVISION_MARGIN_PCT;
}

/** A key `fuseKey` put up after weighing the chords against the engine. */
function weighedAgainstChords(key: FusedKey): boolean {
  return key.source === 'advised' || key.source === 'confirmed' || (key.overruledAdvice ?? null) !== null;
}
