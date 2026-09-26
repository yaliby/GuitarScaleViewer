// @ts-nocheck
import { useCallback, useEffect, useState } from 'react';
import type { LocalPlayback } from '../../../../packages/application/contracts';
export function usePlaybackClock(player: LocalPlayback) {
  const [time, setTime] = useState(player.position),
    [playing, setPlaying] = useState(player.playing),
    [seekRevision, setSeekRevision] = useState(0);
  useEffect(() => {
    let frame = 0,
      last = 0;
    const tick = (now: number) => {
      if (now - last >= 33) {
        setTime(player.position);
        setPlaying(player.playing);
        last = now;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [player]);
  const seek = useCallback(
    (seconds: number) => {
      // Media clocks resolve to microseconds. Round forwards so a chord-boundary
      // seek cannot land a fraction of a microsecond in the preceding segment.
      player.seek(Math.ceil(seconds * 1_000_000) / 1_000_000);
      setTime(player.position);
      setSeekRevision((revision) => revision + 1);
    },
    [player],
  );
  return { time, playing, seek, seekRevision };
}
