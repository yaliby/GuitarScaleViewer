// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { decodeWholeSequence } from './whole-decoder';

function decode(rows: number[][], penalty = 0.12) {
  return decodeWholeSequence(
    rows.length,
    rows[0].length,
    (frame, output) => {
      output.set(rows[frame]);
    },
    penalty,
  );
}

describe('complete sequence traceback', () => {
  it('revises an ambiguous opening from evidence eight seconds later', () => {
    // 400 frames at the production hop exceed nine seconds. The weak C opening
    // wins alone, but retaining it costs more than its evidence when G follows.
    const prefix = Array.from({ length: 400 }, () => [0.5, 0.5]);
    prefix[0] = [0.51, 0.5];
    expect(decode(prefix).states[0]).toBe(0);
    const complete = [...prefix, ...Array.from({ length: 80 }, () => [0.1, 0.9])];
    const result = decode(complete);
    expect(result.states[0]).toBe(1);
    expect(result.states.every((state) => state === 1)).toBe(true);
  });

  it('reduces to independent decisions when changing states is free', () => {
    expect([
      ...decode(
        [
          [0.7, 0.2],
          [0.1, 0.8],
          [0.9, 0.1],
        ],
        0,
      ).states,
    ]).toEqual([0, 1, 0]);
  });

  it('preserves a strongly supported one-frame transition', () => {
    expect([
      ...decode([
        [1, 0],
        [0, 1],
        [1, 0],
      ]).states,
    ]).toEqual([0, 1, 0]);
  });

  it('cannot smooth across an impossible silence emission', () => {
    expect([
      ...decode([
        [1, -Infinity],
        [-Infinity, 1],
        [1, -Infinity],
      ]).states,
    ]).toEqual([0, 1, 0]);
  });

  it('returns a globally optimal score and deterministic ties', () => {
    const result = decode(
      [
        [0.8, 0.2],
        [0.45, 0.5],
        [0.8, 0.2],
      ],
      0.2,
    );
    expect([...result.states]).toEqual([0, 0, 0]);
    expect(result.score).toBeCloseTo(2.05);
    expect([
      ...decode([
        [0.5, 0.5],
        [0.5, 0.5],
      ]).states,
    ]).toEqual([0, 0]);
  });

  it('handles long input with bounded typed traceback rather than quadratic transitions', () => {
    const result = decodeWholeSequence(12000, 325, (frame, output) => {
      output.fill(0);
      output[frame < 6000 ? 1 : 2] = 1;
    });
    expect(result.states[0]).toBe(1);
    expect(result.states.at(-1)).toBe(2);
    expect(result.workingBytes).toBeLessThan(8 * 1024 * 1024);
  });

  it('rejects oversized allocations before asking for observations', () => {
    let accessed = false;
    expect(() =>
      decodeWholeSequence(60001, 325, () => {
        accessed = true;
      }),
    ).toThrow(/limit|bound/i);
    expect(accessed).toBe(false);
    expect(() => decodeWholeSequence(100, 4096, () => {})).toThrow(/limit|bound/i);
  });

  it('rejects invalid, incomplete and wholly impossible observation rows', () => {
    expect(() => decode([[NaN, 0]])).toThrow(/emission/i);
    expect(() => decode([[Infinity, 0]])).toThrow(/emission/i);
    expect(() => decode([[-Infinity, -Infinity]])).toThrow(/path|emission/i);
    expect(() =>
      decodeWholeSequence(2, 2, (_frame, output) => {
        output[0] = 1;
      }),
    ).toThrow(/emission/i);
    expect(() => decode([[1, 0]], -1)).toThrow(/penalty/i);
  });
});
