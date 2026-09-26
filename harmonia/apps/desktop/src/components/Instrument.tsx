// @ts-nocheck
import { chordPitchClasses, pitchName } from '../../../../packages/domain/chord';
import type { Chord } from '../../../../packages/domain/types';

export function Piano({ chord }: { chord: Chord }) {
  const notes = chordPitchClasses(chord),
    white = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21, 23];
  const black = [
    { pc: 1, x: 1 },
    { pc: 3, x: 2 },
    { pc: 6, x: 4 },
    { pc: 8, x: 5 },
    { pc: 10, x: 6 },
    { pc: 13, x: 8 },
    { pc: 15, x: 9 },
    { pc: 18, x: 11 },
    { pc: 20, x: 12 },
    { pc: 22, x: 13 },
  ];
  return (
    <svg
      className="piano"
      viewBox="0 0 336 108"
      role="img"
      aria-label={`Piano chord tones: ${notes.map((n) => pitchName(n)).join(', ')}`}
    >
      {white.map((pc, i) => (
        <g key={pc}>
          <rect
            x={i * 24 + 1}
            y="1"
            width="22"
            height="102"
            rx="3"
            fill={notes.includes(pc % 12) ? 'var(--accent)' : '#d5d5cc'}
          />
          {notes.includes(pc % 12) && <circle cx={i * 24 + 12} cy="85" r="3" fill="var(--ink)" />}
        </g>
      ))}
      {black.map(({ pc, x }) => (
        <rect
          key={pc}
          x={x * 24 - 7}
          y="1"
          width="14"
          height="62"
          rx="2"
          fill={notes.includes(pc % 12) ? '#659e80' : '#111719'}
          stroke="#111719"
          strokeWidth="2"
        />
      ))}
    </svg>
  );
}
export function Guitar({ chord }: { chord: Chord }) {
  const notes = chordPitchClasses(chord),
    tuning = [4, 11, 7, 2, 9, 4];
  return (
    <svg
      className="fretboard"
      viewBox="0 0 350 126"
      role="img"
      aria-label="Guitar chord-tone map in standard tuning"
    >
      {Array.from({ length: 13 }, (_, f) => (
        <line
          key={f}
          x1={24 + f * 25}
          x2={24 + f * 25}
          y1="12"
          y2="111"
          stroke="var(--line)"
          strokeWidth={f === 0 ? 3 : 1}
        />
      ))}
      {tuning.map((pc, string) => (
        <g key={string}>
          <line x1="15" x2="337" y1={15 + string * 18} y2={15 + string * 18} stroke="#758083" />
          {Array.from({ length: 13 }, (_, f) =>
            notes.includes((pc + f) % 12) ? (
              <circle
                key={f}
                cx={f === 0 ? 15 : 12 + f * 25}
                cy={15 + string * 18}
                r="5"
                fill={
                  chord.kind === 'chord' && (pc + f) % 12 === chord.root
                    ? 'var(--accent)'
                    : '#809891'
                }
              />
            ) : null,
          )}
        </g>
      ))}
    </svg>
  );
}
