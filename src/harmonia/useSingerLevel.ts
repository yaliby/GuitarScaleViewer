import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalPlayback } from "../../harmonia/packages/application/contracts";
import { ensureTrackStems, onStemsProgress, stemsSupported, type StemsProgress } from "../services/trackStems";

const LEVEL_KEY = "gsv.singerLevel";

export type SingerControl = {
  /** 0 (band only) to 1 (the recording as it is). */
  level: number;
  /** Set while the song is being separated for the first time. */
  preparing: StemsProgress | null;
  error: string | null;
  onChange(level: number): void;
};

function storedLevel(): number {
  try {
    const value = Number(localStorage.getItem(LEVEL_KEY));
    return Number.isFinite(value) && value >= 0 && value <= 1 && localStorage.getItem(LEVEL_KEY) !== null ? value : 1;
  } catch {
    return 1;
  }
}

/**
 * The sheet's singer slider for the saved song `id` playing on `player`. The first time the singer
 * goes below full, the song is separated (minutes on a CPU, seconds on a GPU) and kept; after that
 * the slider is instant. Null when the player or the platform cannot do it.
 */
export function useSingerLevel(player: LocalPlayback | null, id: string | null): SingerControl | null {
  const [level, setLevel] = useState(storedLevel);
  const [preparing, setPreparing] = useState<StemsProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ready = useRef<string | null>(null);
  const open = useRef(id);
  open.current = id;
  const wanted = useRef(level);
  wanted.current = level;
  const capable = Boolean(player && id && stemsSupported() && player.setStems && player.setSinger);

  const prepare = useCallback(
    async (songId: string) => {
      if (!player?.setStems || !player.setSinger) return;
      setError(null);
      setPreparing({ progress: 1, stage: "start" });
      const stop = onStemsProgress(songId, setPreparing);
      try {
        const urls = await ensureTrackStems(songId);
        // The listener moved on to another song while this one was separating: its band is not theirs.
        if (player.available === false || open.current !== songId) return;
        player.setStems(urls);
        ready.current = songId;
        player.setSinger(wanted.current);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        stop();
        setPreparing(null);
      }
    },
    [player],
  );

  // A new song starts from the recording as it is, unless the listener left the singer down.
  useEffect(() => {
    ready.current = null;
    if (!capable || !id) return;
    if (wanted.current < 0.99) void prepare(id);
  }, [id, capable, prepare]);

  const onChange = useCallback(
    (next: number) => {
      setLevel(next);
      try {
        localStorage.setItem(LEVEL_KEY, String(next));
      } catch {
        /* the level just is not remembered */
      }
      if (!player?.setSinger || !id) return;
      if (next >= 0.99 || ready.current === id) player.setSinger(next);
      else if (!preparing) void prepare(id);
    },
    [player, id, preparing, prepare],
  );

  return capable ? { level, preparing, error, onChange } : null;
}
