import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { pitchClassForNoteLabel } from '../scaleSpell';
import { fuseKey, shouldRevise, type FusedKey } from './keyFusion';

// Research only: alternative neck policies over the same engine dump, to price what the shipped
// revision policy costs and buys. Opt-in with GSV_NECK_POLICY=/path/to/dump.json.
const file = process.env.GSV_NECK_POLICY ?? '';
type Cycle = { span: number; primaryKey: string | null; primaryScale: string | null; displayName: string | null; confidence: number; ambiguous: boolean; alternatives: { key: string; scale: string }[] };
type Clip = { clipId: string; truthPc: number; truthMode: string; cycles: Cycle[] };
const setOf = (pc: number, mode: string) =>
  (mode === 'major' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10]).map((s) => (pc + s) % 12).sort((a, b) => a - b).join(',');
function right(root: string | null, scale: string | null, clip: Clip): { notes: boolean; exact: boolean } | null {
  if (!root || !scale) return null;
  const pc = pitchClassForNoteLabel(root);
  if (pc === null) return null;
  return { notes: setOf(pc, scale) === setOf(clip.truthPc, clip.truthMode), exact: pc === clip.truthPc && scale === clip.truthMode };
}
type Neck = { root: string; scale: string } | null;
type Policy = (clip: Clip) => Neck[];
const shipped: Policy = (clip) => {
  let neck: FusedKey | null = null;
  return clip.cycles.map((c) => {
    const fused = fuseKey({ verified: null, detected: c, held: neck, trackIdentity: clip.clipId });
    if (fused.root && fused.scale && shouldRevise(neck, fused)) neck = fused;
    return neck ? { root: neck.root!, scale: neck.scale! } : null;
  });
};
const latest: Policy = (clip) => {
  let neck: Neck = null;
  return clip.cycles.map((c) => {
    if (c.primaryKey && c.primaryScale) neck = { root: c.primaryKey, scale: c.primaryScale };
    return neck;
  });
};
/** Move to a new note set once it has been read twice running; roots follow the latest reading. */
const twice: Policy = (clip) => {
  let neck: Neck = null;
  let pending: string | null = null;
  return clip.cycles.map((c) => {
    if (!c.primaryKey || !c.primaryScale) return neck;
    const pc = pitchClassForNoteLabel(c.primaryKey)!;
    const set = setOf(pc, c.primaryScale);
    const neckSet = neck ? setOf(pitchClassForNoteLabel(neck.root)!, neck.scale) : null;
    if (!neck || set === neckSet) {
      neck = { root: c.primaryKey, scale: c.primaryScale };
      pending = null;
    } else if (pending === set) {
      neck = { root: c.primaryKey, scale: c.primaryScale };
      pending = null;
    } else {
      pending = set;
    }
    return neck;
  });
};
/** A new note set moves the neck at once when that reading is settled, else after two in a row. */
const hybrid = (rootRule: 'latest' | 'twice'): Policy => (clip) => {
  let neck: Neck = null;
  let pendingSet: string | null = null;
  let pendingRoot: string | null = null;
  return clip.cycles.map((c) => {
    if (!c.primaryKey || !c.primaryScale) return neck;
    const pc = pitchClassForNoteLabel(c.primaryKey)!;
    const set = setOf(pc, c.primaryScale);
    const neckSet = neck ? setOf(pitchClassForNoteLabel(neck.root)!, neck.scale) : null;
    const settled = !c.ambiguous;
    const candidate = { root: c.primaryKey, scale: c.primaryScale };
    if (!neck) { neck = candidate; return neck; }
    if (set !== neckSet) {
      if (settled || pendingSet === set) { neck = candidate; pendingSet = null; pendingRoot = null; }
      else pendingSet = set;
      return neck;
    }
    pendingSet = null;
    const rootKey = `${pc}:${c.primaryScale}`;
    const neckRoot = `${pitchClassForNoteLabel(neck.root)}:${neck.scale}`;
    if (rootKey === neckRoot) { pendingRoot = null; return neck; }
    if (rootRule === 'latest' || pendingRoot === rootKey) { neck = candidate; pendingRoot = null; }
    else pendingRoot = rootKey;
    return neck;
  });
};
/**
 * The note set moves when the new reading is at least as likely right as the one on the neck, or
 * has been read twice running; the root within a note set moves after two readings agree.
 */
