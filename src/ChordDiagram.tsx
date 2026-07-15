import { useId } from 'react';
import type { ChordVoicing } from './chords/chordTypes';

export type ChordDiagramProps = {
  voicing: ChordVoicing;
  isSelected?: boolean;
  onClick?: () => void;
  size?: 'sm' | 'md' | 'lg';
  /** When set with openStringPcs, root dot gets a subtle accent ring. */
  rootPitchClass?: number;
  openStringPcs?: readonly number[];
  /**
   * Open-pitch name per string (6 → 1, low to high). Shown as a compact hint row; display-only.
   */
  stringLabels?: readonly string[] | null;
};

const SIZE_MAP = {
  sm: { strGap: 22, fretGap: 30, padT: 36, padL: 28, padR: 14, padB: 12, dotR: 7, font: 11, labelNudge: 14 },
  md: { strGap: 26, fretGap: 36, padT: 42, padL: 32, padR: 16, padB: 14, dotR: 8.5, font: 12, labelNudge: 16 },
  lg: { strGap: 30, fretGap: 42, padT: 48, padL: 36, padR: 18, padB: 16, dotR: 10, font: 13, labelNudge: 18 },
} as const;

function cellPitchClass(
  openStringPcs: readonly number[] | undefined,
  stringIndex: number,
  fret: number,
): number | null {
  if (!openStringPcs) {
    return null;
  }
  const o = openStringPcs[stringIndex];
  if (o === undefined) {
    return null;
  }
  return (o + fret) % 12;
}

