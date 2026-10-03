import { memo, useEffect, useMemo, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { pitchName } from "../../harmonia/packages/domain/chord";
import type { Chord } from "../../harmonia/packages/domain/types";
import type { FretShape, InstrumentId, KeysShape, Shape } from "./instrumentShapes";

type ShapeLibrary = typeof import("./instrumentShapes");

/** A chord the panel shows: the analysis chord, and its name and hue as the sheet writes them. */
export type ShownChord = { chord: Chord; label: string; hue: number | null };

const INSTRUMENTS: readonly { id: InstrumentId; label: string }[] = [
  { id: "guitar", label: "Guitar" },
  { id: "piano", label: "Piano" },
  { id: "ukulele", label: "Ukulele" },
  { id: "bass", label: "Bass" },
  { id: "mandolin", label: "Mandolin" },
];

const STORE_KEY = "gsv.sheet.instrument";

function storedInstrument(): InstrumentId {
  try {
    const value = window.localStorage.getItem(STORE_KEY);
    if (INSTRUMENTS.some((item) => item.id === value)) return value as InstrumentId;
  } catch {
    // Storage off: the guitar it is.
  }
  return "guitar";
}

const GAP = 26;
const ROW = 30;
const TOP = 38;
const LEFT = 36;

/** A chord chart: strings standing, low on the left, the nut (or the position) on top. */
function FretChart({ shape, label }: { shape: FretShape; label: string }) {
  const n = shape.strings.length;
  const x = (string: number) => LEFT + string * GAP;
  const width = LEFT * 2 + (n - 1) * GAP;
  const bottom = TOP + shape.rows * ROW;
  const cy = (fret: number) => (fret === 0 ? TOP - 14 : TOP + (fret - shape.baseFret + 0.5) * ROW);
  const played = shape.marks
    .map((mark) => `${shape.strings[mark.string]} ${mark.fret === 0 ? "open" : `fret ${mark.fret}`}`)
    .join(", ");
  return (
    <svg
      className="shape-chart"
      viewBox={`0 0 ${width} ${bottom + 28}`}
      role="img"
      aria-label={`${label}: ${played}${shape.muted.length ? `; ${shape.muted.map((s) => shape.strings[s]).join(", ")} not played` : ""}`}
    >
      {Array.from({ length: shape.rows + 1 }, (_, row) => (
        <line
          key={`r${row}`}
          x1={x(0)}
          x2={x(n - 1)}
          y1={TOP + row * ROW}
          y2={TOP + row * ROW}
          className={row === 0 && shape.baseFret === 1 ? "shape-nut" : "shape-fret"}
        />
      ))}
      {shape.baseFret > 1 && (
        <text x={x(0) - 12} y={TOP + ROW * 0.5 + 4} textAnchor="end" className="shape-position">
          {shape.baseFret}fr
        </text>
      )}
      {shape.strings.map((name, string) => (
        <g key={`s${string}`}>
          <line x1={x(string)} x2={x(string)} y1={TOP} y2={bottom} className="shape-string" />
          <text x={x(string)} y={bottom + 20} textAnchor="middle" className="shape-string-name">
            {name}
          </text>
        </g>
      ))}
      {shape.muted.map((string) => (
        <text key={`m${string}`} x={x(string)} y={TOP - 9} textAnchor="middle" className="shape-muted">
          ×
        </text>
      ))}
      {shape.barres.map((barre, index) => (
        <rect
          key={`b${index}`}
          x={x(barre.from) - 10}
          y={cy(barre.fret) - 10}
          width={x(barre.to) - x(barre.from) + 20}
          height={20}
          rx={10}
          className="shape-barre"
        />
      ))}
      {shape.marks.map((mark) =>
        mark.fret === 0 ? (
          <circle
            key={`${mark.string}-0`}
            cx={x(mark.string)}
            cy={cy(0)}
            r={6}
            className={`shape-open${mark.root ? " is-root" : ""}`}
          />
        ) : (
          <g key={`${mark.string}-${mark.fret}`}>
            <circle cx={x(mark.string)} cy={cy(mark.fret)} r={10} className={`shape-dot${mark.root ? " is-root" : ""}`} />
            {mark.finger !== null && mark.finger > 0 && (
              <text x={x(mark.string)} y={cy(mark.fret) + 4.5} textAnchor="middle" className="shape-finger">
                {mark.finger}
              </text>
            )}
          </g>
        ),
      )}
    </svg>
  );
}

const WHITE = new Set([0, 2, 4, 5, 7, 9, 11]);

/** The hand on the keys, framed to the notes it holds, with a little room either side. */
function Keys({ shape, label, spelling }: { shape: KeysShape; label: string; spelling: "sharp" | "flat" }) {
  const notes = shape.midiNotes;
  let start = Math.min(...notes) - 1;
  let end = Math.max(...notes) + 1;
  while (!WHITE.has(start % 12)) start -= 1;
  while (!WHITE.has(end % 12)) end += 1;
  const whites: number[] = [];
  for (let note = start; note <= end; note += 1) if (WHITE.has(note % 12)) whites.push(note);
  while (whites.length < 9) {
    if (whites.length % 2) {
      do end += 1;
      while (!WHITE.has(end % 12));
      whites.push(end);
    } else {
      do start -= 1;
      while (!WHITE.has(start % 12));
      whites.unshift(start);
    }
  }
  const blacks: number[] = [];
  for (let note = start; note <= end; note += 1) if (!WHITE.has(note % 12)) blacks.push(note);
  const name = (note: number) => `${pitchName(note % 12, spelling)}${Math.floor(note / 12) - 1}`;
  return (
    <svg
      className="shape-keys"
      viewBox={`0 0 ${whites.length * 26} 130`}
      role="img"
      aria-label={`${label} on the piano: ${notes.map(name).join(", ")}`}
    >
      {whites.map((note, index) => {
        const on = notes.includes(note);
        return (
          <g key={note}>
            <rect x={index * 26 + 1} y={1} width={24} height={126} rx={3} className={`key-white${on ? " on" : ""}`} />
            {on && (
              <text x={index * 26 + 13} y={112} textAnchor="middle" className="key-name">
                {pitchName(note % 12, spelling)}
              </text>
            )}
            {on && note % 12 === shape.root && <circle cx={index * 26 + 13} cy={121} r={2.5} className="key-root" />}
          </g>
        );
      })}
      {blacks.map((note) => {
        const at = whites.filter((white) => white < note).length * 26;
        const on = notes.includes(note);
        return (
          <g key={note}>
            <rect x={at - 8} y={1} width={16} height={76} rx={2} className={`key-black${on ? " on" : ""}`} />
            {on && (
              <text x={at} y={68} textAnchor="middle" className="key-name is-black">
                {pitchName(note % 12, spelling)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function Diagram({ shape, label, chord }: { shape: Shape; label: string; chord: Chord }) {
  const spelling = chord.kind === "chord" ? chord.spelling : "sharp";
  return shape.kind === "keys" ? (
    <Keys shape={shape} label={label} spelling={spelling} />
  ) : (
    <FretChart shape={shape} label={label} />
  );
}

/**
 * Beside the song sheet: how to play the chord being played now, on the instrument in hand, and
 * the next one smaller under it. Guitar unless the player picks another; the pick is remembered.
 */
export const ChordShapes = memo(function ChordShapes({
  now,
  next,
  upcoming,
}: {
  now: ShownChord | null;
  next: ShownChord | null;
  /** Nothing is played yet (or between chords): `now` is the chord that comes first. */
  upcoming: boolean;
}) {
  const [instrument, setInstrument] = useState<InstrumentId>(storedInstrument);
  const [pick, setPick] = useState({ key: "", index: 0 });
  // The guitar library is large: load it beside the sheet, not before it.
  const [library, setLibrary] = useState<ShapeLibrary | null>(null);
  useEffect(() => {
    let live = true;
    void import("./instrumentShapes").then(
      (loaded) => {
        if (live) setLibrary(loaded);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem(STORE_KEY, instrument);
    } catch {
      // Not remembered, still shown.
    }
  }, [instrument]);

  const result = useMemo(
    () => (library && now ? library.chordShapes(now.chord, instrument) : null),
    [library, now, instrument],
  );
  const nextResult = useMemo(
    () => (library && next ? library.chordShapes(next.chord, instrument) : null),
    [library, next, instrument],
  );
  const key = `${instrument}|${now?.label ?? ""}`;
  const count = result?.shapes.length ?? 0;
  const index = pick.key === key ? Math.min(pick.index, Math.max(0, count - 1)) : 0;
  const shape = result?.shapes[index];
  const nextShape = nextResult?.shapes[0];
  const turn = (step: number) => setPick({ key, index: (index + step + count) % count });

  return (
    <aside
      className="chord-shapes"
      aria-label="Chord shape"
      style={(now?.hue == null ? {} : { "--h": now.hue }) as CSSProperties}
    >
      <div className="chord-shapes-tabs" role="group" aria-label="Instrument">
        {INSTRUMENTS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={item.id === instrument ? "is-on" : ""}
            aria-pressed={item.id === instrument}
            onClick={() => setInstrument(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {now ? (
        <>
          <div className="chord-shapes-now">
            <span className="eyebrow">{upcoming ? "COMING UP" : "NOW"}</span>
            <strong className="chord-shapes-name">{now.label}</strong>
          </div>
          <div className="chord-shapes-stage">
            {shape ? (
              <Diagram shape={shape} label={now.label} chord={now.chord} />
            ) : (
              <p className="chord-shapes-none">
                {!library ? "Opening the chord shapes…" : (result?.note ?? "Nothing to play here.")}
              </p>
            )}
          </div>
          {shape && (
            <div className="chord-shapes-meta">
              {count > 1 ? (
                <span className="chord-shapes-cycle">
                  <button type="button" aria-label="Previous shape" onClick={() => turn(-1)}>
                    <ChevronLeft size={15} />
                  </button>
                  <span>
                    {shape.name} · {index + 1}/{count}
                  </span>
                  <button type="button" aria-label="Next shape" onClick={() => turn(1)}>
                    <ChevronRight size={15} />
                  </button>
                </span>
              ) : (
                <span>{shape.name}</span>
              )}
              {result?.note && <p className="chord-shapes-note">{result.note}</p>}
            </div>
          )}
          {next && (
            <div
              className="chord-shapes-next"
              style={(next.hue == null ? {} : { "--h": next.hue }) as CSSProperties}
            >
              <div>
                <span className="eyebrow">NEXT</span>
                <strong>{next.label}</strong>
              </div>
              {nextShape && <Diagram shape={nextShape} label={next.label} chord={next.chord} />}
            </div>
          )}
        </>
      ) : (
        <p className="chord-shapes-none">The chord shapes follow the song once it has chords.</p>
      )}
    </aside>
  );
});
