import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pitchClassForNoteLabel } from '../scaleSpell';
import { clearsApplyGate, fuseKey, shouldRevise, type DetectedCandidate, type FusedKey } from './keyFusion';

/**
 * What is on the neck, second by second, for every clip in the real corpus.
 *
 * `src-tauri/tests/key_latency_replay.rs` replays each clip through the engine loop from cached
 * analyzer output and dumps every payload the frontend would have received. This runs those
 * payloads through the shipped `fuseKey` / `clearsApplyGate` / `shouldRevise` — the three calls
 * `App.tsx` and `GuitarScaleView.tsx` make on every payload — and scores the neck the player
 * actually plays over, not the engine's verdict and not a flag nothing on screen reads.
 *
 * It is a research instrument, skipped unless the dumps exist:
 *
 *     cargo test --test key_latency_replay -- --ignored --nocapture   (in src-tauri/)
 *     GSV_NECK_REPLAY=1 npx vitest run src/services/neckReplay.research.test.ts
 */

type Cycle = DetectedCandidate & {
  span: number;
  state: string;
  reason: string | null;
  readyToApply: boolean;
};

type ClipDump = {
  clipId: string;
  capture: string;
  song: string;
  truthPc: number;
  truthMode: 'major' | 'minor';
  musicSeconds: number;
  cycles: Cycle[];
};

const DUMP_DIR = process.env.GSV_NECK_DUMP_DIR ?? '/tmp/gsv-neck-replay';
/** Every clip holds at least ~38s of music; scoring to a common horizon keeps clips comparable. */
const HORIZON_S = 40;
const MARKS = [4, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40];

function noteSet(pc: number, mode: string): string {
  const steps = mode === 'major' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
  return steps
    .map((s) => (pc + s) % 12)
    .sort((a, b) => a - b)
    .join(',');
}

type Judged = { notes: boolean; exact: boolean } | null;

function judge(key: { root: string | null; scale: string | null } | null, clip: ClipDump): Judged {
  if (!key || !key.root || !key.scale) return null;
  const pc = pitchClassForNoteLabel(key.root);
  if (pc === null) return null;
  return {
    notes: noteSet(pc, key.scale) === noteSet(clip.truthPc, clip.truthMode),
    exact: pc === clip.truthPc && key.scale === clip.truthMode,
  };
}

type Step = { t: number; neck: FusedKey | null; fused: FusedKey };

/** The frontend's per-payload decision, exactly as `App.tsx` makes it with the gate at 0. */
function replayNeck(clip: ClipDump): Step[] {
  let neck: FusedKey | null = null;
  const steps: Step[] = [];
  for (const cycle of clip.cycles) {
    const fused = fuseKey({ verified: null, detected: cycle, held: neck, trackIdentity: clip.clipId });
    if (fused.root && fused.scale && clearsApplyGate(fused, 0) && shouldRevise(neck, fused)) {
      neck = fused;
    }
    steps.push({ t: cycle.span, neck, fused });
  }
  return steps;
}

