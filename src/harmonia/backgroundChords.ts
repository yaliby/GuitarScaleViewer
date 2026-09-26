import { isTauri } from "@tauri-apps/api/core";
import { trace } from "../services/debugLog";
import { loadCapturedFile, type CapturedTrack } from "../services/trackCapture";
import { analyzedCaptureIds, markCaptureAnalyzed } from "./analyzedCaptures";
import { setChordJob, resetChordJobsForTests } from "./chordJobs";
import { cacheCapturedSong } from "./composition";

const pending = new Set<string>();
const aborts = new Map<string, AbortController>();

/**
 * After a song file is on disk, read its chords with the local recognizer.
 * The open screen is left alone; opening that song later reuses the saved analysis.
 */
export function enqueueChordAnalysis(track: CapturedTrack): Promise<void> {
  if (!isTauri() || !track.id || pending.has(track.id) || analyzedCaptureIds().has(track.id)) {
    return Promise.resolve();
  }
  pending.add(track.id);
  const controller = new AbortController();
  aborts.set(track.id, controller);
  setChordJob(track.id, { stage: "Reading chords", progress: 0 });
  return run(track, controller).finally(() => {
    pending.delete(track.id);
    aborts.delete(track.id);
    setChordJob(track.id, null);
  });
}

export function cancelChordAnalysis(id: string): void {
  aborts.get(id)?.abort();
}

export function resetBackgroundChordsForTests(): void {
  for (const controller of aborts.values()) controller.abort();
  aborts.clear();
  pending.clear();
  resetChordJobsForTests();
}

async function run(track: CapturedTrack, controller: AbortController): Promise<void> {
  try {
    const file = await loadCapturedFile(track);
    if (controller.signal.aborted) return;
    const record = await cacheCapturedSong(
      file,
      (stage, progress) => {
        if (!controller.signal.aborted) setChordJob(track.id, { stage, progress });
      },
      controller.signal,
    );
    if (controller.signal.aborted || !record?.analysis.fingerprint) return;
    markCaptureAnalyzed(track.id, record.analysis.fingerprint);
  } catch (error) {
    if (controller.signal.aborted) return;
    const message = error instanceof Error ? error.message : String(error);
    trace(
      "harmonia",
      "chords.fail",
      `Background chord extraction failed for ${track.title}`,
      { id: track.id, error: message },
      "fail",
    );
  }
}