const guarded = (setRule: 'latest' | 'pguard', slack: number): Policy => (clip) => {
  let neck: (Neck & { p: number }) | null = null;
  let pendingSet: string | null = null;
  let pendingRoot: string | null = null;
  return clip.cycles.map((c) => {
    if (!c.primaryKey || !c.primaryScale) return neck;
    const pc = pitchClassForNoteLabel(c.primaryKey)!;
    const set = setOf(pc, c.primaryScale);
    const candidate = { root: c.primaryKey, scale: c.primaryScale, p: c.confidence };
    if (!neck) { neck = candidate; return neck; }
    const neckPc = pitchClassForNoteLabel(neck.root)!;
    if (set !== setOf(neckPc, neck.scale)) {
      const move = setRule === 'latest' || c.confidence + slack >= neck.p || pendingSet === set;
      if (move) { neck = candidate; pendingSet = null; pendingRoot = null; }
      else pendingSet = set;
      return neck;
    }
    pendingSet = null;
    neck = { ...neck, p: c.confidence };
    const rootKey = `${pc}:${c.primaryScale}`;
    if (rootKey === `${neckPc}:${neck.scale}`) { pendingRoot = null; return neck; }
    if (pendingRoot === rootKey) { neck = candidate; pendingRoot = null; }
    else pendingRoot = rootKey;
    return neck;
  });
};
function score(name: string, clips: Clip[], policy: Policy) {
  const marks = [8, 12, 16, 20, 24, 32, 36];
  const tally = marks.map(() => ({ notes: 0, exact: 0 }));
  let flips = 0;
  let rootFlips = 0;
  let wrongSeconds = 0;
  const moves = { setFix: 0, setBreak: 0, setSideways: 0, rootFix: 0, rootBreak: 0 };
  for (const clip of clips) {
    const necks = policy(clip);
    const spans = clip.cycles.map((c) => c.span);
    marks.forEach((m, k) => {
      let idx = -1;
      spans.forEach((s, i) => { if (s <= m) idx = i; });
      const n = idx >= 0 ? necks[idx] : null;
      const r = n ? right(n.root, n.scale, clip) : null;
      if (r?.notes) tally[k]!.notes++;
      if (r?.exact) tally[k]!.exact++;
    });
    let prev: string | null = null;
    let prevRoot: string | null = null;
    necks.forEach((n, i) => {
      if (!n) return;
      const set = setOf(pitchClassForNoteLabel(n.root)!, n.scale);
      const root = `${pitchClassForNoteLabel(n.root)}:${n.scale}`;
      const was = i > 0 && necks[i - 1] ? right(necks[i - 1]!.root, necks[i - 1]!.scale, clip) : null;
      const now = right(n.root, n.scale, clip);
      if (prev !== null && set !== prev) {
        flips++;
        if (now?.notes) moves.setFix++;
        else if (was?.notes) moves.setBreak++;
        else moves.setSideways++;
      } else if (prevRoot !== null && root !== prevRoot) {
        rootFlips++;
        if (now?.exact) moves.rootFix++;
        else if (was?.exact) moves.rootBreak++;
      }
      prev = set;
      prevRoot = root;
      const until = i + 1 < spans.length ? Math.min(spans[i + 1]!, 40) : 40;
      if (spans[i]! < 40 && !right(n.root, n.scale, clip)?.notes) wrongSeconds += until - spans[i]!;
    });
  }
  const N = clips.length;
  console.log(
    `${name.padEnd(10)} ` + marks.map((m, k) => `${m}s ${((100 * tally[k]!.notes) / N).toFixed(1)}/${((100 * tally[k]!.exact) / N).toFixed(1)}`).join('  ') +
      `  | set changes ${(flips / N).toFixed(2)} (fix ${moves.setFix} break ${moves.setBreak} side ${moves.setSideways})` +
      ` root flips ${(rootFlips / N).toFixed(2)} (fix ${moves.rootFix} break ${moves.rootBreak})  wrong ${(wrongSeconds / N).toFixed(1)}s`,
  );
}
describe.skipIf(!file || !existsSync(file))('neck policies', () => {
  it('prices each policy', () => {
    const clips = JSON.parse(readFileSync(file, 'utf8')) as Clip[];
    score('shipped', clips, shipped);
    score('latest', clips, latest);
    score('twice', clips, twice);
    score('hyb/latest', clips, hybrid('latest'));
    score('hyb/twice', clips, hybrid('twice'));
    score('lat/root2', clips, guarded('latest', 0));
    score('pg0/root2', clips, guarded('pguard', 0));
    score('pg.05/rt2', clips, guarded('pguard', 0.05));
    score('pg.1/root2', clips, guarded('pguard', 0.1));
  });
});
