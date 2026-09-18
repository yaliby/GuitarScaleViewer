import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useLiveJam } from "./useLiveJam";
import type { DetectedKeyState } from "./useDetectedKey";

const detected: DetectedKeyState = {
  primaryKey: "D",
  primaryScale: "major",
  displayName: "D major",
  confidence: 0.93,
  stability: 0.92,
  alternatives: [],
  source: "audio_analysis:numpy_fallback",
  captureMode: "process_loopback",
  targetApp: "Player",
  enoughAudio: true,
  bufferSeconds: 60,
  windowCount: 10,
  ambiguous: false,
  reason: "stable_numpy_estimate",
  state: "likely_key",
  readyToApply: false,
  evidenceId: 1,
  trackIdentity: "song-one",
};
const initial: Parameters<typeof useLiveJam>[0] = {
  detected,
  cloudHit: null,
  trackIdentity: "song-one",
  playing: true,
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("offers uncertain detected keys for explicit selection without auto-applying them", () => {
  const { result } = renderHook(() =>
    useLiveJam({
      ...initial,
      detected: {
        ...detected,
        ambiguous: true,
        state: "ambiguous",
        reason: "competing_keys",
        alternatives: [
          { key: "B", scale: "minor", displayName: "B minor", confidence: 0.4 },
        ],
      },
    }),
  );
  expect(result.current.key).toBeNull();
  expect(result.current.suggestions).toEqual([
    { root: "D", scaleType: "major" },
    { root: "B", scaleType: "minor" },
  ]);
  act(() => result.current.chooseKey("B", "minor"));
  expect(result.current.key).toMatchObject({ root: "B", scaleType: "minor" });
  expect(result.current.following).toBe(false);
});

it("does not offer stale suggestions from the previous track", () => {
  const { result, rerender } = renderHook((p) => useLiveJam(p), {
    initialProps: initial,
  });
  rerender({ ...initial, trackIdentity: "different-track" });
  expect(result.current.suggestions).toEqual([]);
});

it("keeps a manually chosen key when the next song starts with following off", () => {
  const { result, rerender } = renderHook((p) => useLiveJam(p), {
    initialProps: initial,
  });
  act(() => result.current.chooseKey("G", "minor"));
  rerender({ ...initial, trackIdentity: "next-song" });
  expect(result.current.key).toMatchObject({
    root: "G",
    scaleType: "minor",
    source: "manual",
  });
  expect(result.current.following).toBe(false);
});

it.each([
  ["D", "major"], ["Bb", "minor"], ["F#", "major"], ["Ab", "minor"],
] as const)("follows fresh sustained %s %s evidence and records its source", (root, mode) => {
  vi.useFakeTimers();
  const start = { ...initial, detected: { ...detected, primaryKey: root, primaryScale: mode } };
  const { result, rerender } = renderHook((p) => useLiveJam(p), { initialProps: start });
  expect(result.current.key).toBeNull();
  act(() => vi.advanceTimersByTime(4000));
  rerender({ ...start, detected: { ...start.detected, evidenceId: 2 } });
  act(() => vi.advanceTimersByTime(4000));
  expect(result.current.key).toBeNull();
  rerender({ ...start, detected: { ...start.detected, evidenceId: 3 } });
  expect(result.current.key).toMatchObject({
    root,
    scaleType: mode,
    source: "estimate",
  });
  expect(result.current.history).toHaveLength(1);
});

it("cancels pending guesses when ambiguous, paused, or locked", () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook((p) => useLiveJam(p), {
    initialProps: initial,
  });
  act(() => vi.advanceTimersByTime(3000));
  rerender({ ...initial, detected: { ...detected, ambiguous: true } });
  act(() => vi.advanceTimersByTime(10000));
  expect(result.current.key).toBeNull();
  rerender({ ...initial, playing: false });
  act(() => vi.advanceTimersByTime(10000));
  expect(result.current.key).toBeNull();
  rerender(initial);
  act(() => result.current.setLocked(true));
  act(() => vi.advanceTimersByTime(10000));
  expect(result.current.key).toBeNull();
});

