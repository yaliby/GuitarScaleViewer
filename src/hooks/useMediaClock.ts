import { useCallback, useEffect, useRef, useState } from 'react';
import { seekMedia } from './mediaTransport';

/** A report this far behind the running clock is the report's own latency, not a seek. */
const LATE_REPORT_MS = 300;

/**
 * The OS player's position, smooth enough to fill a word as it is sung. The media session
 * reports every 1.5 s; between reports the clock runs on from the last one while the song
 * plays, and holds still while it is paused. A seek from here moves the clock at once and asks
 * the OS player to follow.
 */
export function useMediaClock(positionMs: number | null, playing: boolean) {
  const clock = useRef({ ms: positionMs ?? 0, at: performance.now(), running: playing });
  const [ms, setMs] = useState(positionMs ?? 0);
  const [seekRevision, setSeekRevision] = useState(0);

  const read = () => {
    const { ms: from, at, running } = clock.current;
    return running ? from + (performance.now() - at) : from;
  };

  useEffect(() => {
    if (positionMs == null) return;
    const ahead = read() - positionMs;
    // Stepping back to a stale report would light the previous word again for a moment.
    if (clock.current.running && ahead > 0 && ahead < LATE_REPORT_MS) return;
    clock.current = { ms: positionMs, at: performance.now(), running: clock.current.running };
    setMs(positionMs);
  }, [positionMs]);

  useEffect(() => {
    if (clock.current.running === playing) return;
    clock.current = { ms: read(), at: performance.now(), running: playing };
    setMs(clock.current.ms);
  }, [playing]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      if (now - last >= 33) {
        last = now;
        setMs(read());
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const seek = useCallback((seconds: number) => {
    const target = Math.max(0, Math.round(seconds * 1000));
    clock.current = { ms: target, at: performance.now(), running: clock.current.running };
    setMs(target);
    setSeekRevision((revision) => revision + 1);
    void seekMedia(target);
  }, []);

  return { time: ms / 1000, seek, seekRevision };
}
