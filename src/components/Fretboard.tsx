import { motion, useReducedMotion } from "framer-motion";
import type { ScaleNote } from "../scaleSpell";
import { SCALE_DEGREE_LABELS } from "../scaleSpell";
import type { ScaleType } from "../scaleDataProvider";
import type { PracticeSession } from "../practice/session";

const CHROMATIC = [
  "C",
  "C♯",
  "D",
  "E♭",
  "E",
  "F",
  "F♯",
  "G",
  "A♭",
  "A",
  "B♭",
  "B",
];
const INTERVALS = [
  "1",
  "♭2",
  "2",
  "♭3",
  "3",
  "4",
  "♭5",
  "5",
  "♭6",
  "6",
  "♭7",
  "7",
];
export const musicalLabel = (s: string) =>
  s.replaceAll("#", "♯").replaceAll("b", "♭");

type Props = {
  notes: ScaleNote[];
  scaleType: ScaleType;
  openMidi: readonly number[];
  labels: readonly string[];
  startFret: number;
  endFret: number;
  capo: number;
  labelMode: "notes" | "intervals";
  display: PracticeSession["display"];
  positions: Set<string> | null;
  chordPcs: readonly number[] | null;
  activeMidi: readonly number[];
  onNote: (midi: number) => void;
  fit?: boolean;
  dimmedOpacity?: number;
};