export function ChordDiagram({
  voicing,
  isSelected = false,
  onClick,
  size = 'md',
  rootPitchClass,
  openStringPcs,
  stringLabels,
}: ChordDiagramProps) {
  const rid = useId().replace(/:/g, '');
  const s = SIZE_MAP[size];
  const showStringHints = Boolean(stringLabels && stringLabels.length === 6);
  const strHintPadL = showStringHints ? s.labelNudge : 0;
  const frets = voicing.frets;
  const hasNut =
    frets.some((c) => c === 'o' || c === 0) ||
    frets.some((c) => typeof c === 'number' && c === 0);

  const numericPlayed = frets
    .map((c) => (c === 'o' ? 0 : typeof c === 'number' ? c : null))
    .filter((n): n is number => n !== null);
  const positive = numericPlayed.filter((n) => n > 0);
  const minF = positive.length ? Math.min(...positive) : 1;
  const maxF = numericPlayed.length ? Math.max(...numericPlayed) : 1;

  let startFret = 1;
  if (!hasNut && positive.length) {
    startFret = voicing.baseFret > 1 ? voicing.baseFret : minF;
  } else if (maxF > 5 && !hasNut) {
    startFret = Math.max(1, maxF - 3);
  }

  // Keep open-chord nut view, but expand rows when a voicing reaches higher frets
  // so dots/pills do not get clipped inside compact cards.
  const fretRows = hasNut ? Math.max(4, Math.min(6, maxF)) : 4;
  const strCount = 6;
  const innerW = (strCount - 1) * s.strGap;
  const innerH = fretRows * s.fretGap;
  /** Any “no nut” diagram (typical barre) — always show the window’s starting fret at left. */
  const leftFretLabelW = !hasNut ? 22 : 0;
  const topPad = s.padT + (showStringHints ? 6 : 0);
  const w = s.padL + innerW + s.padR + leftFretLabelW + strHintPadL;
  const h = topPad + innerH + s.padB;

  const x0 = s.padL + leftFretLabelW + strHintPadL;
  const y0 = topPad;
  const fretWindowLabelCx =
    !hasNut && leftFretLabelW > 0 ? s.padL + strHintPadL + leftFretLabelW * 0.5 : null;

  function fretCenterY(absFret: number): number {
    if (hasNut) {
      if (absFret <= 0) {
        return y0 - 8;
      }
      return y0 + (absFret - 0.5) * s.fretGap;
    }
    return y0 + (absFret - startFret + 0.5) * s.fretGap;
  }

  const barre = voicing.barre;
  let barreY: number | null = null;
  let barreX1 = 0;
  let barreX2 = 0;
  if (barre) {
    barreY = fretCenterY(barre.fret);
    barreX1 = x0 + barre.fromString * s.strGap;
    barreX2 = x0 + barre.toString * s.strGap;
  }

  const gFret = `cd-fret-${rid}`;
  const gDot = `cd-dot-${rid}`;
  const gShine = `cd-shine-${rid}`;
  const fShadow = `cd-sh-${rid}`;

  const fretWireYs = hasNut
    ? Array.from({ length: fretRows }, (_, i) => y0 + (i + 1) * s.fretGap)
    : Array.from({ length: fretRows + 1 }, (_, i) => y0 + i * s.fretGap);

  const isOpenVoicing =
    Boolean(voicing.tags?.includes('open')) || frets.some((c) => c === 'o');
  const isBarreVoicing = Boolean(voicing.barre);
  const ariaKind =
    isOpenVoicing && isBarreVoicing
      ? 'open and barre'
      : isOpenVoicing
        ? 'open'
        : isBarreVoicing
          ? 'barre'
          : '';
  const aria = `Chord voicing ${voicing.variationLabel ?? voicing.chordName}${ariaKind ? `, ${ariaKind}` : ''}`;

  const voicingKindPills: Array<'open' | 'barre'> = [];
  if (isBarreVoicing) {
    voicingKindPills.push('barre');
  }
  if (isOpenVoicing) {
    voicingKindPills.push('open');
  }
  const pillW = size === 'sm' ? 30 : size === 'lg' ? 38 : 34;
  const pillH = size === 'sm' ? 11 : size === 'lg' ? 15 : 13;
  const pillGap = 3;
  const pillFs = Math.max(7, s.font - 3);

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className={`select-none ${onClick ? 'cursor-pointer' : ''}`}
      onClick={onClick}
      role="img"
      aria-label={aria}
    >
      <defs>
        <linearGradient id={gFret} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#52525b" />
          <stop offset="100%" stopColor="#3f3f46" />
        </linearGradient>
        <linearGradient id={gDot} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#e4e4e7" />
          <stop offset="45%" stopColor="#a1a1aa" />
          <stop offset="100%" stopColor="#52525b" />
        </linearGradient>
        <radialGradient id={gShine} cx="32%" cy="28%" r="55%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <filter id={fShadow} x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="1.5" stdDeviation="2" floodColor="#000" floodOpacity="0.45" />
        </filter>
      </defs>

      {fretWindowLabelCx !== null ? (
        <text
          x={fretWindowLabelCx}
          y={y0 + s.fretGap * 0.65}
          textAnchor="middle"
          fill="#d4d4d8"
          style={{ fontSize: s.font + 4, fontWeight: 800, fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}
        >
          {startFret}
        </text>
      ) : null}

      {hasNut ? (
        <rect
          x={x0 - 2}
          y={y0 - 5}
          width={innerW + 4}
          height={5}
          rx={1}
          fill="#fafaf9"
          opacity={0.92}
        />
      ) : null}

      {fretWireYs.map((fy, j) => (
        <line
          key={`wire-${j}`}
          x1={x0}
          x2={x0 + innerW}
          y1={fy}
          y2={fy}
          stroke={`url(#${gFret})`}
          strokeWidth={2}
          opacity={0.95}
        />
      ))}

      {Array.from({ length: strCount }, (_, i) => {
        const x = x0 + i * s.strGap;
        return (
          <line
            key={`str-${i}`}
            x1={x}
            x2={x}
            y1={hasNut ? y0 - 6 : y0}
            y2={y0 + innerH}
            stroke="#d4d4d8"
            strokeOpacity={0.35}
            strokeWidth={1.25}
          />
        );
      })}

      {frets.map((cell, si) => {
        const x = x0 + si * s.strGap;
        const topY = y0 - 22;
        if (cell === 'x') {
          return (
            <text
              key={`xo-${si}`}
              x={x}
              y={topY}
              textAnchor="middle"
              fill="#71717a"
              style={{
                fontSize: s.font + 3,
                fontWeight: 700,
                fontFamily: 'ui-sans-serif, system-ui, sans-serif',
              }}
            >
              ×
            </text>
          );
        }
        if (cell === 'o' || cell === 0) {
          return (
            <circle
              key={`xo-${si}`}
              cx={x}
              cy={topY - 2}
              r={5}
              fill="none"
              stroke="#a1a1aa"
              strokeWidth={2}
            />
          );
        }
        return null;
      })}

      {showStringHints && stringLabels
        ? stringLabels.map((lab, si) => (
            <text
              key={`str-hint-${si}`}
              x={x0 + si * s.strGap - 8}
              y={y0 - 36}
              textAnchor="end"
              fill="#a1a1aa"
              style={{
                fontSize: s.font,
                fontWeight: 600,
                fontFamily: 'ui-sans-serif, system-ui, sans-serif',
                letterSpacing: '-0.02em',
              }}
            >
              {lab}
            </text>
          ))
        : null}

      {barreY !== null && barre ? (
        <g>
          <rect
            x={barreX1 - s.dotR}
            y={barreY - s.dotR * 0.95}
            width={barreX2 - barreX1 + s.dotR * 2}
            height={s.dotR * 1.9}
            rx={s.dotR * 0.9}
            fill={`url(#${gDot})`}
            stroke="#fafafa"
            strokeWidth={1.35}
            opacity={0.98}
            filter={`url(#${fShadow})`}
          />
          {barre.finger != null ? (
            <text
              x={(barreX1 + barreX2) / 2}
              y={barreY + 1}
              textAnchor="middle"
              dominantBaseline="middle"
              fill="#18181b"
              style={{
                fontSize: s.font,
                fontWeight: 800,
                fontFamily: 'ui-sans-serif, system-ui, sans-serif',
                pointerEvents: 'none',
              }}
            >
              {barre.finger}
            </text>
          ) : null}
        </g>
      ) : null}

      {frets.map((cell, si) => {
        if (cell === 'x' || cell === 'o') {
          return null;
        }
        const f = cell === 0 ? 0 : cell;
        if (typeof f !== 'number' || f < 0) {
          return null;
        }
        if (f === 0 && hasNut) {
          return null;
        }
        if (barre && f === barre.fret && si >= barre.fromString && si <= barre.toString) {
          return null;
        }
        const cy = fretCenterY(f);
        const x = x0 + si * s.strGap;
        const pc = cellPitchClass(openStringPcs, si, f);
        const isRoot = rootPitchClass !== undefined && pc === rootPitchClass;

        return (
          <g key={`dot-${si}`} filter={`url(#${fShadow})`}>
            {isRoot ? (
              <circle cx={x} cy={cy} r={s.dotR + 3} fill="none" stroke="#38bdf8" strokeOpacity={0.45} strokeWidth={1.5} />
            ) : null}
            <circle cx={x} cy={cy} r={s.dotR} fill={`url(#${gDot})`} stroke="#f4f4f5" strokeWidth={1.2} />
            <circle cx={x} cy={cy} r={s.dotR * 0.88} fill={`url(#${gShine})`} />
            {voicing.fingers?.[si] != null ? (
              <text
                x={x}
                y={cy + 1}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="#18181b"
                style={{
                  fontSize: s.font - 1,
                  fontWeight: 800,
                  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
                }}
              >
                {voicing.fingers[si]}
              </text>
            ) : null}
          </g>
        );
      })}

      {voicingKindPills.length > 0 ? (
        <g pointerEvents="none" aria-hidden>
          {voicingKindPills.map((kind, idx) => {
            const py = y0 + innerH - 4 - pillH - idx * (pillH + pillGap);
            const px = w - 6 - pillW;
            const isOpen = kind === 'open';
            return (
              <g key={kind}>
                <rect
                  x={px}
                  y={py}
                  width={pillW}
                  height={pillH}
                  rx={4}
                  fill={isOpen ? 'rgba(6,78,59,0.72)' : 'rgba(49,46,129,0.72)'}
                  stroke={isOpen ? 'rgba(52,211,153,0.55)' : 'rgba(167,139,250,0.55)'}
                  strokeWidth={1}
                />
                <text
                  x={px + pillW / 2}
                  y={py + pillH / 2 + 0.5}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill={isOpen ? '#d1fae5' : '#ede9fe'}
                  style={{
                    fontSize: pillFs,
                    fontWeight: 800,
                    fontFamily: 'ui-sans-serif, system-ui, sans-serif',
                    letterSpacing: isOpen ? '0.06em' : '0.04em',
                  }}
                >
                  {isOpen ? 'OPEN' : 'BARRE'}
                </text>
              </g>
            );
          })}
        </g>
      ) : null}

      {isSelected ? (
        <rect
          x={1}
          y={1}
          width={w - 2}
          height={h - 2}
          rx={10}
          fill="none"
          stroke="#38bdf8"
          strokeOpacity={0.55}
          strokeWidth={2}
          style={{ pointerEvents: 'none' }}
        />
      ) : null}
    </svg>
  );
}
