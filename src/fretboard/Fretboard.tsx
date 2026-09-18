import { memo, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  buildScaleNotes,
  labelForPitchClass,
  pitchClassSet,
  type ScaleNote,
} from '../scaleSpell';
import type { ScaleType } from '../scaleDataProvider';
import type { ScaleChordWithVoicings } from '../chords/chordTypes';
import {
  FRET_MARKER_FRETS,
  NOTE_EXIT,
  NOTE_LAYOUT_SPRING,
  buildCameraWindow,
  buildLayout,
  dist2,
  getCapoBodyX,
  labelChromatic,
  mainPitchClassSet,
  pentatonicCompanionType,
  pitchAtFret,
  type ChordEmphasis,
  type FretPoint,
  type FretboardViewMode,
  type MarkerToken,
  type RenderMarker,
} from './geometry';

export type FretboardProps = {
  /** Tonic of the displayed scale, e.g. "A". */
  root: string;
  scaleType: ScaleType;
  /** Spelled scale tones, shared with the key strip and chord library. */
  notes: ScaleNote[];
  viewMode: FretboardViewMode;
  openStringPcs: readonly number[];
  stringLabels: readonly string[];
  capo: number;
  numFrets: number;
  selectedChord: ScaleChordWithVoicings | null;
  /** Accessible name, e.g. "A Natural minor (Aeolian)". */
  title: string;
};

/**
 * The neck itself: geometry, note markers and their motion. Deliberately owns no app chrome —
 * every control lives outside and arrives here as a prop.
 */
