import { useCallback, useEffect, useRef, useState } from 'react';
import { seekMedia } from './mediaTransport';

/** A report this far off the running clock is a seek or a new song: the clock jumps to it. */
const JUMP_MS = 1500;
/** Closer than this, a report is the report's own jitter: the clock keeps its pace. */
const STEADY_MS = 40;

/**
 * The OS player's position, smooth enough to fill a word as it is sung. The media session
 * reports every 1.5 s; between reports the clock runs on from the last one while the song
 * plays, and holds still while it is paused. A seek from here moves the clock at once and asks
 * the OS player to follow.
 */
export function useMediaClock(positionMs: number | null, playing: boolean) {
  // `drift`: what the last report said the clock was off by, worked in over `slew` ms from `at`
  // rather than at once, so the clock never steps (a step skips or repeats a beat and a word).
  const clock = useRef({ ms: positionMs ?? 0, at: performance.now(), running: playing, drift: 0, slew: 1 });
  const [ms, setMs] = useState(positionMs ?? 0);
  const [seekRevision, setSeekRevision] = useState(0);

  const read = () => {
    const { ms: from, at, running, drift, slew } = clock.current;
    const elapsed = performance.now() - at;
    return running ? from + elapsed + drift * Math.min(1, elapsed / slew) : from + drift;
  };

  useEffect(() => {
    if (positionMs == null) return;
    const now = read();
    const off = positionMs - now;
    if (clock.current.running && Math.abs(off) < JUMP_MS) {
      if (Math.abs(off) < STEADY_MS) return;
      // Ease toward the report at most 40% faster or slower than the song, never backwards.
      clock.current = { ms: now, at: performance.now(), running: true, drift: off, slew: Math.max(800, Math.abs(off) * 2.5) };
      return;
    }
    clock.current = { ms: positionMs, at: performance.now(), running: clock.current.running, drift: 0, slew: 1 };
    setMs(positionMs);
  }, [positionMs]);

  useEffect(() => {
    if (clock.current.running === playing) return;
    clock.current = { ms: read(), at: performance.now(), running: playing, drift: 0, slew: 1 };
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
    clock.current = { ms: target, at: performance.now(), running: clock.current.running, drift: 0, slew: 1 };
    setMs(target);
    setSeekRevision((revision) => revision + 1);
    void seekMedia(target);
  }, []);

  return { time: ms / 1000, seek, seekRevision };
}
