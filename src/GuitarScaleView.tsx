import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  SCALE_TYPES_ORDERED,
  SCALE_TYPE_LABELS,
  type ScaleContext,
  type ScaleType,
} from './scaleDataProvider';
import { ChordLibrarySection } from './ChordLibrarySection';
import type { ScaleChordWithVoicings } from './chords/chordTypes';
import {
  SCALE_DEFINITIONS,
  SCALE_DEGREE_LABELS,
  buildScaleNotes,
  labelForPitchClass,
  pitchClassSet,
  type ScaleNote,
} from './scaleSpell';
import { TUNING_PRESETS } from './tunings';
import { useMediaSession } from './hooks/useMediaSession';
import { useDetectedKey, type DetectedKeyAbState, type DetectedKeyState } from './hooks/useDetectedKey';
import { useCloudKeyResolution } from './hooks/useCloudKeyResolution';
import {
  getFreqblogApiKeyForDev,
  getGetSongBpmApiKeyForDev,
  getSongKeyApiBaseForDev,
  setFreqblogApiKeyForDev,
  setGetSongBpmApiKeyForDev,
  setSongKeyApiBaseForDev,
} from './services/songKeyApi';

/** Open + 24 fretted positions (extend via props later). */
const DEFAULT_NUM_FRETS = 24;

type Props = {
  scale: ScaleContext;
  rootInput: string;
  onRootInputChange: (value: string) => void;
  rootInvalid: boolean;
  scaleType: ScaleType;
  onScaleTypeChange: (value: ScaleType) => void;
  /** Restore root + scale from the brain / engine defaults (see scaleDataProvider). */
  onResetToBrainKey: () => void;
  onApplyDetectedKey: (root: string, scale: 'major' | 'minor') => void;
  numFrets?: number;
};

type FretboardViewMode =
  | 'scale-all'
  | 'scale-plus-pentatonic'
  | 'root-only'
  | 'triads'
  | 'chromatic';

