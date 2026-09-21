/** One full clockwise turn of the record advances the track by this much. */
export const VINYL_MS_PER_REVOLUTION = 30_000;

/** Visual platter period while the OS player is running. */
export const VINYL_SPIN_MS_PER_TURN = 18_000;

/** Below this travel, a platter press is a play/pause click rather than a cue. */
export const VINYL_CLICK_MAX_RAD = 0.2;

export function pointerAngle(clientX: number, clientY: number, centerX: number, centerY: number): number {
  return Math.atan2(clientY - centerY, clientX - centerX);
}

/** Shortest signed delta from `fromRad` to `toRad`, in (−π, π]. Screen-clockwise is positive. */
export function shortestAngleDelta(fromRad: number, toRad: number): number {
  let delta = toRad - fromRad;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta <= -Math.PI) delta += Math.PI * 2;
  return delta;
}

export function seekDeltaMs(deltaRad: number, msPerRevolution = VINYL_MS_PER_REVOLUTION): number {
  return (deltaRad / (Math.PI * 2)) * msPerRevolution;
}

export function deltaRadToDeg(deltaRad: number): number {
  return (deltaRad * 180) / Math.PI;
}

export function spinAdvanceDeg(elapsedMs: number, msPerTurn = VINYL_SPIN_MS_PER_TURN): number {
  if (!Number.isFinite(elapsedMs) || !Number.isFinite(msPerTurn) || msPerTurn <= 0) {
    return 0;
  }
  return (elapsedMs / msPerTurn) * 360;
}

export function platterRotationDeg(transform: string): number | null {
  const match = /^rotate\(([-\d.]+)deg\)$/.exec(transform.trim());
  if (!match) {
    return null;
  }
  const deg = Number(match[1]);
  return Number.isFinite(deg) ? deg : null;
}

export function clampPositionMs(positionMs: number, durationMs: number | null): number {
  if (!Number.isFinite(positionMs)) {
    return 0;
  }
  const pos = Math.max(0, positionMs);
  if (durationMs == null || !Number.isFinite(durationMs) || !(durationMs > 0)) {
    return pos;
  }
  return Math.min(durationMs, pos);
}
