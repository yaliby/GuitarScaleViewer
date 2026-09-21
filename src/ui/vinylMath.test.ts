import { describe, expect, it } from 'vitest';
import {
  clampPositionMs,
  deltaRadToDeg,
  pointerAngle,
  seekDeltaMs,
  shortestAngleDelta,
  spinAdvanceDeg,
  VINYL_MS_PER_REVOLUTION,
  VINYL_SPIN_MS_PER_TURN,
  platterRotationDeg,
} from './vinylMath';

describe('vinylMath', () => {
  it('treats a clockwise quarter-turn as a forward seek', () => {
    const from = pointerAngle(200, 100, 100, 100);
    const to = pointerAngle(100, 200, 100, 100);
    const delta = shortestAngleDelta(from, to);
    expect(delta).toBeCloseTo(Math.PI / 2, 6);
    expect(seekDeltaMs(delta)).toBeCloseTo(VINYL_MS_PER_REVOLUTION / 4, 6);
  });

  it('treats a counterclockwise quarter-turn as a rewind', () => {
    const from = pointerAngle(200, 100, 100, 100);
    const to = pointerAngle(100, 0, 100, 100);
    expect(seekDeltaMs(shortestAngleDelta(from, to))).toBeCloseTo(-VINYL_MS_PER_REVOLUTION / 4, 6);
  });

  it('wraps across the ±π seam instead of jumping a full turn', () => {
    const delta = shortestAngleDelta(Math.PI - 0.1, -Math.PI + 0.1);
    expect(delta).toBeCloseTo(0.2, 6);
  });

  it('clamps a cue to the length of the track', () => {
    expect(clampPositionMs(-400, 180_000)).toBe(0);
    expect(clampPositionMs(200_000, 180_000)).toBe(180_000);
    expect(clampPositionMs(12_000, null)).toBe(12_000);
  });

  it('turns a quarter-turn of the platter into 90 degrees', () => {
    expect(deltaRadToDeg(Math.PI / 2)).toBeCloseTo(90, 6);
  });

  it('advances a full visual turn over the spin period', () => {
    expect(spinAdvanceDeg(VINYL_SPIN_MS_PER_TURN)).toBeCloseTo(360, 6);
    expect(spinAdvanceDeg(VINYL_SPIN_MS_PER_TURN / 4)).toBeCloseTo(90, 6);
  });

  it('reads a platter rotate() transform', () => {
    expect(platterRotationDeg('rotate(90deg)')).toBeCloseTo(90, 6);
    expect(platterRotationDeg('none')).toBeNull();
  });
});
