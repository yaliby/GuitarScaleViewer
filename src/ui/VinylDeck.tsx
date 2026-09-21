import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Pause, Play, Waves } from 'lucide-react';
import { clockLabel } from './statusLabels';
import {
  clampPositionMs,
  deltaRadToDeg,
  pointerAngle,
  seekDeltaMs,
  shortestAngleDelta,
  spinAdvanceDeg,
  VINYL_CLICK_MAX_RAD,
} from './vinylMath';

export type VinylDeckProps = {
  playing: boolean;
  playbackStatus: string;
  positionMs: number | null;
  durationMs: number | null;
  interactive: boolean;
  onPause: () => void;
  onPlay: () => void;
  onSeek: (positionMs: number) => void;
  /** Live cue position so the deck progress bar can follow the platter. */
  onCue?: (positionMs: number | null) => void;
};

const SEEK_THROTTLE_MS = 90;
const NUDGE_MS = 5_000;
const HELD_PLAYBACK_MS = 5_000;

function capturePointer(target: HTMLElement, pointerId: number): void {
  if (typeof target.setPointerCapture !== 'function') {
    return;
  }
  try {
    target.setPointerCapture(pointerId);
  } catch {
    /* WebView2 and WebKitGTK both throw if the pointer is already gone. */
  }
}