it("holds the current key through pauses and lock, without accepting changed guesses", () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook((p) => useLiveJam(p), {
    initialProps: { ...initial, cloudHit: { key: "D", mode: "major" as const, displayName: "D major" } },
  });
  act(() => result.current.setLocked(true));
  rerender({ ...initial, cloudHit: { key: "D", mode: "major", displayName: "D major" }, detected: { ...detected, primaryKey: "G", evidenceId: 2 } });
  act(() => vi.advanceTimersByTime(20000));
  expect(result.current.key?.root).toBe("D");
  act(() => result.current.setLocked(false));
  rerender({ ...initial, cloudHit: { key: "D", mode: "major", displayName: "D major" }, playing: false });
  act(() => vi.advanceTimersByTime(10000));
  expect(result.current.key?.root).toBe("D");
});

it("clears the old song and waits for a fresh native result on track changes", () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook((p) => useLiveJam(p), {
    initialProps: initial,
  });
  act(() => vi.advanceTimersByTime(6000));
  rerender({ ...initial, trackIdentity: "song-two" });
  act(() => vi.advanceTimersByTime(10000));
  expect(result.current.key).toBeNull();
  expect(result.current.history).toHaveLength(0);
  rerender({
    ...initial,
    trackIdentity: "song-two",
    detected: { ...detected, primaryKey: "G", trackIdentity: "song-two", evidenceId: 2 },
  });
  act(() => vi.advanceTimersByTime(4000));
  rerender({ ...initial, trackIdentity: "song-two", detected: { ...detected, primaryKey: "G", trackIdentity: "song-two", evidenceId: 3 } });
  act(() => vi.advanceTimersByTime(4000));
  rerender({ ...initial, trackIdentity: "song-two", detected: { ...detected, primaryKey: "G", trackIdentity: "song-two", evidenceId: 4 } });
  expect(result.current.key?.root).toBe("G");
});

it("never turns duplicate evidence or a legacy repeated snapshot into an accepted key", () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook((p) => useLiveJam(p), { initialProps: initial });
  for (let i = 0; i < 5; i++) {
    act(() => vi.advanceTimersByTime(4000));
    rerender({ ...initial, detected: { ...detected } });
  }
  expect(result.current.key).toBeNull();
  cleanup();
  const legacy = { ...initial, detected: { ...detected, evidenceId: undefined, trackIdentity: undefined } };
  const older = renderHook((p) => useLiveJam(p), { initialProps: legacy });
  for (let i = 0; i < 5; i++) {
    act(() => vi.advanceTimersByTime(4000));
    older.rerender({ ...legacy, detected: { ...legacy.detected } });
  }
  expect(older.result.current.key).toBeNull();
});

it.each([
  ["C", "major", "D", "major"],
  ["F#", "minor", "A", "major"],
  ["Bb", "major", "Eb", "minor"],
] as const)("seeds %s %s once then follows sustained %s %s without library bounceback", (from, fromMode, to, toMode) => {
  vi.useFakeTimers();
  const start: Parameters<typeof useLiveJam>[0] = { ...initial, cloudHit: { key: from, mode: fromMode, displayName: `${from} ${fromMode}` }, detected: { ...detected, primaryKey: from, primaryScale: fromMode } };
  const { result, rerender } = renderHook((p) => useLiveJam(p), { initialProps: start });
  expect(result.current.key).toMatchObject({ root: from, source: "library" });
  for (let evidenceId = 2; evidenceId <= 4; evidenceId++) {
    act(() => vi.advanceTimersByTime(4000));
    rerender({ ...start, detected: { ...detected, primaryKey: to, primaryScale: toMode, evidenceId } });
    if (evidenceId < 4) expect(result.current.key?.root).toBe(from);
  }
  expect(result.current.key).toMatchObject({ root: to, scaleType: toMode, source: "estimate" });
  rerender({ ...start, cloudHit: { ...start.cloudHit! }, detected: { ...detected, primaryKey: to, primaryScale: toMode, evidenceId: 5 } });
  expect(result.current.key?.root).toBe(to);
  expect(result.current.history.map((k) => k.root)).toEqual([from, to]);
});

