// @ts-nocheck
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { ChordSegment } from '../../../../packages/domain/types';
import { displayChord, type ChordDisplayMode } from '../../../../packages/domain/notation';
import { timeLabel } from './Timeline';

/** Shorter segments are recognizer flicker; the song sheet folds them away the same way. */
const BLIP_S = 0.35;

type Run = { first: number; last: number; start: number; end: number; chord: ChordSegment['chord'] };

/**
 * The progression as it is played: a segment the same as the one before, or a flicker too short
 * to play, joins the chord before it. A recognizer can cut a two-minute song into a thousand
 * slivers; a strip of a thousand "0:00–0:00" buttons is not a progression.
 */
export function progressionRuns(
  segments: readonly ChordSegment[],
  label: (chord: ChordSegment['chord']) => string,
): Run[] {
  const runs: Run[] = [];
  segments.forEach((segment, index) => {
    const last = runs[runs.length - 1];
    if (last && (segment.end - segment.start < BLIP_S || label(segment.chord) === label(last.chord))) {
      last.last = index;
      last.end = segment.end;
      return;
    }
    runs.push({ first: index, last: index, start: segment.start, end: segment.end, chord: segment.chord });
  });
  return runs;
}

export const ChordProgression = memo(function ChordProgression({
  segments,
  index,
  notation,
  keyRoot,
  playing,
  seekRevision,
  onSeek,
}: {
  segments: readonly ChordSegment[];
  index: number;
  notation: ChordDisplayMode;
  keyRoot: number | null;
  playing: boolean;
  seekRevision: number;
  onSeek(seconds: number): void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const runs = useMemo(
    () => progressionRuns(segments, (chord) => displayChord(chord, notation, keyRoot)),
    [segments, notation, keyRoot],
  );
  const follow = useRef({
    resumeAt: 0,
    timer: 0,
    pointerDown: false,
    playing,
    seekRevision,
  });

  function centerActive() {
    const viewport = container.current;
    const active = viewport?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!viewport || !active) return;
    const outer = viewport.getBoundingClientRect();
    const inner = active.getBoundingClientRect();
    // Only move this horizontal viewport; scrollIntoView can move the whole page.
    viewport.scrollLeft += inner.left - outer.left + inner.width / 2 - outer.width / 2;
  }

  useLayoutEffect(() => {
    const state = follow.current;
    state.playing = playing;
    if (state.seekRevision !== seekRevision) {
      state.seekRevision = seekRevision;
      state.resumeAt = 0;
      state.pointerDown = false;
      window.clearTimeout(state.timer);
    }
    if (!state.pointerDown && performance.now() >= state.resumeAt) centerActive();
  }, [index, segments, notation, keyRoot, playing, seekRevision]);

  useEffect(() => {
    const viewport = container.current;
    if (!viewport) return;
    const state = follow.current;
    const respite = () => {
      state.resumeAt = performance.now() + 2500;
      window.clearTimeout(state.timer);
      state.timer = window.setTimeout(() => {
        if (!state.pointerDown && state.playing) centerActive();
      }, 2500);
    };
    const pointerDown = () => {
      state.pointerDown = true;
      respite();
    };
    const pointerUp = () => {
      if (!state.pointerDown) return;
      state.pointerDown = false;
      respite();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key))
        respite();
    };
    const resize = new ResizeObserver(() => {
      if (!state.pointerDown && performance.now() >= state.resumeAt) centerActive();
    });
    resize.observe(viewport);
    viewport.addEventListener('wheel', respite, { passive: true });
    viewport.addEventListener('pointerdown', pointerDown);
    viewport.addEventListener('keydown', keyDown);
    window.addEventListener('pointerup', pointerUp);
    window.addEventListener('pointercancel', pointerUp);
    return () => {
      window.clearTimeout(state.timer);
      resize.disconnect();
      viewport.removeEventListener('wheel', respite);
      viewport.removeEventListener('pointerdown', pointerDown);
      viewport.removeEventListener('keydown', keyDown);
      window.removeEventListener('pointerup', pointerUp);
      window.removeEventListener('pointercancel', pointerUp);
    };
  }, []);

  return (
    <section className="consumer-progression" aria-label="Complete chord progression">
      <h2>Chord progression</h2>
      <div className="progression-scroll" ref={container}>
        {runs.map((item) => {
          const label = displayChord(item.chord, notation, keyRoot);
          const active = index >= item.first && index <= item.last;
          return (
            <button
              key={segments[item.first]!.id}
              className={`progression-chord ${active ? 'active' : ''}`}
              aria-current={active ? 'true' : undefined}
              aria-label={`Play ${label} at ${item.start.toFixed(2)} seconds`}
              onClick={() => onSeek(item.start)}
            >
              <strong>{label}</strong>
              <span>
                {timeLabel(item.start)}–{timeLabel(item.end)}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
});
