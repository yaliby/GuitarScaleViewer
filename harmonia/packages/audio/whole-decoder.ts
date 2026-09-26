// @ts-nocheck
export interface WholeSequenceResult {
  states: Uint16Array;
  score: number;
  workingBytes: number;
}

export function decodeWholeSequence(
  frames: number,
  states: number,
  emissions: (frame: number, output: Float64Array) => void,
  changePenalty = 0.12,
  progress?: (fraction: number) => void,
): WholeSequenceResult {
  if (
    !Number.isInteger(frames) ||
    frames < 1 ||
    frames > 60000 ||
    !Number.isInteger(states) ||
    states < 1 ||
    states > 512
  )
    throw new Error('Whole-sequence frame/state bounds exceed the analysis limit');
  if (!Number.isFinite(changePenalty) || changePenalty < 0 || changePenalty > 100)
    throw new Error('Invalid whole-sequence change penalty');
  const workingBytes = frames * states * 2 + frames * 2 + states * 8 * 3;
  if (workingBytes > 64 * 1024 * 1024)
    throw new Error('Whole-sequence traceback exceeds the 64 MB memory limit');
  const back = new Uint16Array(frames * states);
  const path = new Uint16Array(frames);
  let previous = new Float64Array(states);
  let current = new Float64Array(states);
  const row = new Float64Array(states);
  let best = 0;
  for (let t = 0; t < frames; t++) {
    row.fill(NaN);
    emissions(t, row);
    // A uniform change cost permits the exact global predecessor maximum in O(K).
    // If its state equals the target, staying is always at least as good.
    let nextBest = 0;
    for (let state = 0; state < states; state++) {
      const emission = row[state];
      if (emission !== -Infinity && (!Number.isFinite(emission) || emission < 0 || emission > 1))
        throw new Error('Invalid or incomplete whole-sequence emission');
      const stay = previous[state];
      const change = previous[best] - changePenalty;
      const predecessor = t === 0 || stay >= change ? state : best;
      current[state] =
        (t === 0 ? 0 : previous[predecessor] - (predecessor === state ? 0 : changePenalty)) +
        emission;
      back[t * states + state] = predecessor;
      if (current[state] > current[nextBest]) nextBest = state;
    }
    if (!Number.isFinite(current[nextBest]))
      throw new Error('No valid whole-sequence emission path');
    [previous, current] = [current, previous];
    best = nextBest;
    if (t % 128 === 0) progress?.(t / frames);
  }
  const score = previous[best];
  for (let t = frames - 1; t >= 0; t--) {
    path[t] = best;
    best = back[t * states + best];
  }
  progress?.(1);
  return { states: path, score, workingBytes };
}