function FretboardView({
  root,
  scaleType,
  notes,
  viewMode,
  openStringPcs,
  stringLabels,
  capo,
  numFrets,
  selectedChord,
  title,
}: FretboardProps) {
  const layout = useMemo(() => buildLayout(numFrets), [numFrets]);

  const camera = useMemo(
    () => buildCameraWindow(layout, capo),
    [layout, capo],
  );

  /** When viewBox width < full layout (capo crop), SVG scales up; scale Y + font so fret numbers stay fixed px above the board. */
  const viewBoxZoomU = camera.width / layout.width;

  const capoBodyX = useMemo(
    () => getCapoBodyX(layout, capo),
    [layout, capo],
  );

  const nutX = layout.leftPad + layout.nutW - 2;
  const capoWireX = capo > 0 ? (layout.fretWireXs[capo - 1] ?? nutX) : nutX;

  const mainPcSet = useMemo(() => mainPitchClassSet(viewMode, notes), [viewMode, notes]);
  const pentNotes = useMemo(
    () =>
      viewMode === 'scale-plus-pentatonic'
        ? buildScaleNotes(root, pentatonicCompanionType(scaleType))
        : [],
    [viewMode, root, scaleType],
  );
  const pentPcSet = useMemo(() => pitchClassSet(pentNotes), [pentNotes]);
  const scalePcSet = useMemo(() => pitchClassSet(notes), [notes]);
  const rootPc = notes[0]?.pitchClass ?? 0;

  const chordTonePcs = useMemo(() => {
    if (!selectedChord) {
      return null;
    }
    return new Set(selectedChord.chordPitchClasses);
  }, [selectedChord]);
  const chordRootPc = selectedChord?.rootPitchClass ?? null;

  /** Open-string scale tones are not drawn on the neck — only next to the string letter. */
  const markers = useMemo(() => {
    const out: Array<FretPoint & { pitchClass: number }> = [];

    for (let s = 0; s < 6; s++) {
      for (let f = 1; f <= numFrets; f++) {
        if (capo > 0 && f <= capo) {
          continue;
        }

        const pc = pitchAtFret(openStringPcs, s, f);
        const showMain = mainPcSet.has(pc);
        const showPent = viewMode === 'scale-plus-pentatonic' && pentPcSet.has(pc);

        if (!showMain && !showPent) {
          continue;
        }

        out.push({
          stringIndex: s,
          fret: f,
          x: layout.fretCenters[f] ?? 0,
          y: layout.stringYs[s] ?? 0,
          pitchClass: pc,
        });
      }
    }

    return out;
  }, [
    capo,
    layout.fretCenters,
    layout.stringYs,
    mainPcSet,
    numFrets,
    openStringPcs,
    pentPcSet,
    viewMode,
  ]);

  const targetMarkers: RenderMarker[] = useMemo(() => {
    const out: RenderMarker[] = [];
    for (const m of markers) {
      const pc = m.pitchClass;
      const inPent = viewMode === 'scale-plus-pentatonic' && pentPcSet.has(pc);
      const overlayOnly = inPent && !scalePcSet.has(pc);
      const showPentRing = viewMode === 'scale-plus-pentatonic' && inPent && scalePcSet.has(pc);
      const info =
        viewMode === 'chromatic'
          ? { label: labelChromatic(pc), isRoot: pc === rootPc }
          : labelForPitchClass(notes, pc) ?? (overlayOnly ? labelForPitchClass(pentNotes, pc) : null);
      if (!info) {
        continue;
      }

      let chordEmphasis: ChordEmphasis | undefined;
      if (chordTonePcs && chordRootPc !== null) {
        if (chordTonePcs.has(pc)) {
          chordEmphasis = pc === chordRootPc ? 'chord-root' : 'chord-member';
        } else if (scalePcSet.has(pc) || viewMode === 'chromatic') {
          chordEmphasis = 'chord-dimmed';
        }
      }

      out.push({
        x: m.x,
        y: m.y,
        label: info.label,
        isRootStyle: pc === rootPc,
        overlayOnly,
        showPentRing,
        pitchClass: pc,
        chordEmphasis,
      });
    }
    return out;
  }, [
    chordRootPc,
    chordTonePcs,
    markers,
    notes,
    pentNotes,
    pentPcSet,
    rootPc,
    scalePcSet,
    viewMode,
  ]);

  const [markerTokens, setMarkerTokens] = useState<MarkerToken[]>(() => {
    // Fixed pool (all possible fretted slots). We reuse tokens so nothing "spawns".
    const tokens: MarkerToken[] = [];
    for (let s = 0; s < 6; s++) {
      for (let f = 1; f <= numFrets; f++) {
        tokens.push({
          id: `t-${s}-${f}`,
          x: layout.fretCenters[f] ?? 0,
          y: layout.stringYs[s] ?? 0,
          visible: false,
          marker: null,
        });
      }
    }
    return tokens;
  });

  // If numFrets changes, rebuild token pool to match physical slots.
  useEffect(() => {
    setMarkerTokens(() => {
      const tokens: MarkerToken[] = [];
      for (let s = 0; s < 6; s++) {
        for (let f = 1; f <= numFrets; f++) {
          tokens.push({
            id: `t-${s}-${f}`,
            x: layout.fretCenters[f] ?? 0,
            y: layout.stringYs[s] ?? 0,
            visible: false,
            marker: null,
          });
        }
      }
      return tokens;
    });
  }, [layout.fretCenters, layout.stringYs, numFrets]);

  useEffect(() => {
    setMarkerTokens((prev) => {
      const tokens = prev.map((t) => ({ ...t }));

      // Build list of candidate tokens (all of them), but matching prefers minimal travel.
      const used = new Set<string>();
      const wasVisible = new Set(tokens.filter((t) => t.visible).map((t) => t.id));
      const visibleRefs = tokens.filter((t) => t.visible);

      function nearestVisiblePos(x: number, y: number): { x: number; y: number } | null {
        if (visibleRefs.length === 0) return null;
        let best = visibleRefs[0]!;
        let bestD = dist2(best.x, best.y, x, y);
        for (let i = 1; i < visibleRefs.length; i++) {
          const cand = visibleRefs[i]!;
          const d = dist2(cand.x, cand.y, x, y);
          if (d < bestD) {
            best = cand;
            bestD = d;
          }
        }
        return { x: best.x, y: best.y };
      }

      // Greedy assignment: for each target marker pick the closest unused token.
      const assignments: Array<{ tokenIdx: number; marker: RenderMarker }> = [];
      for (const marker of targetMarkers) {
        let bestIdx = -1;
        let bestD = Infinity;
        for (let i = 0; i < tokens.length; i++) {
          const t = tokens[i]!;
          if (used.has(t.id)) continue;
          const d = dist2(t.x, t.y, marker.x, marker.y);
          if (d < bestD) {
            bestIdx = i;
            bestD = d;
          }
        }
        if (bestIdx >= 0) {
          used.add(tokens[bestIdx]!.id);
          assignments.push({ tokenIdx: bestIdx, marker });
        }
      }

      // Reset visibility; keep previous marker for fade-out.
      for (const t of tokens) {
        t.visible = false;
      }

      for (const a of assignments) {
        const t = tokens[a.tokenIdx]!;
        // If this token was previously hidden, start it from an existing marker position so it doesn't "spawn" elsewhere.
        if (!wasVisible.has(t.id)) {
          const from = nearestVisiblePos(a.marker.x, a.marker.y);
          if (from) {
            t.x = from.x;
            t.y = from.y;
          }
        }
        t.visible = true;
        t.marker = a.marker;
        // Move to target.
        t.x = a.marker.x;
        t.y = a.marker.y;
      }

      return tokens;
    });
  }, [targetMarkers]);
  return (
            <motion.svg
              role="img"
              aria-label={`Fretboard for ${title}`}
              viewBox={`${camera.x} 0 ${camera.width} ${layout.height}`}
              overflow="visible"
              className="mx-auto block h-auto max-h-[min(48vh,28rem)] w-full min-w-0 drop-shadow-[0_32px_80px_-12px_rgba(0,0,0,0.65)]"
              preserveAspectRatio="xMidYMid meet"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            >
            <defs>
              <linearGradient id="capo-body" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#18181b" />
                <stop offset="45%" stopColor="#0f172a" />
                <stop offset="100%" stopColor="#27272a" />
              </linearGradient>
              <filter id="capo-shadow" x="-80%" y="-50%" width="260%" height="220%">
                <feDropShadow dx="2" dy="3" stdDeviation="4" floodColor="#000" floodOpacity="0.45" />
              </filter>
              <linearGradient id="fb-wood" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="#1c1410" />
                <stop offset="22%" stopColor="#2d2219" />
                <stop offset="50%" stopColor="#3a2d22" />
                <stop offset="78%" stopColor="#2a1f17" />
                <stop offset="100%" stopColor="#18110c" />
              </linearGradient>
              <linearGradient id="fb-wood-h" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#1a120e" />
                <stop offset="35%" stopColor="#352a21" />
                <stop offset="100%" stopColor="#1f1611" />
              </linearGradient>
              <linearGradient id="fb-binding" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="#8b7355" />
                <stop offset="50%" stopColor="#c4a882" />
                <stop offset="100%" stopColor="#6e5a44" />
              </linearGradient>
              <linearGradient id="fb-nut" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#faf6ee" />
                <stop offset="55%" stopColor="#e8dfd0" />
                <stop offset="100%" stopColor="#c9bba8" />
              </linearGradient>
              <linearGradient id="fret-wire" gradientUnits="objectBoundingBox" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#f4f4f6" />
                <stop offset="35%" stopColor="#9a9590" />
                <stop offset="100%" stopColor="#4a4744" />
              </linearGradient>
              <linearGradient id="string-wound" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="#ebe4d8" />
                <stop offset="45%" stopColor="#a89e8e" />
                <stop offset="100%" stopColor="#6d6558" />
              </linearGradient>
              <linearGradient id="string-plain" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="#ffffff" />
                <stop offset="50%" stopColor="#d8d4cc" />
                <stop offset="100%" stopColor="#9a958c" />
              </linearGradient>
              <radialGradient id="inlay-pearl" cx="40%" cy="35%" r="65%">
                <stop offset="0%" stopColor="#fff8ee" />
                <stop offset="45%" stopColor="#d4b896" />
                <stop offset="100%" stopColor="#7a6348" />
              </radialGradient>
              <filter id="fb-shadow" x="-5%" y="-8%" width="110%" height="120%">
                <feDropShadow dx="0" dy="10" stdDeviation="14" floodColor="#000" floodOpacity="0.55" />
              </filter>
              <filter id="fret-shadow" x="-4" y="-2" width="12" height="400%">
                <feDropShadow dx="1" dy="0" stdDeviation="0.8" floodColor="#000" floodOpacity="0.45" />
              </filter>
              <filter id="string-shadow" x="-10%" y="-50%" width="120%" height="200%">
                <feDropShadow dx="0" dy="1.5" stdDeviation="0.6" floodColor="#000" floodOpacity="0.65" />
              </filter>
              <filter id="open-label-shadow" x="-50%" y="-70%" width="200%" height="260%">
                <feDropShadow dx="0" dy="2" stdDeviation="2" floodColor="#000" floodOpacity="0.55" />
              </filter>

              {/* ── Premium note markers (light from top-left) ── */}
              <radialGradient id="note-fill-secondary" cx="32%" cy="26%" r="72%">
                <stop offset="0%" stopColor="#5b6578" />
                <stop offset="38%" stopColor="#2a3344" />
                <stop offset="85%" stopColor="#0f141c" />
                <stop offset="100%" stopColor="#06080d" />
              </radialGradient>
              <linearGradient id="note-stroke-secondary" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#e2e8f0" />
                <stop offset="35%" stopColor="#7c8aa0" />
                <stop offset="70%" stopColor="#475569" />
                <stop offset="100%" stopColor="#1e293b" />
              </linearGradient>
              <radialGradient id="note-shine-secondary" cx="28%" cy="22%" r="45%">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0.38" />
                <stop offset="55%" stopColor="#ffffff" stopOpacity="0.06" />
                <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
              </radialGradient>
              <filter id="note-drop-secondary" x="-55%" y="-55%" width="210%" height="210%">
                <feDropShadow dx="2.2" dy="3.2" stdDeviation="3.2" floodColor="#000" floodOpacity="0.62" />
                <feDropShadow dx="-1.2" dy="-1.2" stdDeviation="1.4" floodColor="#ffffff" floodOpacity="0.07" />
              </filter>

              <radialGradient id="note-fill-root" cx="34%" cy="28%" r="70%">
                <stop offset="0%" stopColor="#fffbeb" />
                <stop offset="28%" stopColor="#fcd34d" />
                <stop offset="55%" stopColor="#d97706" />
                <stop offset="100%" stopColor="#422006" />
              </radialGradient>
              <linearGradient id="note-stroke-root" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#fef08a" />
                <stop offset="40%" stopColor="#f59e0b" />
                <stop offset="100%" stopColor="#92400e" />
              </linearGradient>
              <radialGradient id="note-shine-root" cx="30%" cy="24%" r="42%">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0.55" />
                <stop offset="50%" stopColor="#ffffff" stopOpacity="0.1" />
                <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
              </radialGradient>
              <filter id="note-glow-root" x="-100%" y="-100%" width="300%" height="300%">
                <feGaussianBlur in="SourceAlpha" stdDeviation="5" result="b" />
                <feFlood floodColor="#f59e0b" floodOpacity="0.55" result="f" />
                <feComposite in="f" in2="b" operator="in" result="g" />
                <feMerge>
                  <feMergeNode in="g" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              <filter id="note-drop-root" x="-90%" y="-90%" width="280%" height="280%">
                <feDropShadow dx="0" dy="0" stdDeviation="10" floodColor="#f59e0b" floodOpacity="0.42" />
                <feDropShadow dx="2.5" dy="3.5" stdDeviation="3.5" floodColor="#000" floodOpacity="0.55" />
              </filter>

            </defs>

              {Array.from({ length: numFrets }, (_, i) => {
                const fretNum = i + 1;
                const cx = layout.fretCenters[fretNum] ?? 0;
                return (
                  <text
                    key={`fn-${fretNum}`}
                    x={cx}
                    y={layout.fretNumberBaselineY * viewBoxZoomU}
                    textAnchor="middle"
                    fill="#71717a"
                    style={{
                      fontSize: 22 * viewBoxZoomU,
                      fontFamily: '"Plus Jakarta Sans", ui-sans-serif, system-ui, sans-serif',
                      fontWeight: 600,
                    }}
                  >
                    {fretNum}
                  </text>
                );
              })}

              <g>
              {/*
                Slightly extend the neck to the left (visual only).
                This keeps fret math unchanged while letting the board feel less "cut off".
              */}
              {(() => {
                const leftBleed = 26;
                const xBinding = layout.leftPad - 5 - leftBleed;
                const xWoodH = layout.leftPad - leftBleed;
                const xWood = layout.leftPad + 2 - leftBleed;
                const wBinding = layout.width - xBinding + 10;
                const wWoodH = layout.width - xWoodH + 8;
                const wWood = layout.width - xWood + 4;
                return (
                  <>
                    <rect
                      x={xBinding}
                      y={layout.boardTop - 18}
                      width={wBinding}
                      height={layout.boardBottom - layout.boardTop + 36}
                      rx="10"
                      fill="none"
                      stroke="url(#fb-binding)"
                      strokeWidth="6"
                    />
                    <rect
                      x={xWoodH}
                      y={layout.boardTop - 14}
                      width={wWoodH}
                      height={layout.boardBottom - layout.boardTop + 28}
                      rx="7"
                      fill="url(#fb-wood-h)"
                    />
                    <rect
                      x={xWood}
                      y={layout.boardTop - 12}
                      width={wWood}
                      height={layout.boardBottom - layout.boardTop + 24}
                      rx="5"
                      fill="url(#fb-wood)"
                      opacity={1}
                    />
                  </>
                );
              })()}
              </g>

              <>
                <rect
                  x={layout.leftPad + 4}
                  y={layout.boardTop - 12}
                  width={layout.nutW - 8}
                  height={layout.boardBottom - layout.boardTop + 24}
                  rx="1"
                  fill="url(#fb-nut)"
                />
                <line
                  x1={layout.leftPad + layout.nutW - 2}
                  x2={layout.leftPad + layout.nutW - 2}
                  y1={layout.boardTop - 12}
                  y2={layout.boardBottom + 12}
                  stroke="#fff"
                  strokeOpacity={0.35}
                  strokeWidth="1.5"
                />
              </>

              {layout.fretWireXs.map((x, i) => {
                const fretNum = i + 1;
                const thick = fretNum === 12 || fretNum === 24 ? 5 : 4;
                return (
                  <g key={`fret-${fretNum}`} filter="url(#fret-shadow)">
                    <line
                      x1={x}
                      x2={x}
                      y1={layout.boardTop - 10}
                      y2={layout.boardBottom + 10}
                      stroke="url(#fret-wire)"
                      strokeWidth={thick}
                      strokeLinecap="butt"
                    />
                    <line
                      x1={x - 0.5}
                      x2={x - 0.5}
                      y1={layout.boardTop - 10}
                      y2={layout.boardBottom + 10}
                      stroke="#ffffff"
                      strokeOpacity={0.22}
                      strokeWidth="1"
                    />
                  </g>
                );
              })}

            {layout.ghostFretWireXs.map((x, i) => {
              if (x > layout.boardRightX + 2) {
                return null;
              }
              const t = i / Math.max(1, layout.ghostFretWireXs.length - 1);
              const opacity = 0.11 * (1 - t * 0.85);
              return (
                <g key={`ghost-fret-${i}`}>
                  <line
                    x1={x}
                    x2={x}
                    y1={layout.boardTop - 6}
                    y2={layout.boardBottom + 6}
                    stroke="#6b6560"
                    strokeWidth={2}
                    strokeLinecap="butt"
                    opacity={opacity}
                  />
                </g>
              );
            })}

            {Array.from({ length: numFrets }, (_, i) => {
              const fretNum = i + 1;
              if (!FRET_MARKER_FRETS.has(fretNum)) {
                return null;
              }
              const cx = layout.fretCenters[fretNum] ?? 0;
              const cy = layout.boardTop + layout.stringGap * 2.5;
              if (fretNum === 12 || fretNum === 24) {
                // Same x (vertical column); keep dy modest so both dots sit in the clear band between
                // strings 2–3 (strings are drawn on top and would hide dots parked near y = stringYs[2|3]).
                const dy = layout.stringGap * 0.19;
                return (
                  <g key={`inlay-${fretNum}`} opacity={0.9}>
                    <circle cx={cx} cy={cy - dy} r={6} fill="url(#inlay-pearl)" opacity={0.62} />
                    <circle cx={cx} cy={cy + dy} r={6} fill="url(#inlay-pearl)" opacity={0.62} />
                  </g>
                );
              }
              return (
                <circle
                  key={`inlay-${fretNum}`}
                  cx={cx}
                  cy={cy}
                  r={6}
                  fill="url(#inlay-pearl)"
                  opacity={0.5}
                />
              );
            })}

            {layout.stringYs.map((y, s) => {
              const isWound = s <= 2;
              const x1 = layout.leftPad - 14;
              const x2 = layout.width - 8;
              const wMain = isWound ? 4.2 : 2.95;
              const wShadow = wMain + 2.2;
              return (
                <g key={s}>
                  <line
                    x1={x1}
                    x2={x2}
                    y1={y + 1.2}
                    y2={y + 1.2}
                    stroke="#000"
                    strokeOpacity={0.55}
                    strokeWidth={wShadow}
                    strokeLinecap="round"
                  />
                  <line
                    x1={x1}
                    x2={x2}
                    y1={y}
                    y2={y}
                    stroke={isWound ? 'url(#string-wound)' : 'url(#string-plain)'}
                    strokeWidth={wMain}
                    strokeLinecap="round"
                    filter="url(#string-shadow)"
                  />
                  <line
                    x1={x1}
                    x2={x2}
                    y1={y - 0.6}
                    y2={y - 0.6}
                    stroke="#fff"
                    strokeOpacity={isWound ? 0.28 : 0.42}
                    strokeWidth={Math.max(0.8, wMain * 0.35)}
                    strokeLinecap="round"
                  />
                </g>
              );
            })}

            {/* Open-string tuning pills — drawn after strings so they sit above strings (SVG z-order); capo draws on top */}
            {stringLabels.map((label, sIdx) => {
              const y = layout.stringYs[sIdx] ?? 0;
              if (openStringPcs[sIdx] === undefined) {
                return null;
              }
              const openPc = pitchAtFret(openStringPcs, sIdx, capo);
              const openInMain = mainPcSet.has(openPc);
              const openInPent = viewMode === 'scale-plus-pentatonic' && pentPcSet.has(openPc);
              const openRelevant = openInMain || openInPent;
              const gy = y + 4;

              const overlayOpenOnly = openRelevant && openInPent && !scalePcSet.has(openPc);
              const isRootOpen = openPc === rootPc;
              const showOpenBadge = openRelevant;

              return (
                <g key={`open-row-${sIdx}`}>
                  <AnimatePresence initial={false}>
                    <motion.g
                      key={`open-${sIdx}-tuning-${capo}`}
                      initial={false}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -5, transition: NOTE_EXIT }}
                      transition={NOTE_LAYOUT_SPRING}
                    >
                      {(() => {
                        const text =
                          capo > 0
                            ? (labelForPitchClass(notes, openPc)?.label ?? labelChromatic(openPc))
                            : label;
                        const hasAcc = /[#b]/.test(text);
                        const fs = hasAcc ? 16 : 18;
                        const gx =
                          capo > 0
                            ? Math.max(layout.leftPad + 6, capoWireX - 50)
                            : layout.leftPad - 28;
                        const r = isRootOpen ? 28 : 22;

                        const openShowPentRing =
                          viewMode === 'scale-plus-pentatonic' && scalePcSet.has(openPc) && openInPent;

                        let openChordEm: ChordEmphasis | undefined;
                        if (chordTonePcs && chordRootPc !== null && showOpenBadge) {
                          if (chordTonePcs.has(openPc)) {
                            openChordEm = openPc === chordRootPc ? 'chord-root' : 'chord-member';
                          } else if (scalePcSet.has(openPc) || viewMode === 'chromatic') {
                            openChordEm = 'chord-dimmed';
                          }
                        }

                        return (
                          <g transform={`translate(${gx}, ${gy})`} style={{ pointerEvents: 'none' }}>
                            {openShowPentRing ? (
                              <circle
                                r={r + 7}
                                fill="none"
                                stroke="#34d399"
                                strokeWidth={2}
                                strokeOpacity={openChordEm === 'chord-dimmed' ? 0.35 : 0.75}
                                style={{ pointerEvents: 'none' }}
                              />
                            ) : null}

                            {openChordEm === 'chord-dimmed' ? (
                              <>
                                <circle
                                  r={r}
                                  fill="#0c0c0e"
                                  stroke="#3f3f46"
                                  strokeWidth={2}
                                  opacity={0.72}
                                  filter="url(#open-label-shadow)"
                                />
                              </>
                            ) : openChordEm === 'chord-root' ? (
                              <>
                                <motion.circle
                                  r={r + 10}
                                  fill="none"
                                  stroke="#38bdf8"
                                  strokeWidth={2}
                                  animate={{ opacity: showOpenBadge ? [0.38, 0.88, 0.38] : 0.15 }}
                                  transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
                                />
                                {isRootOpen ? (
                                  <motion.circle
                                    r={r + 6}
                                    fill="none"
                                    stroke="#fbbf24"
                                    strokeWidth={1.6}
                                    animate={{ opacity: showOpenBadge ? [0.25, 0.55, 0.25] : 0.12 }}
                                    transition={{ duration: 2.7, repeat: Infinity, ease: 'easeInOut' }}
                                  />
                                ) : null}
                                <g filter="url(#note-drop-root)">
                                  <circle
                                    r={r}
                                    fill="#0c1924"
                                    stroke="#7dd3fc"
                                    strokeWidth={3}
                                    filter="url(#note-glow-root)"
                                    opacity={0.95}
                                  />
                                  <circle r={r * 0.88} fill="url(#note-shine-root)" style={{ pointerEvents: 'none', opacity: 0.35 }} />
                                </g>
                              </>
                            ) : openChordEm === 'chord-member' ? (
                              <g filter="url(#note-drop-secondary)">
                                <circle
                                  r={r}
                                  fill="#15232f"
                                  stroke="#38bdf8"
                                  strokeWidth={2.4}
                                  strokeOpacity={0.88}
                                />
                                <circle r={r * 0.88} fill="url(#note-shine-secondary)" style={{ pointerEvents: 'none', opacity: 0.4 }} />
                              </g>
                            ) : overlayOpenOnly ? (
                              <>
                                <circle
                                  r={r + 2}
                                  fill="none"
                                  stroke="#34d399"
                                  strokeWidth={1.6}
                                  strokeOpacity={0.65}
                                />
                                <circle
                                  r={r}
                                  fill="rgba(6,78,59,0.55)"
                                  stroke="#6ee7b7"
                                  strokeWidth={2}
                                  filter="url(#open-label-shadow)"
                                />
                              </>
                            ) : isRootOpen ? (
                              <>
                                <motion.circle
                                  r={r + 9}
                                  fill="none"
                                  stroke="#fbbf24"
                                  strokeWidth={2}
                                  animate={{ opacity: showOpenBadge ? [0.32, 0.78, 0.32] : 0.12 }}
                                  transition={{ duration: 2.7, repeat: Infinity, ease: 'easeInOut' }}
                                />
                                <g filter="url(#note-drop-root)">
                                  <circle
                                    r={r}
                                    fill="url(#note-fill-root)"
                                    stroke="url(#note-stroke-root)"
                                    strokeWidth={3}
                                    filter="url(#note-glow-root)"
                                  />
                                  <circle r={r * 0.9} fill="url(#note-shine-root)" style={{ pointerEvents: 'none' }} />
                                </g>
                              </>
                            ) : (
                              <g filter="url(#note-drop-secondary)">
                                <circle
                                  r={r}
                                  fill={showOpenBadge ? 'url(#note-fill-secondary)' : 'rgba(17,19,24,0.7)'}
                                  stroke={showOpenBadge ? 'url(#note-stroke-secondary)' : '#e2e8f0'}
                                  strokeOpacity={showOpenBadge ? 1 : 0.14}
                                  strokeWidth={2.2}
                                />
                                {showOpenBadge ? (
                                  <circle r={r * 0.88} fill="url(#note-shine-secondary)" style={{ pointerEvents: 'none' }} />
                                ) : null}
                              </g>
                            )}

                            <text
                              textAnchor="middle"
                              dominantBaseline="central"
                              y={1}
                              fill={
                                openChordEm === 'chord-dimmed'
                                  ? '#a1a1aa'
                                  : openChordEm === 'chord-root'
                                    ? '#f0f9ff'
                                    : openChordEm === 'chord-member'
                                      ? '#e0f2fe'
                                      : overlayOpenOnly
                                        ? '#ecfdf5'
                                        : isRootOpen
                                          ? '#fffef7'
                                          : '#f1f5f9'
                              }
                              style={{
                                fontSize: fs,
                                fontFamily: '"Plus Jakarta Sans", ui-sans-serif, system-ui, sans-serif',
                                fontWeight: isRootOpen ? 700 : 600,
                                textShadow:
                                  openChordEm === 'chord-root'
                                    ? '0 1px 0 rgba(0,0,0,0.65), 0 0 14px rgba(56,189,248,0.45)'
                                    : openChordEm === 'chord-member'
                                      ? '0 1px 0 rgba(0,0,0,0.65), 0 0 10px rgba(56,189,248,0.25)'
                                      : isRootOpen
                                        ? '0 1px 0 rgba(0,0,0,0.55), 0 0 10px rgba(180,83,9,0.4)'
                                        : '0 1px 0 rgba(0,0,0,0.65), 0 0 8px rgba(0,0,0,0.35)',
                                opacity:
                                  openChordEm === 'chord-dimmed'
                                    ? 0.55
                                    : showOpenBadge
                                      ? 1
                                      : 0.75,
                              }}
                            >
                              {text}
                            </text>
                          </g>
                        );
                      })()}
                    </motion.g>
                  </AnimatePresence>
                </g>
              );
            })}

            {capoBodyX !== null ? (
              <g pointerEvents="none" filter="url(#capo-shadow)">
                <rect
                  x={capoBodyX}
                  y={layout.boardTop - 16}
                  width={24}
                  height={layout.boardBottom - layout.boardTop + 32}
                  rx={12}
                  fill="url(#capo-body)"
                  stroke="#52525b"
                  strokeWidth={1.25}
                />
                <rect
                  x={capoBodyX + 3}
                  y={layout.boardTop - 10}
                  width={6}
                  height={layout.boardBottom - layout.boardTop + 20}
                  rx={3}
                  fill="#f8fafc"
                  opacity={0.16}
                />
              </g>
            ) : null}

            {/* Note markers — tokens move to new targets (no pop-in) */}
            {markerTokens.map((t) => {
              const m = t.marker;
              if (!m && !t.visible) {
                return null;
              }

              const overlayOnly = m?.overlayOnly ?? false;
              const isRootStyle = m?.isRootStyle ?? false;
              const showPentRing = m?.showPentRing ?? false;
              const label = m?.label ?? '';
              const chordEmphasis = m?.chordEmphasis;

              const r = isRootStyle ? 28 : 22;
              const rDisc = overlayOnly ? 20 : r + (isRootStyle ? 2 : 0);
              const short = label.replace(/#|b/g, '').length > 2 || label.length > 4;
              const fs = overlayOnly ? (short ? 12 : 14) : short ? 14 : isRootStyle ? 18 : 16;
              const textShadow = isRootStyle
                ? '0 1px 0 rgba(0,0,0,0.55), 0 0 12px rgba(180,83,9,0.45)'
                : '0 1px 0 rgba(0,0,0,0.65), 0 0 10px rgba(0,0,0,0.35)';
              const textShadowChordRoot =
                '0 1px 0 rgba(0,0,0,0.65), 0 0 14px rgba(56,189,248,0.45)';
              const textShadowChordMember =
                '0 1px 0 rgba(0,0,0,0.65), 0 0 10px rgba(56,189,248,0.25)';

              return (
                <motion.g
                  key={t.id}
                  initial={false}
                  animate={{
                    opacity: t.visible ? 1 : 0,
                    x: t.x,
                    y: t.y,
                    scale: t.visible ? 1 : 0.92,
                  }}
                  transition={{ x: NOTE_LAYOUT_SPRING, y: NOTE_LAYOUT_SPRING, opacity: { duration: 0.18 }, scale: NOTE_EXIT }}
                  style={{ transformOrigin: '0px 0px' }}
                >
                  {chordEmphasis === 'chord-dimmed' ? (
                    <>
                      {showPentRing ? (
                        <circle
                          r={rDisc + 5}
                          fill="none"
                          stroke="#34d399"
                          strokeWidth={2.2}
                          strokeOpacity={0.35}
                          style={{ pointerEvents: 'none' }}
                        />
                      ) : null}
                      <circle
                        r={rDisc}
                        fill="#0c0c0e"
                        stroke="#3f3f46"
                        strokeWidth={2}
                        opacity={0.72}
                      />
                      <text
                        textAnchor="middle"
                        dominantBaseline="central"
                        fill="#a1a1aa"
                        style={{
                          fontSize: fs,
                          fontFamily: '"Plus Jakarta Sans", ui-sans-serif, system-ui, sans-serif',
                          fontWeight: 600,
                          opacity: 0.55,
                        }}
                      >
                        {label}
                      </text>
                    </>
                  ) : chordEmphasis === 'chord-root' ? (
                    <>
                      {showPentRing ? (
                        <circle
                          r={rDisc + 5}
                          fill="none"
                          stroke="#34d399"
                          strokeWidth={2.2}
                          strokeOpacity={0.75}
                          style={{ pointerEvents: 'none' }}
                        />
                      ) : null}
                      <motion.circle
                        r={rDisc + 10}
                        fill="none"
                        stroke="#38bdf8"
                        strokeWidth={2.4}
                        animate={{ opacity: [0.38, 0.88, 0.38] }}
                        transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
                      />
                      {isRootStyle ? (
                        <motion.circle
                          r={rDisc + 6}
                          fill="none"
                          stroke="#fbbf24"
                          strokeWidth={1.8}
                          animate={{ opacity: [0.25, 0.55, 0.25] }}
                          transition={{ duration: 2.7, repeat: Infinity, ease: 'easeInOut' }}
                        />
                      ) : null}
                      <g filter="url(#note-drop-root)">
                        <circle
                          r={rDisc}
                          fill="#0c1924"
                          stroke="#7dd3fc"
                          strokeWidth={3.2}
                          filter="url(#note-glow-root)"
                          opacity={0.95}
                        />
                        <circle r={rDisc * 0.88} fill="url(#note-shine-root)" style={{ pointerEvents: 'none', opacity: 0.35 }} />
                      </g>
                      <text
                        textAnchor="middle"
                        dominantBaseline="central"
                        fill="#f0f9ff"
                        style={{
                          fontSize: fs,
                          fontFamily: '"Plus Jakarta Sans", ui-sans-serif, system-ui, sans-serif',
                          fontWeight: 700,
                          textShadow: textShadowChordRoot,
                        }}
                      >
                        {label}
                      </text>
                    </>
                  ) : chordEmphasis === 'chord-member' ? (
                    <>
                      {showPentRing ? (
                        <circle
                          r={rDisc + 5}
                          fill="none"
                          stroke="#34d399"
                          strokeWidth={2.2}
                          strokeOpacity={0.75}
                          style={{ pointerEvents: 'none' }}
                        />
                      ) : null}
                      <g filter="url(#note-drop-secondary)">
                        <circle
                          r={rDisc}
                          fill="#15232f"
                          stroke="#38bdf8"
                          strokeWidth={2.6}
                          strokeOpacity={0.88}
                        />
                        <circle r={rDisc * 0.88} fill="url(#note-shine-secondary)" style={{ pointerEvents: 'none', opacity: 0.4 }} />
                      </g>
                      <text
                        textAnchor="middle"
                        dominantBaseline="central"
                        fill="#e0f2fe"
                        style={{
                          fontSize: fs,
                          fontFamily: '"Plus Jakarta Sans", ui-sans-serif, system-ui, sans-serif',
                          fontWeight: 600,
                          textShadow: textShadowChordMember,
                        }}
                      >
                        {label}
                      </text>
                    </>
                  ) : overlayOnly ? (
                    <>
                      <circle
                        r={rDisc + 3}
                        fill="none"
                        stroke="#34d399"
                        strokeWidth={1.8}
                        strokeOpacity={0.65}
                      />
                      <circle
                        r={rDisc}
                        fill="rgba(6,78,59,0.55)"
                        stroke="#6ee7b7"
                        strokeWidth={2.2}
                      />
                      <text
                        textAnchor="middle"
                        dominantBaseline="central"
                        fill="#ecfdf5"
                        style={{
                          fontSize: fs,
                          fontFamily: '"Plus Jakarta Sans", ui-sans-serif, system-ui, sans-serif',
                          fontWeight: 600,
                          textShadow: '0 1px 0 rgba(0,0,0,0.7), 0 0 8px rgba(16,185,129,0.35)',
                        }}
                      >
                        {label}
                      </text>
                    </>
                  ) : (
                    <>
                      {showPentRing ? (
                        <circle
                          r={rDisc + 5}
                          fill="none"
                          stroke="#34d399"
                          strokeWidth={2.2}
                          strokeOpacity={0.75}
                          style={{ pointerEvents: 'none' }}
                        />
                      ) : null}
                      {isRootStyle ? (
                        <>
                          <motion.circle
                            r={rDisc + 9}
                            fill="none"
                            stroke="#fbbf24"
                            strokeWidth={2.2}
                            animate={{ opacity: [0.35, 0.82, 0.35] }}
                            transition={{ duration: 2.7, repeat: Infinity, ease: 'easeInOut' }}
                          />
                          <g filter="url(#note-drop-root)">
                            <circle
                              r={rDisc}
                              fill="url(#note-fill-root)"
                              stroke="url(#note-stroke-root)"
                              strokeWidth={3.2}
                              filter="url(#note-glow-root)"
                            />
                            <circle r={rDisc * 0.9} fill="url(#note-shine-root)" style={{ pointerEvents: 'none' }} />
                          </g>
                        </>
                      ) : (
                        <g filter="url(#note-drop-secondary)">
                          <circle
                            r={rDisc}
                            fill="url(#note-fill-secondary)"
                            stroke="url(#note-stroke-secondary)"
                            strokeWidth={2.35}
                          />
                          <circle r={rDisc * 0.88} fill="url(#note-shine-secondary)" style={{ pointerEvents: 'none' }} />
                        </g>
                      )}
                      <text
                        textAnchor="middle"
                        dominantBaseline="central"
                        fill={isRootStyle ? '#fffef7' : '#f1f5f9'}
                        style={{
                          fontSize: fs,
                          fontFamily: '"Plus Jakarta Sans", ui-sans-serif, system-ui, sans-serif',
                          fontWeight: isRootStyle ? 700 : 600,
                          textShadow,
                        }}
                      >
                        {label}
                      </text>
                    </>
                  )}
                </motion.g>
              );
            })}

          </motion.svg>
  );
}

/**
 * The media-session poller re-renders the chassis roughly every 1.5s with a fresh playback
 * position. The neck's props do not change with it, so the whole SVG stays out of that pass.
 */
export const Fretboard = memo(FretboardView);
