import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { activeIndex, type SheetChord } from "./chordSheet";

type Face = { label: string; hue: number | null };

/** Seconds of the song the runway shows ahead of the playhead. */
const AHEAD_S = 7;
/** Where the playhead stands, as a share of the runway's width: what was just played shows left of it. */
const HEAD = 0.18;
/** A name's width in px per letter, to keep a riding name inside its box. */
const NAME_PX_PER_LETTER = 13;

/**
 * The chords as a runway under a fixed playhead: each one a box as long as it is played, moving
 * at one speed toward the line, with the beats and bar lines between. How far the next change
 * is reads off the gap to the line, the same at every point in the song, however the words
 * above are laid out.
 */
export function ChordRunway({
  chords,
  faces,
  beats,
  downbeats,
  time,
  onSeek,
}: {
  chords: readonly SheetChord[];
  faces: readonly Face[];
  beats: readonly number[];
  downbeats: readonly number[];
  time: number;
  onSeek(seconds: number): void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const measure = () => setWidth(box.current?.clientWidth ?? 0);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const head = width * HEAD;
  const px = width > 0 ? (width - head) / AHEAD_S : 0;
  const from = time - (px ? head / px : 0);
  const to = time + AHEAD_S;

  const shown: { chord: SheetChord; index: number }[] = [];
  if (px) {
    for (let index = Math.max(0, activeIndex(chords, from)); index < chords.length; index += 1) {
      const chord = chords[index]!;
      if (chord.start >= to) break;
      if (chord.end > from) shown.push({ chord, index });
    }
  }
  const downs = new Set(downbeats);
  const now = activeIndex(chords, time);
  const current = now >= 0 && time < chords[now]!.end ? faces[now]?.label : undefined;
  const next = faces[now + 1]?.label;

  return (
    <div
      className="chord-runway"
      ref={box}
      role="img"
      aria-label={`${current ? `Playing ${current}` : "No chord"}${next ? `, next ${next}` : ""}`}
    >
      {px > 0 && (
        // The boxes sit still on a track that slides under the playhead: one style write a frame,
        // not one for every beat and chord on the runway (about 450 a second, and the repaint each cost).
        <div className="runway-track" style={{ transform: `translateX(${(head - time * px).toFixed(1)}px)` }}>
          {[...beats.filter((beat) => !downs.has(beat)), ...downbeats]
            .filter((beat) => beat > from && beat < to)
            .map((beat) => (
              <i
                key={beat}
                className={`runway-beat${downs.has(beat) ? " is-bar" : ""}`}
                style={{ left: `${(beat * px).toFixed(1)}px` }}
              />
            ))}
          {shown.map(({ chord, index }) => {
            const face = faces[index]!;
            const span = Math.max(4, (chord.end - chord.start) * px - 3);
            const on = time >= chord.start && time < chord.end;
            // How far the playhead is into this box; only the one being played needs it.
            const into = Math.max(0, Math.min(span, (time - chord.start) * px));
            // The one being played keeps its name at the line while it slides under it.
            const ride = on ? Math.max(0, Math.min(into, span - face.label.length * NAME_PX_PER_LETTER - 18)) : 0;
            return (
              <span
                key={chord.order}
                className={`runway-chord${on ? " on" : time >= chord.end ? " is-played" : ""}`}
                style={
                  {
                    left: `${(chord.start * px).toFixed(1)}px`,
                    width: `${span.toFixed(1)}px`,
                    ...(on ? { "--played": `${into.toFixed(1)}px` } : {}),
                    ...(face.hue === null ? {} : { "--h": face.hue }),
                  } as CSSProperties
                }
                title={`${face.label} at ${chord.start.toFixed(1)} s`}
                onClick={() => onSeek(chord.start)}
              >
                <span className="runway-name" style={ride ? { transform: `translateX(${ride.toFixed(1)}px)` } : undefined}>
                  {face.label}
                </span>
              </span>
            );
          })}
        </div>
      )}
      <i className="runway-head" style={{ left: `${(HEAD * 100).toFixed(1)}%` }} />
    </div>
  );
}