/** The neck at time `t`: the last step at or before it. */
function neckAt(steps: Step[], t: number): Step | null {
  let found: Step | null = null;
  for (const step of steps) {
    if (step.t <= t) found = step;
    else break;
  }
  return found;
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${((100 * n) / d).toFixed(1)}%`;
}

type Summary = {
  label: string;
  clips: number;
  curve: Record<number, { notes: number; exact: number; wrong: number; blank: number }>;
  firstRightNotes: number[];
  settledRightNotes: number[];
  settledRightExact: number[];
  wrongSeconds: number;
  confidentRightNotes: number;
  confidentWrongNotes: number;
  confidentTimes: number[];
  cardDisagrees: number;
  cardCycles: number;
};

function summarise(label: string, clips: ClipDump[]): Summary {
  const summary: Summary = {
    label,
    clips: clips.length,
    curve: Object.fromEntries(MARKS.map((m) => [m, { notes: 0, exact: 0, wrong: 0, blank: 0 }])),
    firstRightNotes: [],
    settledRightNotes: [],
    settledRightExact: [],
    wrongSeconds: 0,
    confidentRightNotes: 0,
    confidentWrongNotes: 0,
    confidentTimes: [],
    cardDisagrees: 0,
    cardCycles: 0,
  };
  for (const clip of clips) {
    const steps = replayNeck(clip).filter((s) => s.t <= HORIZON_S);
    for (const mark of MARKS) {
      const j = judge(neckAt(steps, mark)?.neck ?? null, clip);
      const row = summary.curve[mark]!;
      if (!j) row.blank += 1;
      else {
        row.notes += Number(j.notes);
        row.exact += Number(j.exact);
        row.wrong += Number(!j.notes);
      }
    }
    // First moment the neck is right, and the moment from which it stays right to the horizon.
    let first: number | null = null;
    let settledNotes: number | null = null;
    let settledExact: number | null = null;
    for (const step of steps) {
      const j = judge(step.neck, clip);
      if (j?.notes && first === null) first = step.t;
      if (j?.notes) settledNotes ??= step.t;
      else settledNotes = null;
      if (j?.exact) settledExact ??= step.t;
      else settledExact = null;
    }
    summary.firstRightNotes.push(first ?? Infinity);
    summary.settledRightNotes.push(settledNotes ?? Infinity);
    summary.settledRightExact.push(settledExact ?? Infinity);
    // Seconds of wrong notes on the neck, up to the horizon.
    steps.forEach((step, i) => {
      const until = i + 1 < steps.length ? steps[i + 1]!.t : HORIZON_S;
      const j = judge(step.neck, clip);
      if (j && !j.notes) summary.wrongSeconds += Math.max(0, until - step.t);
    });
    // The first time the card says the reading is sure of itself ('lone' is the one certainty an
    // engine reading only reaches once the live gate stops hedging).
    const confident = steps.find((s) => s.fused.certainty === 'lone');
    if (confident) {
      const j = judge(confident.fused, clip);
      summary.confidentTimes.push(confident.t);
      if (j?.notes) summary.confidentRightNotes += 1;
      else summary.confidentWrongNotes += 1;
    }
    for (const step of steps) {
      if (!step.neck || !step.fused.root) continue;
      summary.cardCycles += 1;
      const same =
        pitchClassForNoteLabel(step.neck.root!) === pitchClassForNoteLabel(step.fused.root) &&
        step.neck.scale === step.fused.scale;
      summary.cardDisagrees += Number(!same);
    }
  }
  return summary;
}

function within(values: number[], limit: number): number {
  return values.filter((v) => v <= limit).length;
}

function print(summary: Summary): void {
  const n = summary.clips;
  const lines: string[] = [];
  lines.push(`\n=== ${summary.label}: ${n} clips ===`);
  lines.push('  on the neck at   right notes   right key   wrong notes   blank');
  for (const mark of MARKS) {
    const row = summary.curve[mark]!;
    lines.push(
      `  ${String(mark).padStart(5)}s        ${pct(row.notes, n).padStart(8)}    ${pct(row.exact, n).padStart(8)}    ${pct(
        row.wrong,
        n,
      ).padStart(8)}   ${pct(row.blank, n).padStart(6)}`,
    );
  }
  const med = (v: number[]) => {
    const m = median(v);
    return Number.isFinite(m) ? `${m}s` : 'never';
  };
  lines.push(
    `  first right notes: median ${med(summary.firstRightNotes)}; by 16s ${pct(within(summary.firstRightNotes, 16), n)}, by 24s ${pct(
      within(summary.firstRightNotes, 24),
      n,
    )}, never ${pct(summary.firstRightNotes.filter((v) => !Number.isFinite(v)).length, n)}`,
  );
  lines.push(
    `  right notes from then on: median ${med(summary.settledRightNotes)}; by 16s ${pct(
      within(summary.settledRightNotes, 16),
      n,
    )}, by 24s ${pct(within(summary.settledRightNotes, 24), n)}, by 32s ${pct(within(summary.settledRightNotes, 32), n)}, never ${pct(
      summary.settledRightNotes.filter((v) => !Number.isFinite(v)).length,
      n,
    )}`,
  );
  lines.push(
    `  right key from then on:   median ${med(summary.settledRightExact)}; by 24s ${pct(
      within(summary.settledRightExact, 24),
      n,
    )}, never ${pct(summary.settledRightExact.filter((v) => !Number.isFinite(v)).length, n)}`,
  );
  lines.push(`  wrong notes on the neck: ${(summary.wrongSeconds / n).toFixed(1)}s per clip (of ${HORIZON_S}s)`);
  const confident = summary.confidentRightNotes + summary.confidentWrongNotes;
  lines.push(
    `  card turns confident: ${pct(confident, n)} of clips, median ${med(summary.confidentTimes)}; right notes ${pct(
      summary.confidentRightNotes,
      n,
    )}, wrong notes ${pct(summary.confidentWrongNotes, n)} (precision ${pct(summary.confidentRightNotes, confident)})`,
  );
  lines.push(`  card names a different key than the neck on ${pct(summary.cardDisagrees, summary.cardCycles)} of cycles`);
  console.log(lines.join('\n'));
}

/**
 * One clip's neck, cycle by cycle, for the clips whose id contains `GSV_NECK_TRACE`.
 *
 * The summary says how often the neck is right; a player's complaint is about one song, and what
 * it needs is the sequence — which reading arrived, what the neck did with it, and why.
 */
function trace(clips: ClipDump[], needle: string): void {
  for (const clip of clips.filter((c) => c.clipId.includes(needle))) {
    const lines = [`\n--- ${clip.clipId} (${clip.song}) ---`];
    for (const step of replayNeck(clip)) {
      const cycle = clip.cycles.find((c) => c.span === step.t)!;
      const reading = cycle.primaryKey ? `${cycle.primaryKey} ${cycle.primaryScale}` : '—';
      const p = cycle.noteSetEvidence?.confidence;
      const neck = step.neck ? `${step.neck.root} ${step.neck.scale}` : '—';
      const verdict = judge(step.neck, clip);
      const mark = verdict === null ? ' ' : verdict.exact ? '✓' : verdict.notes ? '~' : '✗';
      lines.push(
        `  ${String(step.t).padStart(3)}s  reading ${reading.padEnd(10)} p=${p === undefined ? '  — ' : p.toFixed(2)}  neck ${neck.padEnd(10)} ${mark}  ${step.fused.certainty}  ${step.fused.why ?? ''}`,
      );
    }
    console.log(lines.join('\n'));
  }
}

// Opt-in, because the dumps outlive the run that made them: a stale directory in /tmp would
// otherwise turn every `npm test` on this machine into a research run.
const enabled = process.env.GSV_NECK_REPLAY === '1';
const traceNeedle = process.env.GSV_NECK_TRACE;
const dumps =
  enabled && existsSync(DUMP_DIR) ? readdirSync(DUMP_DIR).filter((f) => f.endsWith('.json')).sort() : [];

describe.skipIf(dumps.length === 0)('what the neck shows, replayed from the engine dump', () => {
  it('scores every dumped configuration', () => {
    for (const file of dumps) {
      const clips = JSON.parse(readFileSync(join(DUMP_DIR, file), 'utf8')) as ClipDump[];
      expect(clips.length).toBeGreaterThan(0);
      print(summarise(file.replace(/\.json$/, ''), clips));
      if (traceNeedle) trace(clips, traceNeedle);
    }
  });
});