export function Fretboard({
  notes,
  scaleType,
  openMidi,
  labels,
  startFret,
  endFret,
  capo,
  labelMode,
  display,
  positions,
  chordPcs,
  activeMidi,
  onNote,
  fit = false,
  dimmedOpacity = 0.25,
}: Props) {
  const reduceMotion = useReducedMotion();
  const rootPc = notes[0]?.pitchClass ?? 9;
  const noteMap = new Map(
    notes.map((n, i) => [
      n.pitchClass,
      { ...n, degree: SCALE_DEGREE_LABELS[scaleType][i] ?? "" },
    ]),
  );
  const tonicTriad = new Set(
    notes.length === 7
      ? [notes[0]!.pitchClass, notes[2]!.pitchClass, notes[4]!.pitchClass]
      : notes
          .filter((n) =>
            [0, 3, 4, 7].includes((n.pitchClass - rootPc + 12) % 12),
          )
          .map((n) => n.pitchClass),
  );
  const third = notes.find((n) =>
    [3, 4].includes((n.pitchClass - rootPc + 12) % 12),
  );
  const companion =
    third && (third.pitchClass - rootPc + 12) % 12 === 4
      ? [0, 3, 5, 7, 10]
      : [0, 2, 4, 7, 9];
  const first = Math.max(capo, startFret),
    last = endFret;
  const frets = Array.from(
    { length: Math.max(0, last - first + 1) },
    (_, i) => first + i,
  );
  const cell = 66,
    left = 66,
    top = 68,
    gap = 43;
  const width = left + frets.length * cell + 30,
    height = 330;
  const xAt = (f: number) => left + (f - first + 0.5) * cell;
  const yAt = (s: number) => top + (5 - s) * gap;

  return (
    <div className="fretboard-scroll" data-testid="fretboard-scroll">
      <svg
        className="fretboard"
        viewBox={`0 0 ${width} ${height}`}
        style={{ minWidth: fit ? 960 : Math.max(720, width) }}
        role="group"
        aria-label="Interactive guitar fretboard"
      >
        <defs>
          <linearGradient id="neck-surface" x1="0" y1="0" x2="0" y2="1">
            <stop stopColor="#23272b" />
            <stop offset="1" stopColor="#1b1e22" />
          </linearGradient>
        </defs>
        <rect
          x={left}
          y={top - 24}
          width={frets.length * cell}
          height={gap * 5 + 48}
          rx="9"
          fill="url(#neck-surface)"
          stroke="#383d42"
        />
        {frets.map((f) => (
          <g key={f}>
            <text
              x={xAt(f)}
              y={23}
              className={`fret-number ${f === capo ? "fret-open" : ""}`}
              textAnchor="middle"
            >
              {f === 0 ? "OPEN" : f === capo && capo > 0 ? `CAPO ${f}` : f}
            </text>
            {f > first && (
              <line
                x1={left + (f - first) * cell}
                x2={left + (f - first) * cell}
                y1={top - 24}
                y2={top + gap * 5 + 24}
                stroke="#42474c"
                strokeWidth="2"
              />
            )}
            {[3, 5, 7, 9, 12, 15, 17, 19, 21, 24].includes(f) &&
              (f % 12 === 0 ? [1.5, 3.5] : [2.5]).map((j) => (
                <circle
                  key={j}
                  cx={xAt(f)}
                  cy={top + j * gap}
                  r={5}
                  fill="#454a50"
                />
              ))}
          </g>
        ))}
        {Array.from({ length: 6 }, (_, s) => (
          <g key={`string-${s}`}>
            <text x={14} y={yAt(s) + 4} fill="#626971" fontSize="10">
              {6 - s}
            </text>
            <text
              x={36}
              y={yAt(s) + 5}
              fill="#afb6bc"
              fontSize="13"
              fontWeight="600"
              textAnchor="middle"
            >
              {musicalLabel(labels[s] ?? "")}
            </text>
            <line
              x1={left}
              x2={left + frets.length * cell}
              y1={yAt(s)}
              y2={yAt(s)}
              stroke="#a4a29b"
              strokeOpacity={0.25 + (5 - s) * 0.035}
              strokeWidth={1 + (5 - s) * 0.45}
            />
          </g>
        ))}
        {first === capo && (
          <rect
            x={left - 2}
            y={top - 24}
            width={capo ? 7 : 5}
            height={gap * 5 + 48}
            rx="2"
            fill={capo ? "#739d95" : "#c7c1af"}
          />
        )}
        {Array.from({ length: 6 }, (_, stringIndex) =>
          frets.map((fret) => {
            const midi = (openMidi[stringIndex] ?? 40) + fret,
              pc = midi % 12;
            const note = noteMap.get(pc),
              isRoot = pc === rootPc;
            const inPattern =
              !positions || positions.has(`${stringIndex}:${fret}`);
            const overlay =
              display === "pentatonic-overlay" &&
              companion.includes((pc - rootPc + 12) % 12);
            const visible =
              display === "chromatic" ||
              ((!!note || overlay) &&
                inPattern &&
                (display !== "roots" || isRoot) &&
                (display !== "triad" || tonicTriad.has(pc)));
            if (!visible) return null;
            const isChord = chordPcs?.includes(pc),
              playing = activeMidi.includes(midi);
            const dimmed = !!chordPcs && !isChord;
            const text =
              labelMode === "notes"
                ? musicalLabel(note?.label ?? CHROMATIC[pc] ?? "")
                : musicalLabel(
                    note?.degree ?? INTERVALS[(pc - rootPc + 12) % 12] ?? "",
                  );
            return (
              <motion.g
                key={`${stringIndex}-${fret}`}
                role="button"
                tabIndex={0}
                aria-label={`Play ${musicalLabel(note?.label ?? CHROMATIC[pc] ?? "")}, string ${6 - stringIndex}, fret ${fret}`}
                onClick={() => onNote(midi)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onNote(midi);
                  }
                }}
                className={`fret-note ${isRoot ? "root-note" : ""} ${isChord ? "chord-note" : ""} ${playing ? "sounding-note" : ""} ${overlay && !note ? "overlay-note" : ""}`}
                initial={false}
                animate={{ opacity: dimmed ? dimmedOpacity : 1 }}
                transition={{ duration: reduceMotion ? 0 : 0.22 }}
              >
                <title>{`${note?.label ?? CHROMATIC[pc]} · ${isRoot ? "Root note" : `Interval ${note?.degree ?? INTERVALS[(pc - rootPc + 12) % 12]}`} · Click to listen`}</title>
                {playing && (
                  <circle
                    className="note-pulse"
                    cx={xAt(fret)}
                    cy={yAt(stringIndex)}
                    r={25}
                    fill="none"
                    stroke="#ead5a1"
                    strokeWidth="1.5"
                  />
                )}
                <circle
                  cx={xAt(fret)}
                  cy={yAt(stringIndex)}
                  r={17}
                  className="note-disc"
                />
                <text
                  x={xAt(fret)}
                  y={yAt(stringIndex) + 0.5}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={text.length > 2 ? 10 : 12}
                  fontWeight="650"
                >
                  {text}
                </text>
              </motion.g>
            );
          }),
        )}
        <text x={left} y={height - 9} className="fret-caption">
          HIGH e ABOVE · LOW E BELOW
        </text>
        <text
          x={width - 30}
          y={height - 9}
          className="fret-caption"
          textAnchor="end"
        >
          {first}—{last} FRETS
        </text>
      </svg>
    </div>
  );
}
