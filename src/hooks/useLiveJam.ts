import { useEffect, useRef, useState } from "react";
import type { DetectedKeyState } from "./useDetectedKey";
import { tryNormalizeRoot } from "../scaleDataProvider";
import { canAutoApply } from "../practice/session";

export type JamKey = {
  root: string;
  scaleType: "major" | "minor";
  source: "library" | "estimate" | "manual";
};
type Input = {
  detected: DetectedKeyState;
  cloudHit: {
    key: string;
    mode: "major" | "minor";
    displayName: string;
  } | null;
  trackIdentity: string | null;
  playing: boolean;
};
export function useLiveJam({
  detected,
  cloudHit,
  trackIdentity,
  playing,
}: Input) {
  const [key, setKey] = useState<JamKey | null>(null);
  const [history, setHistory] = useState<JamKey[]>([]);
  const [locked, setLocked] = useState(false);
  const [following, setFollowing] = useState(true);
  const [settling, setSettling] = useState(false);
  const [pendingKey, setPendingKey] = useState<Pick<JamKey, "root" | "scaleType"> | null>(null);
  const track = useRef(trackIdentity);
  const staleCloud = useRef<Input["cloudHit"]>(null);
  const librarySeeded = useRef(false);
  const lastEvidence = useRef(-1);
  const legacyWindows = useRef(-1);
  const legacyTrackChanged = useRef(false);
  const candidate = useRef<{
    root: string;
    scaleType: "major" | "minor";
    since: number;
    windows: number;
  } | null>(null);

  const commit = (next: JamKey) => {
    setKey(next);
    setHistory((current) => {
      const last = current.at(-1);
      if (
        last?.root === next.root &&
        last.scaleType === next.scaleType &&
        last.source === next.source
      )
        return current;
      return [...current, next].slice(-8);
    });
  };
  const libraryRoot = cloudHit ? tryNormalizeRoot(cloudHit.key) : null;
  const localRoot = detected.primaryKey
    ? tryNormalizeRoot(detected.primaryKey)
    : null;
  const mode =
    detected.primaryScale === "major" || detected.primaryScale === "minor"
      ? detected.primaryScale
      : null;
  const localEligible =
    !detected.ambiguous &&
    detected.state === "likely_key" &&
    detected.enoughAudio &&
    detected.captureMode !== "unavailable" &&
    (canAutoApply(detected) ||
      (detected.source === "audio_analysis:numpy_fallback" &&
        detected.reason === "stable_numpy_estimate" &&
        detected.confidence >= 0.84 &&
        detected.stability >= 0.84));
  const matchingTrack = detected.trackIdentity === undefined
    ? !legacyTrackChanged.current || detected.windowCount > legacyWindows.current
    : detected.trackIdentity === trackIdentity;
  useEffect(() => {
    const cancel = () => {
      candidate.current = null;
      setSettling(false);
      setPendingKey(null);
    };
    const changedTrack = track.current !== trackIdentity;
    if (changedTrack) {
      track.current = trackIdentity;
      staleCloud.current = cloudHit;
      librarySeeded.current = false;
      legacyTrackChanged.current = true;
      legacyWindows.current = detected.windowCount;
      cancel();
      setHistory([]);
      if (following && !locked) setKey(null);
    }
    // Native revisions survive track resets. Legacy window counts are only a
    // conservative fallback: new objects and elapsed time are never evidence.
    const hasRevision = detected.evidenceId !== undefined && Number.isSafeInteger(detected.evidenceId) && detected.evidenceId >= 0;
    const fresh = hasRevision
      ? detected.evidenceId! > lastEvidence.current
      : detected.evidenceId === undefined && detected.windowCount > legacyWindows.current;
    if (hasRevision) lastEvidence.current = Math.max(lastEvidence.current, detected.evidenceId!);
    else legacyWindows.current = Math.max(legacyWindows.current, detected.windowCount);
    const belongsToTrack = detected.trackIdentity === undefined
      ? !changedTrack && (!legacyTrackChanged.current || fresh)
      : detected.trackIdentity === trackIdentity;
    if (belongsToTrack && fresh) legacyTrackChanged.current = false;

    if (!following || locked || !playing) {
      cancel();
      return;
    }
    if (cloudHit && cloudHit !== staleCloud.current && libraryRoot && !librarySeeded.current) {
      librarySeeded.current = true;
      if (!key || changedTrack) {
        commit({ root: libraryRoot, scaleType: cloudHit.mode, source: "library" });
        cancel();
        return;
      }
    }
    if (!belongsToTrack || !localEligible || !localRoot || !mode) {
      cancel();
      return;
    }
    if (!fresh) return;
    if (!changedTrack && key?.root === localRoot && key.scaleType === mode) {
      cancel();
      return;
    }
    const now = Date.now();
    if (candidate.current?.root !== localRoot || candidate.current.scaleType !== mode) {
      candidate.current = { root: localRoot, scaleType: mode, since: now, windows: 1 };
    } else {
      candidate.current.windows += 1;
    }
    if (candidate.current.windows >= 3 && now - candidate.current.since >= 6000) {
      commit({ root: localRoot, scaleType: mode, source: "estimate" });
      cancel();
    } else {
      setSettling(true);
      setPendingKey({ root: localRoot, scaleType: mode });
    }
  }, [
    following,
    locked,
    playing,
    trackIdentity,
    libraryRoot,
    cloudHit?.mode,
    cloudHit,
    detected,
    key,
    localRoot,
    mode,
    localEligible,
  ]);

  const chooseKey = (root: string, scaleType: "major" | "minor") => {
    const normalized = tryNormalizeRoot(root);
    if (!normalized) return;
    setFollowing(false);
    commit({ root: normalized, scaleType, source: "manual" });
  };
  const suggestions: Pick<JamKey, "root" | "scaleType">[] = [];
  if (
    track.current === trackIdentity &&
    matchingTrack &&
    detected.windowCount > 0 &&
    detected.captureMode !== "unavailable"
  ) {
    for (const entry of [
      { key: detected.primaryKey, scale: detected.primaryScale },
      ...detected.alternatives,
    ]) {
      const root = entry.key ? tryNormalizeRoot(entry.key) : null;
      if (!root || (entry.scale !== "major" && entry.scale !== "minor"))
        continue;
      if (
        suggestions.some((s) => s.root === root && s.scaleType === entry.scale)
      )
        continue;
      suggestions.push({ root, scaleType: entry.scale });
      if (suggestions.length === 3) break;
    }
  }
  return {
    key,
    history,
    locked,
    setLocked,
    following,
    setFollowing,
    settling,
    pendingKey,
    chooseKey,
    suggestions,
  };
}
