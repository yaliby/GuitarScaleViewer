import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ensureLyricMap, getLyricJobs, subscribeLyricJobs } from "../services/lyricMap";
import type { LyricSheetState } from "./SongSheet";

/**
 * The lyric map of the saved song `id`: read it, or have Whisper make it.
 * `retime` makes a new one for the same song.
 */
export function useLyricMap(id: string | null): { state: LyricSheetState; retime(): void } {
  const [result, setResult] = useState<{ id: string; state: LyricSheetState } | null>(null);
  const [retimed, setRetimed] = useState<{ id: string | null; count: number }>({ id: null, count: 0 });
  const jobs = useSyncExternalStore(subscribeLyricJobs, getLyricJobs, getLyricJobs);

  useEffect(() => {
    if (!id) return;
    let live = true;
    const force = retimed.id === id && retimed.count > 0;
    setResult({ id, state: { status: "loading" } });
    ensureLyricMap(id, force).then(
      (map) => {
        if (live) setResult({ id, state: { status: "ready", map } });
      },
      (error: unknown) => {
        if (!live) return;
        const message = error instanceof Error ? error.message : String(error);
        setResult({ id, state: { status: "error", message } });
      },
    );
    return () => {
      live = false;
    };
  }, [id, retimed]);

  const retime = useCallback(() => {
    setRetimed((previous) => ({ id, count: previous.id === id ? previous.count + 1 : 1 }));
  }, [id]);

  let state: LyricSheetState = result && result.id === id ? result.state : { status: "loading" };
  const job = id ? jobs[id] : undefined;
  if (job && state.status !== "ready") {
    state = { status: "mapping", progress: job.progress, stage: job.stage };
  }
  return { state, retime };
}