it.each(["pause", "hold", "follow off"] as const)("cancels a candidate on %s and requires fresh evidence after resuming", (control) => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook((p) => useLiveJam(p), { initialProps: initial });
  act(() => vi.advanceTimersByTime(4000));
  rerender({ ...initial, detected: { ...detected, evidenceId: 2 } });
  if (control === "pause") rerender({ ...initial, playing: false, detected: { ...detected, evidenceId: 2 } });
  if (control === "hold") act(() => result.current.setLocked(true));
  if (control === "follow off") act(() => result.current.setFollowing(false));
  act(() => vi.advanceTimersByTime(20000));
  if (control === "hold") act(() => result.current.setLocked(false));
  if (control === "follow off") act(() => result.current.setFollowing(true));
  rerender({ ...initial, detected: { ...detected, evidenceId: 2 } });
  act(() => vi.advanceTimersByTime(20000));
  expect(result.current.key).toBeNull();
  for (let evidenceId = 3; evidenceId <= 5; evidenceId++) {
    act(() => vi.advanceTimersByTime(4000));
    rerender({ ...initial, detected: { ...detected, evidenceId } });
    if (evidenceId < 5) expect(result.current.key).toBeNull();
  }
  expect(result.current.key?.root).toBe("D");
});

it("rejects late previous-track payloads even when their revision and object change", () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook((p) => useLiveJam(p), { initialProps: initial });
  for (let evidenceId = 2; evidenceId <= 5; evidenceId++) {
    act(() => vi.advanceTimersByTime(4000));
    rerender({ ...initial, trackIdentity: "song-two", detected: { ...detected, evidenceId } });
  }
  expect(result.current.key).toBeNull();
  expect(result.current.suggestions).toEqual([]);
});

it("requires a sustained duration as well as three fresh revisions", () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook((p) => useLiveJam(p), { initialProps: initial });
  for (const evidenceId of [2, 3]) {
    act(() => vi.advanceTimersByTime(1000));
    rerender({ ...initial, detected: { ...detected, evidenceId } });
  }
  act(() => vi.advanceTimersByTime(10000));
  rerender({ ...initial, detected: { ...detected, evidenceId: 3 } });
  expect(result.current.key).toBeNull();
  rerender({ ...initial, detected: { ...detected, evidenceId: 4 } });
  expect(result.current.key?.root).toBe("D");
});

it("restarts the candidate after a competing fresh key instead of combining separated guesses", () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook((p) => useLiveJam(p), { initialProps: initial });
  for (const [evidenceId, primaryKey] of [[2, "G"], [3, "D"], [4, "D"], [5, "D"]] as const) {
    act(() => vi.advanceTimersByTime(4000));
    rerender({ ...initial, detected: { ...detected, primaryKey, evidenceId } });
    if (evidenceId < 5) expect(result.current.key).toBeNull();
  }
  expect(result.current.key?.root).toBe("D");
});

it("keeps manual selection through fresh sustained native changes", () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook((p) => useLiveJam(p), { initialProps: initial });
  act(() => result.current.chooseKey("Ab", "minor"));
  for (const evidenceId of [2, 3, 4]) {
    act(() => vi.advanceTimersByTime(4000));
    rerender({ ...initial, detected: { ...detected, evidenceId } });
  }
  expect(result.current.key).toMatchObject({ root: "Ab", scaleType: "minor", source: "manual" });
  expect(result.current.pendingKey).toBeNull();
});

it("applies a verified library key immediately and rejects unqualified fallback guesses", () => {
  const { result } = renderHook(() =>
    useLiveJam({
      ...initial,
      cloudHit: { key: "Bb", mode: "major", displayName: "Bb major" },
    }),
  );
  expect(result.current.key).toMatchObject({ root: "Bb", source: "library" });
  cleanup();
  vi.useFakeTimers();
  const rejected = renderHook(() =>
    useLiveJam({
      ...initial,
      detected: { ...detected, reason: "recent_silence" },
    }),
  );
  act(() => vi.advanceTimersByTime(30000));
  expect(rejected.result.current.key).toBeNull();
});