function releasePointer(target: HTMLElement, pointerId: number): void {
  if (typeof target.releasePointerCapture !== 'function') {
    return;
  }
  try {
    if (typeof target.hasPointerCapture === 'function' && !target.hasPointerCapture(pointerId)) {
      return;
    }
    target.releasePointerCapture(pointerId);
  } catch {
    /* ignore */
  }
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * The Lab's record: hover to pause the OS player, drag the grooves clockwise or
 * counterclockwise to cue the track (Windows GSMTC / Linux MPRIS).
 */
export function VinylDeck({
  playing,
  positionMs,
  durationMs,
  interactive,
  onPause,
  onPlay,
  onSeek,
  onCue,
}: VinylDeckProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const platterRef = useRef<HTMLDivElement>(null);
  const rotationDegRef = useRef(0);
  const liveSpinRef = useRef(false);
  const scrubRef = useRef<{
    lastAngle: number;
    liveMs: number;
    rotationDeg: number;
    travelledRad: number;
    pointerId: number;
  } | null>(null);
  const lastSeekAtRef = useRef(0);
  const onCueRef = useRef(onCue);
  onCueRef.current = onCue;
  const lastOsPositionRef = useRef(positionMs);
  const [hot, setHot] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [heldPlaying, setHeldPlaying] = useState<boolean | null>(null);
  const [previewMs, setPreviewMs] = useState<number | null>(null);

  const shownMs = previewMs ?? positionMs;
  const visualPlaying = heldPlaying ?? playing;
  const showPlay = interactive && !visualPlaying;

  const paintRotation = (deg: number) => {
    rotationDegRef.current = deg;
    const platter = platterRef.current;
    if (platter) {
      platter.style.transform = `rotate(${deg}deg)`;
    }
  };

  const stopLiveSpin = () => {
    liveSpinRef.current = false;
  };

  const publishCue = (ms: number | null) => {
    setPreviewMs(ms);
    onCueRef.current?.(ms);
  };

  useEffect(() => {
    if (heldPlaying == null) {
      return;
    }
    if (playing === heldPlaying) {
      setHeldPlaying(null);
      return;
    }
    const id = window.setTimeout(() => setHeldPlaying(null), HELD_PLAYBACK_MS);
    return () => window.clearTimeout(id);
  }, [heldPlaying, playing]);

  useEffect(() => {
    if (scrubbing || previewMs == null || positionMs == null) {
      lastOsPositionRef.current = positionMs;
      return;
    }
    const osMoved = lastOsPositionRef.current !== positionMs;
    lastOsPositionRef.current = positionMs;
    if (osMoved && Math.abs(positionMs - previewMs) < 1_500) {
      publishCue(null);
    }
  }, [positionMs, previewMs, scrubbing]);

  useEffect(() => {
    const shouldSpin = visualPlaying && !scrubbing && !prefersReducedMotion();
    liveSpinRef.current = shouldSpin;
    if (!shouldSpin) {
      return;
    }
    const originDeg = rotationDegRef.current;
    const originT = typeof performance !== 'undefined' ? performance.now() : Date.now();
    let raf = 0;
    const tick = (now: number) => {
      if (!liveSpinRef.current) {
        return;
      }
      paintRotation(originDeg + spinAdvanceDeg(now - originT));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      liveSpinRef.current = false;
      cancelAnimationFrame(raf);
    };
  }, [visualPlaying, scrubbing]);

  const emitSeek = (nextMs: number, force: boolean) => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!force && now - lastSeekAtRef.current < SEEK_THROTTLE_MS) {
      return;
    }
    lastSeekAtRef.current = now;
    onSeek(nextMs);
  };

  const angleAt = (clientX: number, clientY: number): number | null => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || rect.width < 8 || rect.height < 8) {
      return null;
    }
    return pointerAngle(clientX, clientY, rect.left + rect.width / 2, rect.top + rect.height / 2);
  };

  const applyDelta = (nextAngle: number, force: boolean) => {
    const scrub = scrubRef.current;
    if (!scrub) {
      return;
    }
    const delta = shortestAngleDelta(scrub.lastAngle, nextAngle);
    scrub.lastAngle = nextAngle;
    if (Math.abs(delta) < 0.0001) {
      return;
    }
    scrub.travelledRad += Math.abs(delta);
    scrub.rotationDeg += deltaRadToDeg(delta);
    paintRotation(scrub.rotationDeg);
    scrub.liveMs = clampPositionMs(scrub.liveMs + seekDeltaMs(delta), durationMs);
    if (scrub.travelledRad < VINYL_CLICK_MAX_RAD) {
      return;
    }
    publishCue(scrub.liveMs);
    emitSeek(Math.round(scrub.liveMs), force);
  };

  const togglePlayback = () => {
    if (visualPlaying) {
      stopLiveSpin();
      setHeldPlaying(false);
      onPause();
    } else {
      setHeldPlaying(true);
      onPlay();
    }
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive || event.button !== 0) {
      return;
    }
    if ((event.target as HTMLElement | null)?.closest('.lab-vinyl-transport')) {
      return;
    }
    const angle = angleAt(event.clientX, event.clientY);
    if (angle == null) {
      return;
    }
    event.preventDefault();
    capturePointer(event.currentTarget, event.pointerId);
    stopLiveSpin();
    scrubRef.current = {
      lastAngle: angle,
      liveMs: positionMs ?? previewMs ?? 0,
      rotationDeg: rotationDegRef.current,
      travelledRad: 0,
      pointerId: event.pointerId,
    };
    setScrubbing(true);
    setHot(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!scrubRef.current || event.pointerId !== scrubRef.current.pointerId) {
      return;
    }
    const angle = angleAt(event.clientX, event.clientY);
    if (angle == null) {
      return;
    }
    applyDelta(angle, false);
  };

  const endScrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    const scrub = scrubRef.current;
    if (!scrub || event.pointerId !== scrub.pointerId) {
      return;
    }
    const angle = angleAt(event.clientX, event.clientY);
    if (angle != null) {
      applyDelta(angle, true);
    }
    const cued = scrub.travelledRad >= VINYL_CLICK_MAX_RAD;
    if (cued) {
      emitSeek(Math.round(scrub.liveMs), true);
    } else {
      publishCue(null);
      togglePlayback();
    }
    releasePointer(event.currentTarget, event.pointerId);
    scrubRef.current = null;
    setScrubbing(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!interactive) {
      return;
    }
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      togglePlayback();
      return;
    }
    const dir = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0;
    if (dir === 0) {
      return;
    }
    event.preventDefault();
    const next = clampPositionMs((shownMs ?? 0) + dir * NUDGE_MS, durationMs);
    publishCue(next);
    onSeek(Math.round(next));
  };

  const caption = scrubbing
    ? `${clockLabel(shownMs)} / ${clockLabel(durationMs)}`
    : hot && interactive
      ? `${showPlay ? 'Play' : 'Pause'} · drag to cue`
      : 'Six strings. Twenty-four frets.';

  return (
    <div
      className={`lab-record ${visualPlaying && !scrubbing ? 'spinning' : ''} ${scrubbing ? 'is-scrubbing' : ''}`}
    >
      <div className="lab-record-orbit" />
      <div
        ref={stageRef}
        className={`lab-vinyl-stage ${interactive ? 'is-interactive' : ''} ${hot ? 'is-hot' : ''} ${scrubbing ? 'is-scrubbing' : ''}`}
        role={interactive ? 'slider' : undefined}
        tabIndex={interactive ? 0 : undefined}
        aria-label={interactive ? 'Song position' : undefined}
        aria-valuemin={interactive ? 0 : undefined}
        aria-valuemax={interactive && durationMs != null ? Math.round(durationMs) : undefined}
        aria-valuenow={interactive && shownMs != null ? Math.round(shownMs) : undefined}
        aria-valuetext={interactive ? `${clockLabel(shownMs)} of ${clockLabel(durationMs)}` : undefined}
        onPointerEnter={() => setHot(true)}
        onPointerLeave={() => {
          if (!scrubRef.current) {
            setHot(false);
          }
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endScrub}
        onPointerCancel={endScrub}
        onKeyDown={onKeyDown}
      >
        <div className="lab-vinyl-platter" ref={platterRef}>
          <div className="lab-vinyl">
            <div className="lab-vinyl-label">
              <Waves size={30} />
              <span>
                FRETBOARD
                <br />
                LAB
              </span>
              <i />
            </div>
          </div>
        </div>
        {interactive ? (
          <button
            type="button"
            className="lab-vinyl-transport"
            aria-label={showPlay ? 'Play current track' : 'Pause current track'}
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            onPointerUp={(event) => {
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
              togglePlayback();
            }}
          >
            {showPlay ? <Play size={22} fill="currentColor" /> : <Pause size={22} fill="currentColor" />}
          </button>
        ) : null}
      </div>
      <span className="lab-record-caption">{caption}</span>
    </div>
  );
}
