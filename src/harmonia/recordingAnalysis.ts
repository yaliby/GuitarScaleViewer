import type { Analysis, SavedTrack } from "../../harmonia/packages/domain/types";
import { analyzedFingerprint, subscribeAnalyzed } from "./analyzedCaptures";
import { getHarmoniaSession } from "./composition";

/** The newest analysis of one recording: a re-analysis supersedes, a hand correction is saved in place. */
export function latestFor(library: readonly SavedTrack[], fingerprint: string | null): SavedTrack | null {
  if (!fingerprint) return null;
  let best: SavedTrack | null = null;
  for (const record of library) {
    if (record.track.fingerprint !== fingerprint) continue;
    if (!best || Date.parse(record.analysis.createdAt) > Date.parse(best.analysis.createdAt)) {
      best = record;
    }
  }
  return best;
}

/**
 * Follow the analysis of one saved copy: `onChange` gets the newest one now, again whenever the copy
 * is (re)read, and null while it has not been read. The analysis stack is only opened once the copy
 * has been read, so a song that was never saved costs the neck nothing.
 */
export function watchRecordingAnalysis(
  captureId: string,
  onChange: (analysis: Analysis | null) => void,
): () => void {
  let live = true;
  let unsubscribeLibrary: (() => void) | null = null;
  let last: Analysis | null | undefined;

  const emit = (analysis: Analysis | null) => {
    if (!live || analysis === last) return;
    last = analysis;
    onChange(analysis);
  };

  const attach = () => {
    const fingerprint = analyzedFingerprint(captureId);
    if (!fingerprint) {
      emit(null);
      return;
    }
    void getHarmoniaSession().then(
      (session) => {
        if (!live) return;
        const read = () => emit(latestFor(session.snapshot().library, analyzedFingerprint(captureId))?.analysis ?? null);
        if (!unsubscribeLibrary) {
          const unsubscribe = session.subscribe(read);
          unsubscribeLibrary = typeof unsubscribe === "function" ? unsubscribe : null;
        }
        read();
      },
      () => emit(null),
    );
  };

  const unsubscribeAnalyzed = subscribeAnalyzed(attach);
  attach();
  return () => {
    live = false;
    unsubscribeAnalyzed();
    unsubscribeLibrary?.();
  };
}