const ALL_PITCH_CLASS_SET = new Set<number>([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

const CHROMATIC_LABELS: readonly string[] = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
];
const SUGGEST_KEYS: readonly string[] = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function labelChromatic(pc: number): string {
  return CHROMATIC_LABELS[pc] ?? '';
}

function mediaPlaybackDisplayLabel(status: string): string {
  const labels: Record<string, string> = {
    playing: 'Playing',
    paused: 'Paused',
    stopped: 'Stopped',
    none: 'No media',
    closed: 'Closed',
    opened: 'Opened',
    changing: 'Changing',
    unknown: 'Unknown',
    media_session_unavailable: 'Media session unavailable',
  };
  return labels[status] ?? status;
}

function detectionStateLabel(state: string): string {
  const labels: Record<string, string> = {
    warming_up: 'Warming up',
    listening: 'Listening',
    likely_key: 'Likely key',
    ambiguous: 'Ambiguous',
    paused_hold: 'Paused (holding last stable key)',
    unavailable: 'Unavailable',
  };
  return labels[state] ?? state;
}

function captureModeLabel(mode: string): string {
  const labels: Record<string, string> = {
    process_loopback: 'Process loopback',
    endpoint_loopback: 'System loopback fallback',
    unavailable: 'Unavailable',
  };
  return labels[mode] ?? mode;
}

function resolutionStateLabel(state: string): string {
  const labels: Record<string, string> = {
    no_session: 'No active session',
    paused: 'Paused',
    cloud_lookup: 'Checking cloud database and catalogs',
    cloud_hit: 'Verified key found',
    catalog_hit: 'Catalog key found',
    cloud_miss_local_detecting: 'No catalog key, detecting locally',
    local_detecting: 'Local detection fallback',
    ready: 'Ready',
    ambiguous: 'Ambiguous',
    error: 'Error',
  };
  return labels[state] ?? state;
}

function abLine(label: string, result: DetectedKeyAbState['current']): string {
  if (result.error) {
    return `${label}: error (${result.error})`;
  }
  const name = result.displayName ?? '—';
  const sharePct = Number.isFinite(result.share) ? Math.round(result.share * 100) : 0;
  return `${label}: ${name} (${sharePct}%, ${result.latencyMs}ms)`;
}

function detectionReasonLabel(reason: string | null): string {
  if (!reason) {
    return 'Waiting for stable detection evidence.';
  }
  const labels: Record<string, string> = {
    warming_up: 'Warming up and collecting enough audio.',
    no_active_session: 'No active media session.',
    media_session_unavailable: 'Media session unavailable.',
    playback_paused: 'Playback is paused.',
    paused_holding_last_good_detection:
      'Playback paused: preserving last stable detection for a short grace period.',
    recent_silence_holding_last_good_detection:
      'Recent silence detected: preserving last stable detection for a short grace period.',
    paused_hold_last_good_apply_grace:
      'Playback paused/silent: Apply remains available briefly from last stable detection.',
    smtc_reported_paused_but_audio_active:
      'SMTC reported paused, but audio is still active (treating as listening).',
    capture_not_ready: 'Audio capture not ready yet.',
    collecting_audio_for_first_window: 'Collecting enough audio for the first analysis window (about 12s).',
    analysis_error: 'Analyzer unavailable or failed to respond.',
    no_analysis_windows: 'Analyzer did not return usable windows.',
    top_candidate_too_close_to_alternative: 'Top key is too close to alternatives.',
    unstable_across_windows: 'Key candidates are unstable across windows.',
    low_confidence: 'Confidence is too low.',
    candidate_switch_unstable: 'Recent key switch is not stable yet.',
    waiting_for_stability_confirmation: 'Waiting for repeated stable detections.',
    insufficient_consensus_for_likely_key: 'Consensus is not strong enough yet.',
    contradiction_detected_multiple_tonics: 'Contradiction detected: multiple tonic centers in recent horizon.',
    contradiction_detected_major_minor_conflict: 'Contradiction detected: major/minor identity conflict.',
    contradiction_detected_profile_disagreement: 'Contradiction detected: profile disagreement across windows.',
    contradiction_detected_mixed_tonic_family:
      'Contradiction detected: mixed tonic family in recent horizon (not clean enough yet).',
    relative_pair_ambiguity:
      'Relative major/minor ambiguity detected; waiting for clearer minor/major center evidence.',
    relative_pair_minor_center_selected:
      'Relative pair detected; minor center selected by structural evidence.',
    recent_capture_silence_detected:
      'Recent audio capture is silent; waiting for reliable non-silent capture before promotion.',
    apply_blocked_numpy_fallback_requires_essentia:
      'Apply blocked: fallback backend is active; waiting for stable Essentia evidence.',
    apply_blocked: 'Apply blocked: waiting for cleaner and more stable agreement.',
    gating_denied: 'Likely-key blocked: recent windows are still contradictory or unstable.',
  };
  let key = reason;
  if (reason.startsWith('analysis_error')) {
    key = 'analysis_error';
  } else if (reason.startsWith('gating_denied')) {
    key = 'gating_denied';
  } else if (reason.startsWith('apply_blocked')) {
    key = 'apply_blocked';
  } else if (reason.startsWith('insufficient_consensus_for_likely_key')) {
    key = 'insufficient_consensus_for_likely_key';
  } else if (reason.startsWith('waiting_for_stability_confirmation')) {
    key = 'waiting_for_stability_confirmation';
  } else if (reason.startsWith('relative_pair_ambiguity')) {
    key = 'relative_pair_ambiguity';
  } else if (reason.startsWith('relative_pair_minor_center_selected')) {
    key = 'relative_pair_minor_center_selected';
  } else if (reason.startsWith('paused_holding_last_good_detection')) {
    key = 'paused_holding_last_good_detection';
  } else if (reason.startsWith('recent_silence_holding_last_good_detection')) {
    key = 'recent_silence_holding_last_good_detection';
  } else if (reason.startsWith('paused_hold_last_good_apply_grace')) {
    key = 'paused_hold_last_good_apply_grace';
  }
  return labels[key] ?? reason.replaceAll('_', ' ');
}

/** The other pentatonic on the same root (major ↔ minor), or by tonality (M3 vs m3) for heptatonic scales. */
function pentatonicCompanionType(scaleType: ScaleType): 'pentatonic-major' | 'pentatonic-minor' {
  if (scaleType === 'pentatonic-major') {
    return 'pentatonic-minor';
  }
  if (scaleType === 'pentatonic-minor') {
    return 'pentatonic-major';
  }
  const third = SCALE_DEFINITIONS[scaleType].intervals[2];
  return third === 4 ? 'pentatonic-minor' : 'pentatonic-major';
}

/** Tonic triad: root + minor or major 3rd present in scale + P5. */
function triadPitchClassSet(notes: ScaleNote[]): Set<number> {
  const rootPc = notes[0]?.pitchClass;
  if (rootPc === undefined) {
    return new Set();
  }
  const set = new Set<number>([rootPc]);
  const thirdMinor = (rootPc + 3) % 12;
  const thirdMajor = (rootPc + 4) % 12;
  const thirdNote =
    notes.find((n) => n.pitchClass === thirdMinor) ??
    notes.find((n) => n.pitchClass === thirdMajor);
  if (thirdNote) {
    set.add(thirdNote.pitchClass);
  }
  const fifth = notes.find((n) => n.pitchClass === (rootPc + 7) % 12);
  if (fifth) {
    set.add(fifth.pitchClass);
  }
  return set;
}

function mainPitchClassSet(mode: FretboardViewMode, notes: ScaleNote[]): Set<number> {
  if (mode === 'chromatic') {
    return ALL_PITCH_CLASS_SET;
  }
  if (mode === 'scale-all' || mode === 'scale-plus-pentatonic') {
    return pitchClassSet(notes);
  }
  if (mode === 'root-only') {
    const r = notes[0]?.pitchClass;
    return r === undefined ? new Set() : new Set([r]);
  }
  return triadPitchClassSet(notes);
}

function pitchAtFret(openStringPcs: readonly number[], stringIndex: number, fret: number): number {
  const open = openStringPcs[stringIndex];
  if (open === undefined) {
    throw new Error(`Invalid string index: ${stringIndex}`);
  }
  return (open + fret) % 12;
}

type FretPoint = {
  stringIndex: number;
  fret: number;
  x: number;
  y: number;
};

/**
 * Equal-temperament fret positions from the nut (12-TET).
 * s[k] = distance from nut to the k-th fret wire; s[0] = 0.
 */
function fretDistancesFromNut(numFrets: number, nutToLastFretWire: number): number[] {
  const denom = 1 - Math.pow(2, -numFrets / 12);
  const scaleLength = nutToLastFretWire / denom;
  const s: number[] = [0];
  for (let k = 1; k <= numFrets; k++) {
    s.push(scaleLength * (1 - Math.pow(2, -k / 12)));
  }
  return s;
}

/**
 * Horizontal center for a scale dot: musical fret `fret` (0 = open).
 * `s[k]` = distance from nut face to k-th fret wire; wires are drawn at `leftPad + nutW + s[k]`.
 * Fret N slot lies between wire N-1 and wire N, so its center is midpoint of those distances.
 */
function fretMarkerCenterX(leftPad: number, nutW: number, s: number[], fret: number): number {
  if (fret === 0) {
    const s1 = s[1];
    if (s1 === undefined) {
      return leftPad + nutW * 0.5;
    }
    // Open string: left third of first fret slot (clearly left of fret-1 center, not on the nut bar)
    return leftPad + nutW + s1 * 0.26;
  }
  const leftWire = s[fret - 1];
  const rightWire = s[fret];
  if (leftWire === undefined || rightWire === undefined) {
    return leftPad + nutW;
  }
  return leftPad + nutW + (leftWire + rightWire) / 2;
}

/** Extra “virtual” frets past the last playable fret — continues toward the bridge / off-screen. */
function computeGhostFretWireXs(
  numFrets: number,
  nutToLastFretWire: number,
  leftPad: number,
  nutW: number,
  count: number,
): number[] {
  const denom = 1 - Math.pow(2, -numFrets / 12);
  const scaleLength = nutToLastFretWire / denom;
  const xs: number[] = [];
  for (let k = numFrets + 1; k <= numFrets + count; k++) {
    const sk = scaleLength * (1 - Math.pow(2, -k / 12));
    xs.push(leftPad + nutW + sk);
  }
  return xs;
}

function buildLayout(numFrets: number): {
  nutW: number;
  stringGap: number;
  topPad: number;
  leftPad: number;
  bottomPad: number;
  boardTop: number;
  boardBottom: number;
  height: number;
  width: number;
  /** Baseline Y for fret number labels (above the fretboard). */
  fretNumberBaselineY: number;
  /** Distance from nut edge to last fret wire (SVG units). */
  lastWireFromNut: number;
  fretCenters: number[];
  stringYs: number[];
  fretWireXs: number[];
  /** X of each ghost fret wire (beyond playable frets). */
  ghostFretWireXs: number[];
  /** X where playable neck ends (last real fret wire). */
  neckEndX: number;
  /** Right edge of finished binding / face. */
  boardFaceRightX: number;
  /** Right edge for ghost frets and string span. */
  boardRightX: number;
} {
  const nutW = 82;
  const stringGap = 80;
  const topPad = 104;
  const leftPad = 146;
  const bottomPad = 58;
  const boardTop = topPad;
  const boardBottom = topPad + stringGap * 5;
  /** Fret numbers sit above the binding (wood ~boardTop − 18). */
  const fretNumberBaselineY = boardTop - 42;
  const height = boardBottom + bottomPad;

  /** Horizontal span (nut → last fret) — larger units → bigger on-screen neck. */
  const nutToBridgeFrets = 102 * numFrets;
  const s = fretDistancesFromNut(numFrets, nutToBridgeFrets);

  const GHOST_FRET_COUNT = 5;
  const ghostFretWireXs = computeGhostFretWireXs(
    numFrets,
    nutToBridgeFrets,
    leftPad,
    nutW,
    GHOST_FRET_COUNT,
  );

  const fretWireXs: number[] = [];
  for (let k = 1; k <= numFrets; k++) {
    const sk = s[k];
    if (sk === undefined) {
      throw new Error('Fret geometry mismatch');
    }
    fretWireXs.push(leftPad + nutW + sk);
  }

  const fretCenters: number[] = [];
  for (let fret = 0; fret <= numFrets; fret++) {
    fretCenters.push(fretMarkerCenterX(leftPad, nutW, s, fret));
  }

  const lastWire = s[numFrets];
  if (lastWire === undefined) {
    throw new Error('Fret geometry mismatch');
  }
  const neckEndX = leftPad + nutW + lastWire;
  const lastGhostX = ghostFretWireXs[ghostFretWireXs.length - 1];
  if (lastGhostX === undefined) {
    throw new Error('Ghost fret geometry mismatch');
  }
  /** Binding/wood face extends slightly past the last fret wire. */
  const boardFaceRightX = neckEndX + 14;
  const boardRightX = Math.min(lastGhostX + 36, neckEndX + 118);
  /** ViewBox width: neck + right padding. */
  const width = neckEndX + 48;

  /**
   * Player view: 6th string (low E) at top → 1st string (high E) at bottom.
   * Index 0 = low E, 1 = A (second from top), … 5 = high E.
   */
  const stringYs = Array.from({ length: 6 }, (_, sIdx) => topPad + sIdx * stringGap);

  return {
    nutW,
    stringGap,
    topPad,
    leftPad,
    bottomPad,
    boardTop,
    boardBottom,
    height,
    width,
    fretNumberBaselineY,
    lastWireFromNut: lastWire,
    fretCenters,
    stringYs,
    fretWireXs,
    ghostFretWireXs,
    neckEndX,
    boardFaceRightX,
    boardRightX,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Capo: crop + zoom window; center the slice (capo wire → last fret) when possible.
 * Tuning sits left of the wire — view width must span from ~(wireX − minSpaceLeftOfWire) to layout.width
 * or fret 24 / the bridge edge is clipped (common at capo 1–3 with a fixed zoom fraction).
 */
const CAPO_CAMERA = {
  viewWidthFraction: 0.74,
  minViewWidth: 1000,
  /** ViewBox left edge x must be ≤ wireX − this so tuning pills stay visible. */
  minSpaceLeftOfWire: 215,
  /** From this capo fret upward, viewBox width (zoom) matches capo 9 — only panning changes. */
  zoomLockFromCapo: 9,
} as const;

/** Zoom level only — same formulas as buildCameraWindow for a given capo fret index. */
function capoViewWidthForZoom(layout: ReturnType<typeof buildLayout>, capo: number): number {
  const W = layout.width;
  const wireX = layout.fretWireXs[capo - 1] ?? layout.leftPad + layout.nutW;
  const { neckEndX } = layout;
  const left = CAPO_CAMERA.minSpaceLeftOfWire;

  const minSpan = W - wireX + left;

  let viewW = Math.round(W * CAPO_CAMERA.viewWidthFraction);
  viewW = Math.max(viewW, CAPO_CAMERA.minViewWidth, Math.ceil(minSpan));
  viewW = Math.min(viewW, W - 1);

  const sliceCenter = (wireX + neckEndX) / 2;

  if (capo >= 6) {
    const maxWForCenter = 2 * (W - sliceCenter);
    if (Number.isFinite(maxWForCenter) && maxWForCenter > 0) {
      const capped = Math.min(viewW, Math.ceil(maxWForCenter));
      viewW = Math.max(Math.ceil(minSpan), capped);
      viewW = Math.min(viewW, W - 1);
    }
  }

  return viewW;
}

function buildCameraWindow(
  layout: ReturnType<typeof buildLayout>,
  capo: number,
): { x: number; width: number } {
  if (capo <= 0) {
    return { x: 0, width: layout.width };
  }

  const W = layout.width;
  const wireX = layout.fretWireXs[capo - 1] ?? layout.leftPad + layout.nutW;
  const { neckEndX } = layout;
  const left = CAPO_CAMERA.minSpaceLeftOfWire;

  const zoomCapo =
    capo >= CAPO_CAMERA.zoomLockFromCapo &&
    layout.fretWireXs[CAPO_CAMERA.zoomLockFromCapo - 1] !== undefined
      ? CAPO_CAMERA.zoomLockFromCapo
      : capo;
  let viewW = capoViewWidthForZoom(layout, zoomCapo);

  const sliceCenter = (wireX + neckEndX) / 2;

  const maxX = W - viewW;
  const xMin = Math.max(0, W - viewW);
  const xMax = Math.min(Math.max(0, wireX - left), maxX);

  let x = sliceCenter - viewW / 2;
  x = clamp(x, xMin, xMax);

  // Should not happen if viewW ≥ minSpan; fallback to full width.
  if (xMin > xMax) {
    viewW = W - 1;
    const maxX2 = W - viewW;
    const xMin2 = Math.max(0, W - viewW);
    const xMax2 = Math.min(Math.max(0, wireX - left), maxX2);
    x = clamp(sliceCenter - viewW / 2, xMin2, xMax2);
  }

  return { x, width: viewW };
}

function getCapoBodyX(layout: ReturnType<typeof buildLayout>, capo: number): number | null {
  if (capo <= 0) {
    return null;
  }
  const wireX = layout.fretWireXs[capo - 1];
  if (wireX === undefined) {
    return null;
  }
  return wireX - 22;
}

/** Typical side dots on a 24-fret neck (12 & 24 as double inlays in render). */
const FRET_MARKER_FRETS = new Set([3, 5, 7, 9, 12, 15, 17, 19, 21, 24]);

/** Gentle exit so dots don’t pop off the neck. */
const NOTE_EXIT = { type: 'spring' as const, stiffness: 380, damping: 38, mass: 0.65 };
const NOTE_LAYOUT_SPRING = { type: 'spring' as const, stiffness: 340, damping: 36 };

type ChordEmphasis = 'chord-root' | 'chord-member' | 'chord-dimmed';

type RenderMarker = {
  x: number;
  y: number;
  label: string;
  isRootStyle: boolean;
  overlayOnly: boolean;
  showPentRing: boolean;
  pitchClass: number;
  chordEmphasis?: ChordEmphasis;
};

type MarkerToken = {
  id: string;
  x: number;
  y: number;
  visible: boolean;
  marker: RenderMarker | null;
};

function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

function ScaleKeyStrip({ notes, scaleType }: { notes: ScaleNote[]; scaleType: ScaleType }) {
  const degreeLabels = SCALE_DEGREE_LABELS[scaleType];
  const n = notes.length;
  return (
    <div
      className="mb-2 grid w-full max-w-5xl justify-items-stretch gap-x-1 gap-y-3 px-1 sm:mb-3 sm:gap-x-2 md:mx-auto md:max-w-6xl"
      style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
      aria-label="Scale notes in the key"
    >
      {notes.map((note, degreeIndex) => (
        <motion.div
          key={`pc-${note.pitchClass}`}
          layout
          initial={false}
          animate={{ opacity: 1, y: 0 }}
          transition={{
            layout: NOTE_LAYOUT_SPRING,
            opacity: { duration: 0.2 },
            y: NOTE_LAYOUT_SPRING,
          }}
          className="flex min-w-0 flex-col items-center gap-1 sm:gap-1.5"
        >
          <motion.span
            layout
            initial={false}
            transition={NOTE_LAYOUT_SPRING}
            className={`block w-full min-w-0 truncate text-center text-base font-bold tabular-nums sm:text-lg md:text-xl ${
              note.isRoot
                ? 'rounded-2xl border-2 border-sky-400/95 bg-[#0a1622]/95 px-1.5 py-2 text-sky-100 shadow-[0_4px_24px_rgba(56,189,248,0.22),0_2px_12px_rgba(0,0,0,0.5)] sm:rounded-3xl sm:px-2 sm:py-2.5 md:py-3'
                : 'rounded-2xl border border-indigo-400/35 bg-[#12101f]/85 px-1.5 py-2 font-semibold text-indigo-100/95 shadow-[0_2px_16px_rgba(0,0,0,0.4)] sm:rounded-3xl sm:px-2 sm:py-2.5 md:py-3'
            }`}
          >
            {note.label}
          </motion.span>
          <motion.span
            layout
            initial={false}
            className="w-full min-w-0 select-none truncate text-center text-[0.65rem] font-semibold leading-none tracking-wide text-indigo-300/55 sm:text-xs md:text-sm"
            transition={NOTE_LAYOUT_SPRING}
          >
            {degreeLabels[degreeIndex] ?? ''}
          </motion.span>
        </motion.div>
      ))}
    </div>
  );
}

export default function GuitarScaleView({
  scale,
  rootInput,
  onRootInputChange,
  rootInvalid,
  scaleType,
  onScaleTypeChange,
  onResetToBrainKey,
  onApplyDetectedKey,
  numFrets = DEFAULT_NUM_FRETS,
}: Props) {
  const [viewMode, setViewMode] = useState<FretboardViewMode>('scale-all');
  const [tuningId, setTuningId] = useState<string>('standard');
  const [capoFret, setCapoFret] = useState<number>(0);
  const [selectedChord, setSelectedChord] = useState<ScaleChordWithVoicings | null>(null);
  const [lockDetected, setLockDetected] = useState(false);
  const [lockedDetectedSnapshot, setLockedDetectedSnapshot] = useState<DetectedKeyState | null>(null);
  const [autoApplyEnabled, setAutoApplyEnabled] = useState(false);
  const [autoApplyConfidencePct, setAutoApplyConfidencePct] = useState(85);
  const [suggestKey, setSuggestKey] = useState('C');
  const [suggestMode, setSuggestMode] = useState<'major' | 'minor'>('major');
  const [devMockEnabled, setDevMockEnabled] = useState(false);
  const [devMockTitle, setDevMockTitle] = useState('Numb');
  const [devMockArtist, setDevMockArtist] = useState('Linkin Park');
  const [devApiBaseInput, setDevApiBaseInput] = useState(getSongKeyApiBaseForDev());
  const [devFreqblogKeyInput, setDevFreqblogKeyInput] = useState(getFreqblogApiKeyForDev());
  const [devGetSongBpmKeyInput, setDevGetSongBpmKeyInput] = useState(getGetSongBpmApiKeyForDev());
  const lastAutoAppliedSignatureRef = useRef<string | null>(null);
  const mediaSession = useMediaSession();
  const { detectedKey, detectedKeyAb, resetDetection } = useDetectedKey();
  const cloudMediaInput = useMemo(
    () =>
      devMockEnabled
        ? {
            ...mediaSession,
            title: devMockTitle.trim() || mediaSession.title,
            artist: devMockArtist.trim() || mediaSession.artist,
            playbackStatus: 'playing',
          }
        : mediaSession,
    [devMockArtist, devMockEnabled, devMockTitle, mediaSession],
  );
  const cloudResolution = useCloudKeyResolution(cloudMediaInput, detectedKey);
  const effectiveDetectedKey = lockDetected && lockedDetectedSnapshot ? lockedDetectedSnapshot : detectedKey;
  const activePrimaryKey = cloudResolution.cloudHit?.key ?? effectiveDetectedKey.primaryKey;
  const activePrimaryScale = cloudResolution.cloudHit?.mode ?? effectiveDetectedKey.primaryScale;
  const activeDisplayName = cloudResolution.cloudHit?.displayName ?? effectiveDetectedKey.displayName;

  const settingsPanelRef = useRef<HTMLDivElement>(null);
  /** Padding so fretboard + scale strip start below the fixed settings card (updates with resize / layout). */
  const [fretboardSectionPaddingTopPx, setFretboardSectionPaddingTopPx] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = settingsPanelRef.current;
    if (!el) {
      return;
    }

    const gapBelowPanel = 60;

    const update = () => {
      const bottom = el.getBoundingClientRect().bottom;
      setFretboardSectionPaddingTopPx(Math.max(0, Math.round(bottom + gapBelowPanel)));
    };

    update();

    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener('resize', update);

    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', update);
      vv.addEventListener('scroll', update);
    }

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
      if (vv) {
        vv.removeEventListener('resize', update);
        vv.removeEventListener('scroll', update);
      }
    };
  }, []);

  useEffect(() => {
    setSelectedChord(null);
  }, [scale.root, scale.scaleType]);

  const tuning = useMemo(() => {
    return TUNING_PRESETS.find((t) => t.id === tuningId) ?? TUNING_PRESETS[0]!;
  }, [tuningId]);
  const openStringPcs = tuning.openStringPcs;
  const stringLabels = tuning.stringLabels;
  const capo = Math.max(0, Math.min(12, capoFret));

  const notes = useMemo(() => buildScaleNotes(scale.root, scale.scaleType), [scale.root, scale.scaleType]);
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
        ? buildScaleNotes(scale.root, pentatonicCompanionType(scale.scaleType))
        : [],
    [viewMode, scale.root, scale.scaleType],
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

  const title = scale.title || `${scale.root} ${scale.scaleType}`;
  const handleRestoreDefault = () => {
    onResetToBrainKey();
    setTuningId('standard');
    setCapoFret(0);
    setSelectedChord(null);
  };

  const hasDetectedApplyCandidate =
    !!activePrimaryKey && (activePrimaryScale === 'major' || activePrimaryScale === 'minor');

  const canApplyDetected = hasDetectedApplyCandidate;

  const handleApplyDetected = () => {
    if (!hasDetectedApplyCandidate || !activePrimaryKey || !activePrimaryScale) {
      return;
    }
    const scale = activePrimaryScale;
    if (scale !== 'major' && scale !== 'minor') {
      return;
    }
    onApplyDetectedKey(activePrimaryKey, scale);
  };

  const toggleLockDetected = () => {
    if (lockDetected) {
      setLockDetected(false);
      setLockedDetectedSnapshot(null);
      return;
    }
    setLockedDetectedSnapshot(detectedKey);
    setLockDetected(true);
  };

  useEffect(() => {
    if (!autoApplyEnabled || !hasDetectedApplyCandidate) {
      if (!autoApplyEnabled) {
        lastAutoAppliedSignatureRef.current = null;
      }
      return;
    }
    const scale = activePrimaryScale;
    if ((scale !== 'major' && scale !== 'minor') || !activePrimaryKey) {
      return;
    }
    const currentConfidencePct = cloudResolution.cloudHit ? 100 : Math.round(effectiveDetectedKey.confidence * 100);
    if (currentConfidencePct < autoApplyConfidencePct) {
      return;
    }
    const signature = `${activePrimaryKey}:${scale}`;
    if (lastAutoAppliedSignatureRef.current === signature) {
      return;
    }
    onApplyDetectedKey(activePrimaryKey, scale);
    lastAutoAppliedSignatureRef.current = signature;
  }, [
    activePrimaryKey,
    activePrimaryScale,
    cloudResolution.cloudHit,
    autoApplyEnabled,
    autoApplyConfidencePct,
    effectiveDetectedKey.confidence,
    hasDetectedApplyCandidate,
    onApplyDetectedKey,
  ]);

  return (
    <div className="relative flex min-h-[100dvh] flex-1 flex-col overflow-x-visible text-zinc-100">
      <div
        className="pointer-events-none fixed inset-0 -z-20 bg-[#060607]"
        aria-hidden
      />
      <div
        className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(ellipse_100%_60%_at_50%_-15%,rgba(120,113,255,0.09),transparent_55%)]"
        aria-hidden
      />
      <div
        className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(ellipse_70%_45%_at_100%_30%,rgba(245,158,11,0.05),transparent_50%)]"
        aria-hidden
      />
      <div
        className="pointer-events-none fixed inset-0 -z-10 bg-gradient-to-b from-transparent via-transparent to-black/40"
        aria-hidden
      />

      <div
        ref={settingsPanelRef}
        className="fixed left-3 right-3 top-3 z-40 sm:left-6 sm:right-6 sm:top-4 lg:left-10 lg:right-10"
      >
        <div className="rounded-2xl border border-white/[0.07] bg-zinc-950/[0.72] p-4 shadow-[0_24px_80px_-20px_rgba(0,0,0,0.85),inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-2xl sm:rounded-[1.25rem] sm:p-5">
          <div className="flex w-full min-w-0 flex-col gap-5 sm:flex-row sm:flex-wrap sm:items-end sm:gap-x-8 sm:gap-y-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-500">
                Root
              </span>
              <input
                type="text"
                value={rootInput}
                onChange={(e) => onRootInputChange(e.target.value)}
                placeholder="A, C#, Bb…"
                spellCheck={false}
                className={`w-full min-w-[8rem] rounded-xl border border-zinc-800/90 bg-zinc-900/70 px-4 py-3.5 text-2xl font-semibold tracking-tight text-zinc-50 shadow-[inset_0_2px_6px_rgba(0,0,0,0.35)] outline-none ring-0 transition placeholder:text-zinc-600 focus:border-amber-500/40 focus:ring-2 focus:ring-amber-500/15 sm:w-[7.25rem] sm:text-3xl sm:py-4 ${
                  rootInvalid
                    ? 'border-red-500/50 focus:border-red-400/55 focus:ring-red-500/20'
                    : ''
                }`}
                aria-invalid={rootInvalid}
              />
              {rootInvalid ? (
                <span className="text-xs font-medium text-red-400/90">Use A–G with # or b only</span>
              ) : null}
            </label>

            <label className="flex w-full min-w-0 flex-col gap-1.5 sm:w-[min(100%,28rem)] sm:min-w-[20rem] sm:max-w-[28rem] lg:min-w-[28rem]">
              <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-500">
                Scale
              </span>
              <div className="relative w-full min-w-0">
                <select
                  value={scaleType}
                  onChange={(e) => onScaleTypeChange(e.target.value as ScaleType)}
                  className="w-full min-w-0 cursor-pointer appearance-none rounded-xl border border-zinc-800/90 bg-zinc-900/70 py-3.5 pl-4 pr-12 text-lg font-medium text-zinc-100 shadow-[inset_0_2px_6px_rgba(0,0,0,0.35)] outline-none transition focus:border-amber-500/40 focus:ring-2 focus:ring-amber-500/15 sm:py-4 sm:text-xl lg:text-2xl"
                  aria-label="Scale type"
                >
                  {SCALE_TYPES_ORDERED.map((t) => (
                    <option key={t} value={t}>
                      {SCALE_TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
                <span
                  className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-zinc-500"
                  aria-hidden
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </span>
              </div>
            </label>

            <label className="flex w-full min-w-0 flex-col gap-1.5 sm:w-[min(100%,24rem)] sm:min-w-[16rem] sm:max-w-[24rem] lg:min-w-[22rem]">
              <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-500">
                Tuning
              </span>
              <div className="relative w-full min-w-0">
                <select
                  value={tuningId}
                  onChange={(e) => setTuningId(e.target.value)}
                  className="w-full min-w-0 cursor-pointer appearance-none rounded-xl border border-zinc-800/90 bg-zinc-900/70 py-3.5 pl-4 pr-12 text-lg font-medium text-zinc-100 shadow-[inset_0_2px_6px_rgba(0,0,0,0.35)] outline-none transition focus:border-amber-500/40 focus:ring-2 focus:ring-amber-500/15 sm:py-4 sm:text-xl lg:text-2xl"
                  aria-label="Guitar tuning"
                >
                  {TUNING_PRESETS.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <span
                  className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-zinc-500"
                  aria-hidden
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </span>
              </div>
            </label>

            <label className="flex w-full min-w-0 flex-col gap-1.5 sm:w-[min(100%,14rem)] sm:min-w-[10rem] sm:max-w-[14rem]">
              <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-500">
                Capo
              </span>
              <div className="relative w-full min-w-0">
                <select
                  value={capoFret}
                  onChange={(e) => setCapoFret(Number(e.target.value))}
                  className="w-full min-w-0 cursor-pointer appearance-none rounded-xl border border-zinc-800/90 bg-zinc-900/70 py-3.5 pl-4 pr-12 text-lg font-medium text-zinc-100 shadow-[inset_0_2px_6px_rgba(0,0,0,0.35)] outline-none transition focus:border-amber-500/40 focus:ring-2 focus:ring-amber-500/15 sm:py-4 sm:text-xl"
                  aria-label="Capo fret"
                >
                  {Array.from({ length: 13 }, (_, i) => (
                    <option key={i} value={i}>
                      {i === 0 ? 'None' : `Fret ${i}`}
                    </option>
                  ))}
                </select>
                <span
                  className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-zinc-500"
                  aria-hidden
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </span>
              </div>
            </label>

            <div className="flex flex-col gap-1.5 sm:shrink-0">
              <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-500">
                Preset
              </span>
              <motion.button
                type="button"
                onClick={handleRestoreDefault}
                aria-label="Restore root and scale from brain defaults"
                whileTap={{ scale: 0.97 }}
                transition={{ type: 'spring', stiffness: 520, damping: 32 }}
                className="rounded-xl border border-zinc-700/80 bg-zinc-900/50 px-5 py-3.5 text-sm font-semibold text-zinc-200 shadow-sm outline-none transition hover:border-zinc-600 hover:bg-zinc-800/60 hover:text-white focus-visible:ring-2 focus-visible:ring-amber-500/25 sm:py-4 sm:text-base"
              >
                Restore default
              </motion.button>
            </div>
          </div>

          <div
            className="mt-4 rounded-xl border border-white/[0.06] bg-zinc-900/30 px-3.5 py-2.5 sm:mt-5 sm:px-4"
            aria-live="polite"
          >
            <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-500">
              Now playing
            </div>
            {mediaSession.playbackStatus === 'media_session_unavailable' ? (
              <p className="mt-1 text-sm text-zinc-500">Media session unavailable</p>
            ) : (
              <>
                <p className="mt-1 min-h-[1.25rem] truncate text-sm font-medium text-zinc-100">
                  {[mediaSession.artist, mediaSession.title].filter(Boolean).join(' — ') ||
                    'No active media'}
                </p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  Status:{' '}
                  <span className="text-zinc-400">
                    {mediaPlaybackDisplayLabel(mediaSession.playbackStatus)}
                  </span>
                </p>
              </>
            )}
          </div>

          <div className="mt-3 rounded-xl border border-white/[0.06] bg-zinc-900/25 px-3.5 py-3 sm:px-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-500">
                  Key detection
                </div>
                <p className="mt-1 text-sm font-medium text-zinc-100">
                  {activeDisplayName ?? 'No key candidate yet'}
                </p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  State:{' '}
                  <span className="text-zinc-400">{detectionStateLabel(effectiveDetectedKey.state)}</span>
                </p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  Resolution:{' '}
                  <span className="text-zinc-400">{resolutionStateLabel(cloudResolution.resolutionState)}</span>
                </p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  Source:{' '}
                  <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-200">
                    {cloudResolution.sourceBadge}
                  </span>
                </p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  Capture:{' '}
                  <span className="text-zinc-400">{captureModeLabel(effectiveDetectedKey.captureMode)}</span>
                </p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  Target:{' '}
                  <span className="text-zinc-400">{effectiveDetectedKey.targetApp ?? 'Unknown app'}</span>
                </p>
              </div>
              <div className="flex gap-2">
                <motion.button
                  type="button"
                  onClick={handleApplyDetected}
                  whileTap={{ scale: 0.97 }}
                  transition={{ type: 'spring', stiffness: 520, damping: 32 }}
                  className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${
                    canApplyDetected
                      ? 'border border-emerald-500/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/20'
                      : 'cursor-not-allowed border border-zinc-800 bg-zinc-900/50 text-zinc-500'
                  }`}
                  disabled={!canApplyDetected}
                  aria-label="Apply detected key to fretboard root and scale"
                >
                  Apply now
                </motion.button>
                <motion.button
                  type="button"
                  onClick={toggleLockDetected}
                  whileTap={{ scale: 0.97 }}
                  transition={{ type: 'spring', stiffness: 520, damping: 32 }}
                  className={`rounded-lg border px-3 py-2 text-xs font-semibold transition ${
                    lockDetected
                      ? 'border-amber-500/50 bg-amber-500/15 text-amber-200'
                      : 'border-zinc-700/80 bg-zinc-900/50 text-zinc-200 hover:border-zinc-600 hover:bg-zinc-800/60 hover:text-white'
                  }`}
                  aria-pressed={lockDetected}
                  aria-label="Lock current detected key"
                >
                  {lockDetected ? 'Locked' : 'Lock'}
                </motion.button>
                <motion.button
                  type="button"
                  onClick={() => {
                    void resetDetection();
                  }}
                  whileTap={{ scale: 0.97 }}
                  transition={{ type: 'spring', stiffness: 520, damping: 32 }}
                  className="rounded-lg border border-zinc-700/80 bg-zinc-900/50 px-3 py-2 text-xs font-semibold text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-800/60 hover:text-white"
                  aria-label="Retry key detection"
                >
                  Retry
                </motion.button>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
              <span>
                Confidence: <span className="text-zinc-300">{Math.round(effectiveDetectedKey.confidence * 100)}%</span>
              </span>
              <span>
                Stability: <span className="text-zinc-300">{Math.round(effectiveDetectedKey.stability * 100)}%</span>
              </span>
              <span>
                Windows: <span className="text-zinc-300">{effectiveDetectedKey.windowCount}</span>
              </span>
              <span>
                Buffer ready:{' '}
                <span className="text-zinc-300">{effectiveDetectedKey.enoughAudio ? 'Yes' : 'No'}</span>
              </span>
              <span>
                Buffer:{' '}
                <span className="text-zinc-300">
                  {effectiveDetectedKey.bufferSeconds.toFixed(1)}s / 12s
                </span>
              </span>
            </div>
            {effectiveDetectedKey.alternatives.length > 0 ? (
              <p className="mt-1 text-xs text-zinc-500">
                Alternatives:{' '}
                <span className="text-zinc-400">
                  {effectiveDetectedKey.alternatives
                    .slice(0, 2)
                    .map((alt) => `${alt.displayName} (${Math.round(alt.confidence * 100)}%)`)
                    .join(' • ')}
                </span>
              </p>
            ) : null}
            <p className="mt-1 text-xs text-zinc-500">
              Cloud lookup:{' '}
              <span className="text-zinc-300">
                {cloudResolution.cloudState === 'lookup_pending'
                  ? 'Checking verified database, then catalogs...'
                  : cloudResolution.cloudState === 'hit'
                    ? cloudResolution.cloudHit?.verified
                      ? 'Verified key found'
                      : `Catalog key found (${cloudResolution.cloudHit?.sourceLabel ?? 'external'})`
                    : cloudResolution.cloudState === 'miss'
                      ? 'No catalog key found; using local fallback'
                      : cloudResolution.cloudState === 'error'
                        ? 'Cloud lookup failed; trying catalogs then local fallback'
                        : 'Idle'}
              </span>
            </p>
            {cloudResolution.cloudError ? (
              <p className="mt-1 text-xs text-amber-300/80">
                Cloud lookup error: {cloudResolution.cloudError}
              </p>
            ) : null}
            <div className="mt-2 rounded-lg border border-white/[0.06] bg-zinc-950/30 px-3 py-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-500">
                Analyzer A/B
              </div>
              {detectedKeyAb ? (
                <>
                  <p className="mt-1 text-xs text-zinc-400">{abLine('Current', detectedKeyAb.current)}</p>
                  <p className="mt-0.5 text-xs text-zinc-400">
                    {abLine('LibKeyFinder', detectedKeyAb.libkeyfinder)}
                  </p>
                </>
              ) : (
                <p className="mt-1 text-xs text-zinc-500">Waiting for A/B data… (dev default enables with KEY_ANALYZER_AB=1)</p>
              )}
            </div>
            <div className="mt-2 rounded-lg border border-white/[0.06] bg-zinc-950/30 px-3 py-2">
              <div className="flex flex-wrap items-center gap-3">
                <label className="inline-flex items-center gap-2 text-xs text-zinc-300">
                  <input
                    type="checkbox"
                    checked={autoApplyEnabled}
                    onChange={(e) => setAutoApplyEnabled(e.target.checked)}
                    className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-emerald-500"
                  />
                  Auto apply
                </label>
                <span className="text-xs text-zinc-500">Confidence threshold</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={autoApplyConfidencePct}
                  onChange={(e) => setAutoApplyConfidencePct(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                  className="h-1.5 w-36 cursor-pointer accent-emerald-500"
                  aria-label="Auto apply confidence threshold"
                />
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={autoApplyConfidencePct}
                  onChange={(e) => setAutoApplyConfidencePct(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                  className="w-16 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
                  aria-label="Auto apply confidence percentage"
                />
                <span className="text-xs text-zinc-500">%</span>
              </div>
              <p className="mt-1 text-[11px] text-zinc-500">
                Auto apply triggers when detected confidence is at least {autoApplyConfidencePct}%.
              </p>
            </div>
            <div className="mt-2 rounded-lg border border-white/[0.06] bg-zinc-950/30 px-3 py-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-500">
                Suggest key (pending review)
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <select
                  value={suggestKey}
                  onChange={(e) => setSuggestKey(e.target.value)}
                  className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
                  aria-label="Suggestion key"
                >
                  {SUGGEST_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
                <select
                  value={suggestMode}
                  onChange={(e) => setSuggestMode(e.target.value as 'major' | 'minor')}
                  className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
                  aria-label="Suggestion mode"
                >
                  <option value="major">major</option>
                  <option value="minor">minor</option>
                </select>
                <motion.button
                  type="button"
                  onClick={() => {
                    void cloudResolution.submitSuggestion(suggestKey, suggestMode);
                  }}
                  whileTap={{ scale: 0.97 }}
                  transition={{ type: 'spring', stiffness: 520, damping: 32 }}
                  disabled={!mediaSession.title || !mediaSession.artist || cloudResolution.suggestionStatus === 'submitting'}
                  className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs font-semibold text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-800/60 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {cloudResolution.suggestionStatus === 'submitting' ? 'Submitting...' : 'Submit suggestion'}
                </motion.button>
              </div>
              {cloudResolution.suggestionMessage ? (
                <p className="mt-1 text-xs text-zinc-400">{cloudResolution.suggestionMessage}</p>
              ) : null}
            </div>
            {import.meta.env.DEV ? (
              <div className="mt-2 rounded-lg border border-sky-500/30 bg-sky-950/20 px-3 py-2">
                <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-sky-300">
                  Dev Cloud Test
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <label className="inline-flex items-center gap-2 text-xs text-sky-200">
                    <input
                      type="checkbox"
                      checked={devMockEnabled}
                      onChange={(e) => setDevMockEnabled(e.target.checked)}
                      className="h-4 w-4"
                    />
                    Use mock track for cloud lookup
                  </label>
                  <input
                    value={devMockTitle}
                    onChange={(e) => setDevMockTitle(e.target.value)}
                    placeholder="Mock title"
                    className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
                  />
                  <input
                    value={devMockArtist}
                    onChange={(e) => setDevMockArtist(e.target.value)}
                    placeholder="Mock artist"
                    className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
                  />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    value={devApiBaseInput}
                    onChange={(e) => setDevApiBaseInput(e.target.value)}
                    placeholder="API base override"
                    className="min-w-[22rem] rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
                  />
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.97 }}
                    transition={{ type: 'spring', stiffness: 520, damping: 32 }}
                    onClick={() => {
                      setSongKeyApiBaseForDev(devApiBaseInput);
                      setDevApiBaseInput(getSongKeyApiBaseForDev());
                    }}
                    className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
                  >
                    Apply API base
                  </motion.button>
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.97 }}
                    transition={{ type: 'spring', stiffness: 520, damping: 32 }}
                    onClick={() => {
                      setSongKeyApiBaseForDev(null);
                      setDevApiBaseInput(getSongKeyApiBaseForDev());
                    }}
                    className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
                  >
                    Reset API base
                  </motion.button>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    value={devFreqblogKeyInput}
                    onChange={(e) => setDevFreqblogKeyInput(e.target.value)}
                    placeholder="FreqBlog API key (optional)"
                    className="min-w-[18rem] rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
                  />
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.97 }}
                    transition={{ type: 'spring', stiffness: 520, damping: 32 }}
                    onClick={() => {
                      setFreqblogApiKeyForDev(devFreqblogKeyInput);
                      setDevFreqblogKeyInput(getFreqblogApiKeyForDev());
                    }}
                    className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
                  >
                    Save FreqBlog key
                  </motion.button>
                  <input
                    value={devGetSongBpmKeyInput}
                    onChange={(e) => setDevGetSongBpmKeyInput(e.target.value)}
                    placeholder="GetSongBPM API key (optional)"
                    className="min-w-[18rem] rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
                  />
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.97 }}
                    transition={{ type: 'spring', stiffness: 520, damping: 32 }}
                    onClick={() => {
                      setGetSongBpmApiKeyForDev(devGetSongBpmKeyInput);
                      setDevGetSongBpmKeyInput(getGetSongBpmApiKeyForDev());
                    }}
                    className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
                  >
                    Save GetSongBPM key
                  </motion.button>
                </div>
                <p className="mt-1 text-[11px] text-sky-200/80">
                  Mock track identity: {cloudResolution.trackIdentity ?? '<none>'}
                </p>
                {cloudResolution.cloudHit?.source === 'getsongbpm' ? (
                  <p className="mt-1 text-[11px] text-zinc-500">
                    Key data from{' '}
                    <a className="underline decoration-zinc-600" href="https://getsongbpm.com" target="_blank" rel="noreferrer">
                      GetSongBPM.com
                    </a>
                  </p>
                ) : null}
              </div>
            ) : null}
            {!canApplyDetected ? (
              <p className="mt-1 text-xs text-amber-300/80">
                Apply disabled: {detectionReasonLabel(effectiveDetectedKey.reason)}
              </p>
            ) : null}
          </div>

          <div
            className="mt-5 border-t border-white/[0.06] pt-4"
            role="group"
            aria-label="Fretboard display options"
          >
            <span className="mb-3 block text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-500">
              Fretboard view
            </span>
            <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-2 xl:grid-cols-5">
              {(
                [
                  { mode: 'scale-all' as const, label: 'All scale notes' },
                  { mode: 'root-only' as const, label: 'Root only' },
                  { mode: 'triads' as const, label: 'Triads' },
                  { mode: 'chromatic' as const, label: 'Chromatic' },
                  { mode: 'scale-plus-pentatonic' as const, label: '+ Pentatonic' },
                ] as const
              ).map(({ mode, label }) => (
                <motion.button
                  key={mode}
                  type="button"
                  onClick={() => setViewMode(mode)}
                  aria-pressed={viewMode === mode}
                  layout
                  whileTap={{ scale: 0.96 }}
                  transition={{ type: 'spring', stiffness: 480, damping: 34, layout: { type: 'spring', stiffness: 400, damping: 35 } }}
                  className={`flex min-h-[3.25rem] w-full items-center justify-center rounded-lg px-2.5 py-2.5 text-center text-sm font-semibold leading-snug tracking-wide transition-colors duration-200 sm:min-h-[3.5rem] sm:px-3 sm:text-base ${
                    viewMode === mode
                      ? 'bg-zinc-100 text-zinc-950 shadow-[0_1px_0_rgba(255,255,255,0.08)] ring-1 ring-white/20'
                      : 'bg-zinc-900/40 text-zinc-400 ring-1 ring-zinc-800/40 hover:bg-zinc-800/55 hover:text-zinc-200'
                  }`}
                >
                  {label}
                </motion.button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/*
        Full neck: w-full h-auto + meet. Capo: cropped viewBox centered on new neck (wire → bridge), uniform scale only.
        padding-top: measured from fixed settings panel so scale strip + neck always sit below it (any viewport).
      */}
      <div
        className="flex w-full flex-1 flex-col justify-start px-3 pb-10 sm:px-5 sm:pb-14 lg:px-12"
        style={{
          paddingTop:
            fretboardSectionPaddingTopPx != null
              ? `${fretboardSectionPaddingTopPx}px`
              : 'clamp(18rem, 45vh, 36rem)',
        }}
      >
        <div className="mb-2 shrink-0 sm:mb-3">
          <ScaleKeyStrip notes={notes} scaleType={scaleType} />
        </div>
        {/* Cancel only the right padding so the neck can touch the screen edge without rescaling. */}
        <div className="-mr-3 sm:-mr-5 lg:-mr-12">
            <motion.svg
              role="img"
              aria-label={`Fretboard for ${title}`}
              viewBox={`${camera.x} 0 ${camera.width} ${layout.height}`}
              overflow="visible"
              className="mx-auto block h-auto w-full min-w-0 max-w-full drop-shadow-[0_32px_80px_-12px_rgba(0,0,0,0.65)]"
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
        </div>

        <ChordLibrarySection
          root={scale.root}
          scaleType={scaleType}
          tuningId={tuningId}
          openStringPcs={openStringPcs}
          tuningLabel={tuning.label}
          stringLabels={stringLabels}
          capo={capo}
          selectedChord={selectedChord}
          onChordSelect={setSelectedChord}
        />
      </div>
    </div>
  );
}
