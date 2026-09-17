import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import {
  BookmarkPlus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Compass,
  Dumbbell,
  Expand,
  Guitar,
  Headphones,
  ListMusic,
  Menu,
  RotateCcw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { usePracticeAudio, type PlaybackMode } from "./audio/usePracticeAudio";
import { resolveChordVoicings } from "./chords/resolveChordVoicings";
import { getDiatonicTriads } from "./chords/scaleChordTheory";
import type { ChordVoicing, ScaleChordWithVoicings } from "./chords/chordTypes";
import { ChordWorkspace } from "./components/ChordWorkspace";
import { Dialog } from "./components/Dialog";
import { Fretboard, musicalLabel } from "./components/Fretboard";
import { ListeningPanel } from "./components/ListeningPanel";
import { LiveJam } from "./components/LiveJam";
import { StudioScreens, type StudioView } from "./components/StudioScreens";
import { Transport } from "./components/Transport";
import { useCloudKeyResolution } from "./hooks/useCloudKeyResolution";
import { useDetectedKey } from "./hooks/useDetectedKey";
import { useMediaSession } from "./hooks/useMediaSession";
import { getPositionFrets, getPositionWindow } from "./music/positions";
import {
  DEFAULT_SESSION,
  buildExercise,
  canAutoApply,
  readFavorites,
  readSession,
  storeFavorites,
  storeSession,
  tuningMidi,
  type Favorite,
  type PracticeSession,
} from "./practice/session";
import {
  SCALE_TYPES_ORDERED,
  SCALE_TYPE_LABELS,
  tryNormalizeRoot,
  type ScaleType,
} from "./scaleDataProvider";
import { buildScaleNotes, SCALE_DEGREE_LABELS } from "./scaleSpell";
import { TUNING_PRESETS } from "./tunings";

type DetectionCandidate = {
  root: string;
  scaleType: "major" | "minor";
  automatic: boolean;
};

const ROOTS = [
  "C",
  "C#",
  "Db",
  "D",
  "D#",
  "Eb",
  "E",
  "F",
  "F#",
  "Gb",
  "G",
  "G#",
  "Ab",
  "A",
  "A#",
  "Bb",
  "B",
] as const;
const VISIBLE_FRET_LIMITS = [12, 15, 24] as const;
const POSITION_LABELS: Record<PracticeSession["positionMode"], string> = {
  full: "Full neck",
  pentatonic: "Pentatonic boxes",
  caged: "CAGED connections",
  "three-notes": "Three notes per string",
};

function parentHarmony(
  root: string,
  scaleType: ScaleType,
): { root: string; scaleType: ScaleType; label: string | null } {
  if (scaleType === "pentatonic-major")
    return { root, scaleType: "major", label: `${musicalLabel(root)} major` };
  if (scaleType === "pentatonic-minor" || scaleType === "blues")
    return { root, scaleType: "minor", label: `${musicalLabel(root)} minor` };
  return { root, scaleType, label: null };
}

function voicingMidi(
  voicing: ChordVoicing | undefined,
  openMidi: readonly number[],
  capo: number,
): number[] {
  if (!voicing) return [];
  const notes: number[] = [];
  voicing.frets.forEach((cell, stringIndex) => {
    if (cell === "x") return;
    const fret = cell === "o" || cell === 0 ? capo : cell;
    const open = openMidi[stringIndex];
    if (open !== undefined) notes.push(open + fret);
  });
  return notes;
}

function ascendingPitchClasses(pitchClasses: readonly number[]): number[] {
  let cursor = 47;
  return pitchClasses.map((pitchClass) => {
    let midi = 48 + (((pitchClass % 12) + 12) % 12);
    while (midi <= cursor) midi += 12;
    cursor = midi;
    return midi;
  });
}

function chordMidi(
  chord: ScaleChordWithVoicings,
  openMidi: readonly number[],
  capo: number,
  voicingIndex = 0,
): number[] {
  const display =
    chord.displayVoicings[voicingIndex] ?? chord.displayVoicings[0];
  const resolved = voicingMidi(display?.voicing, openMidi, capo);
  return resolved.length > 0
    ? resolved
    : ascendingPitchClasses(chord.chordPitchClasses);
}

function favoriteId(): string {
  return `setup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function fretLimitContaining(endFret: number): number {
  return VISIBLE_FRET_LIMITS.find((limit) => limit >= endFret) ?? 24;
}

export default function App() {
  const [session, setSession] = useState<PracticeSession>(() => readSession());
  const [favorites, setFavorites] = useState<Favorite[]>(() => readFavorites());
  const [view, setView] = useState<StudioView>("explore");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [setupName, setSetupName] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [auto, setAuto] = useState(false);
  const [selectedChord, setSelectedChord] = useState<number | null>(null);
  const [voicingIndex, setVoicingIndex] = useState(0);
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>("scale");
  const [auditionMidi, setAuditionMidi] = useState<number[]>([]);
  const auditionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const media = useMediaSession();
  const { detectedKey, resetDetection } = useDetectedKey();
  const cloud = useCloudKeyResolution(media, detectedKey);
  const audio = usePracticeAudio(session.volume);
  const updateSession = useCallback(
    (patch: Partial<PracticeSession>) =>
      setSession((current) => ({ ...current, ...patch })),
    [],
  );

  useEffect(() => {
    storeSession(session);
  }, [session]);
  useEffect(() => {
    storeFavorites(favorites);
  }, [favorites]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(
    () => () => {
      if (auditionTimer.current) clearTimeout(auditionTimer.current);
    },
    [],
  );
  useEffect(() => {
    audio.stop();
  }, [
    audio.stop,
    session.capo,
    session.direction,
    session.frets,
    session.loop,
    session.metronome,
    session.positionIndex,
    session.positionMode,
    session.progression,
    session.root,
    session.scaleType,
    session.tempo,
    session.tuningId,
  ]);
  useEffect(() => {
    setSelectedChord(null);
    setVoicingIndex(0);
  }, [session.capo, session.root, session.scaleType, session.tuningId]);

  const notes = useMemo(
    () => buildScaleNotes(session.root, session.scaleType),
    [session.root, session.scaleType],
  );
  const rootPc = notes[0]?.pitchClass ?? 9;
  const scalePcs = useMemo(() => notes.map((note) => note.pitchClass), [notes]);
  const tuning =
    TUNING_PRESETS.find((preset) => preset.id === session.tuningId) ??
    TUNING_PRESETS[0]!;
  const openMidi = tuningMidi(tuning.id);
  const pentatonicCompatible = [
    "major",
    "minor",
    "dorian",
    "phrygian",
    "lydian",
    "mixolydian",
    "pentatonic-major",
    "pentatonic-minor",
    "blues",
  ].includes(session.scaleType);
  const cagedCompatible =
    session.scaleType === "major" && session.tuningId === "standard";
  const threeNotesCompatible = notes.length === 7;

  useEffect(() => {
    const compatible =
      session.positionMode === "full" ||
      (session.positionMode === "pentatonic" && pentatonicCompatible) ||
      (session.positionMode === "caged" && cagedCompatible) ||
      (session.positionMode === "three-notes" && threeNotesCompatible);
    if (!compatible) updateSession({ positionMode: "full", positionIndex: 0 });
  }, [
    cagedCompatible,
    pentatonicCompatible,
    session.positionMode,
    threeNotesCompatible,
    updateSession,
  ]);

  const positionWindow = useMemo(
    () =>
      getPositionWindow(
        rootPc,
        session.scaleType,
        session.positionMode,
        session.positionIndex,
        tuning.openStringPcs,
      ),
    [
      rootPc,
      session.positionIndex,
      session.positionMode,
      session.scaleType,
      tuning.openStringPcs,
    ],
  );
  const namedPosition = session.positionMode !== "full";
  const positionClippedByCapo =
    namedPosition && session.capo > positionWindow.startFret;
  const positionClippedByFretLimit =
    namedPosition && session.frets < positionWindow.endFret;
  const positionIncomplete =
    positionClippedByCapo || positionClippedByFretLimit;
  const requiredPositionFretLimit = fretLimitContaining(positionWindow.endFret);
  const positionPoints = useMemo(
    () =>
      getPositionFrets(
        tuning.openStringPcs,
        scalePcs,
        rootPc,
        session.scaleType,
        session.positionMode,
        session.positionIndex,
      ).filter(
        (point) => point.fret >= session.capo && point.fret <= session.frets,
      ),
    [
      rootPc,
      scalePcs,
      session.capo,
      session.frets,
      session.positionIndex,
      session.positionMode,
      session.scaleType,
      tuning.openStringPcs,
    ],
  );
  const positionSet = useMemo(
    () =>
      session.positionMode === "full"
        ? null
        : new Set(
            positionPoints.map((point) => `${point.stringIndex}:${point.fret}`),
          ),
    [positionPoints, session.positionMode],
  );
  const boardStart =
    session.positionMode === "full"
      ? session.capo
      : Math.max(session.capo, positionWindow.startFret);
  const boardEnd =
    session.positionMode === "full"
      ? session.frets
      : Math.min(session.frets, positionWindow.endFret);

  const harmony = parentHarmony(session.root, session.scaleType);
  const chords = useMemo(
    () =>
      resolveChordVoicings(getDiatonicTriads(harmony.root, harmony.scaleType), {
        tuningId: tuning.id,
        openStringPcs: tuning.openStringPcs,
        capo: session.capo,
        numFrets: session.frets,
      }),
    [
      harmony.root,
      harmony.scaleType,
      session.capo,
      session.frets,
      tuning.id,
      tuning.openStringPcs,
    ],
  );
  const selected =
    selectedChord === null ? null : (chords[selectedChord] ?? null);
  const progressionActiveIndex =
    audio.playing === "progression" ? audio.step.chordIndex : undefined;
  const progressionDegree =
    progressionActiveIndex === undefined
      ? undefined
      : session.progression[progressionActiveIndex];
  const activeProgressionChord =
    progressionDegree === undefined
      ? null
      : (chords[progressionDegree] ?? null);
  const highlightedChord = activeProgressionChord ?? selected;
  const activeMidi = useMemo(
    () => [...new Set([...audio.step.notes, ...auditionMidi])],
    [audio.step.notes, auditionMidi],
  );

  const localRoot = detectedKey.primaryKey
    ? tryNormalizeRoot(detectedKey.primaryKey)
    : null;
  const localScale =
    detectedKey.primaryScale === "major" || detectedKey.primaryScale === "minor"
      ? detectedKey.primaryScale
      : null;
  const cloudRoot = cloud.cloudHit
    ? tryNormalizeRoot(cloud.cloudHit.key)
    : null;
  const candidate: DetectionCandidate | null = useMemo(
    () =>
      cloud.cloudHit && cloudRoot
        ? { root: cloudRoot, scaleType: cloud.cloudHit.mode, automatic: true }
        : localRoot && localScale
          ? {
              root: localRoot,
              scaleType: localScale,
              automatic: canAutoApply(detectedKey),
            }
          : null,
    [cloud.cloudHit, cloudRoot, detectedKey, localRoot, localScale],
  );
  const applyCandidate = useCallback(() => {
    if (!candidate || locked) return;
    if (
      session.root !== candidate.root ||
      session.scaleType !== candidate.scaleType
    ) {
      updateSession({ root: candidate.root, scaleType: candidate.scaleType });
    }
  }, [candidate, locked, session.root, session.scaleType, updateSession]);
  useEffect(() => {
    if (
      view !== "jam" &&
      auto &&
      !locked &&
      candidate?.automatic &&
      (session.root !== candidate.root ||
        session.scaleType !== candidate.scaleType)
    ) {
      updateSession({ root: candidate.root, scaleType: candidate.scaleType });
    }
  }, [
    view,
    auto,
    candidate,
    locked,
    session.root,
    session.scaleType,
    updateSession,
  ]);

  const audition = useCallback(
    (midi: readonly number[]) => {
      const sounding = [...midi];
      setAuditionMidi(sounding);
      if (auditionTimer.current) clearTimeout(auditionTimer.current);
      auditionTimer.current = setTimeout(() => setAuditionMidi([]), 650);
      void audio.audition(sounding);
    },
    [audio.audition],
  );
  const exerciseMidi = useMemo(
    () =>
      positionPoints.map(
        (point) => (openMidi[point.stringIndex] ?? 40) + point.fret,
      ),
    [openMidi, positionPoints],
  );
  const playScale = useCallback(() => {
    if (positionIncomplete) return;
    const steps = buildExercise(exerciseMidi, session.direction).map(
      (midi) => ({ notes: [midi] }),
    );
    void audio.play(
      "scale",
      steps,
      session.tempo,
      session.loop,
      session.metronome,
    );
  }, [
    audio.play,
    exerciseMidi,
    positionIncomplete,
    session.direction,
    session.loop,
    session.metronome,
    session.tempo,
  ]);
  const playMetronome = useCallback(() => {
    void audio.play(
      "metronome",
      Array.from({ length: 4 }, () => ({ notes: [] })),
      session.tempo,
      true,
      true,
    );
  }, [audio.play, session.tempo]);
  const playProgression = useCallback(() => {
    const steps = session.progression.flatMap((degree, chordIndex) => {
      const chord = chords[degree];
      const sounding = chord
        ? chordMidi(
            chord,
            openMidi,
            session.capo,
            degree === selectedChord ? voicingIndex : 0,
          )
        : [];
      return Array.from({ length: 4 }, (_, beat) => ({
        notes: beat === 0 ? sounding : [],
        chordIndex,
      }));
    });
    setPlaybackMode("progression");
    void audio.play(
      "progression",
      steps,
      session.tempo,
      session.loop,
      session.metronome,
    );
  }, [
    audio.play,
    chords,
    openMidi,
    selectedChord,
    session.capo,
    session.loop,
    session.metronome,
    session.progression,
    session.tempo,
    voicingIndex,
  ]);
  const onTransportPlay = () => {
    if (playbackMode === "progression") playProgression();
    else if (playbackMode === "metronome") playMetronome();
    else playScale();
  };
  const transportDisabled =
    playbackMode === "scale"
      ? positionIncomplete || exerciseMidi.length === 0
      : playbackMode === "progression"
        ? session.progression.length === 0
        : false;

  const saveFavorite = (event: FormEvent) => {
    event.preventDefault();
    const name = setupName.trim();
    if (!name) return;
    setFavorites((current) =>
      [
        { id: favoriteId(), name: name.slice(0, 60), session },
        ...current,
      ].slice(0, 30),
    );
    setSaveOpen(false);
    setSetupName("");
    setToast(`Saved ${name}`);
  };
  const loadFavorite = (favorite: Favorite) => {
    if (view === "jam") changeView("explore");
    setSession(favorite.session);
    setAuto(false);
    setSidebarOpen(false);
    setToast(`Loaded ${favorite.name}`);
  };
  const changeView = (next: StudioView) => {
    audio.stop();
    setPlaybackMode(next === "progressions" ? "progression" : "scale");
    window.scrollTo({ top: 0, behavior: "instant" });
    setView(next);
    setSidebarOpen(false);
  };
  const updateProgression = (progression: number[]) => {
    if (
      progression.length > session.progression.length &&
      view !== "progressions"
    )
      changeView("progressions");
    updateSession({ progression });
  };
  const positionCount =
    session.positionMode === "three-notes"
      ? 7
      : session.positionMode === "full"
        ? 1
        : 5;
  const selectPosition = (
    positionMode: PracticeSession["positionMode"],
    positionIndex: number,
  ) => {
    if (positionMode === "full") {
      updateSession({ positionMode, positionIndex });
      return;
    }
    const nextWindow = getPositionWindow(
      rootPc,
      session.scaleType,
      positionMode,
      positionIndex,
      tuning.openStringPcs,
    );
    updateSession({
      positionMode,
      positionIndex,
      frets: Math.max(session.frets, fretLimitContaining(nextWindow.endFret)),
    });
  };
  const hasMajorThird = notes.some(
    (note) => (note.pitchClass - rootPc + 12) % 12 === 4,
  );
  const overlayLabel = `Parallel ${musicalLabel(session.root)} ${hasMajorThird ? "minor" : "major"} pentatonic`;
  const boardUnavailable =
    session.positionMode !== "full" && positionPoints.length === 0;
  const positionFixes = [
    positionClippedByCapo
      ? `Lower the capo to fret ${positionWindow.startFret} or earlier.`
      : null,
    positionClippedByFretLimit
      ? `Show ${requiredPositionFretLimit} visible frets.`
      : null,
  ].filter((message): message is string => message !== null);
  const positionDescription =
    session.positionMode === "full"
      ? `Every current-scale note from fret ${session.capo} through ${session.frets}.`
      : positionIncomplete
        ? `Partial ${positionWindow.label}. ${positionFixes.join(" ")} The scale exercise is unavailable until the full shape is visible.`
        : boardUnavailable
          ? "This position is unavailable in the current visible fret range."
          : positionWindow.description;

  const contextControls = (
    <section className="context-toolbar" aria-label="Musical context">
      <label className="context-field root-field">
        <span>Root</span>
        <div>
          <select
            aria-label="Root note"
            value={session.root}
            onChange={(event) => updateSession({ root: event.target.value })}
          >
            {ROOTS.map((root) => (
              <option value={root} key={root}>
                {musicalLabel(root)}
              </option>
            ))}
          </select>
          <ChevronDown size={13} />
        </div>
      </label>
      <label className="context-field scale-field">
        <span>Scale</span>
        <div>
          <select
            aria-label="Scale type"
            value={session.scaleType}
            onChange={(event) =>
              updateSession({
                scaleType: event.target.value as ScaleType,
              })
            }
          >
            {SCALE_TYPES_ORDERED.map((type) => (
              <option value={type} key={type}>
                {SCALE_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
          <ChevronDown size={13} />
        </div>
      </label>
      <label className="context-field tuning-field">
        <span>Tuning</span>
        <div>
          <select
            aria-label="Tuning"
            value={session.tuningId}
            onChange={(event) =>
              updateSession({ tuningId: event.target.value })
            }
          >
            {TUNING_PRESETS.map((preset) => (
              <option value={preset.id} key={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
          <ChevronDown size={13} />
        </div>
      </label>
      <label className="context-field capo-field">
        <span>Capo</span>
        <div>
          <select
            aria-label="Capo"
            value={session.capo}
            onChange={(event) =>
              updateSession({ capo: Number(event.target.value) })
            }
          >
            {Array.from({ length: 13 }, (_, fret) => (
              <option value={fret} key={fret}>
                {fret === 0 ? "None" : fret}
              </option>
            ))}
          </select>
          <ChevronDown size={13} />
        </div>
      </label>
      <button
        className="reset-button"
        aria-label="Reset practice setup"
        onClick={() => {
          setSession(DEFAULT_SESSION);
          setAuto(false);
        }}
      >
        <RotateCcw size={16} />
      </button>
    </section>
  );
  const fretboardPanel = (
    <section className="panel fretboard-panel">
      <div className="fretboard-heading">
        <div className="scale-heading">
          <span className="scale-symbol">{musicalLabel(session.root)}</span>
          <div>
            <span className="eyebrow">CURRENT SOUND</span>
            <h2 data-testid="scale-title">
              {musicalLabel(session.root)}{" "}
              {session.scaleType.replaceAll("-", " ")}
            </h2>
          </div>
        </div>
        <div className="board-actions">
          <div className="segmented" aria-label="Fretboard labels">
            <button
              aria-pressed={session.labelMode === "notes"}
              className={session.labelMode === "notes" ? "selected" : ""}
              onClick={() => updateSession({ labelMode: "notes" })}
            >
              Notes
            </button>
            <button
              aria-pressed={session.labelMode === "intervals"}
              className={session.labelMode === "intervals" ? "selected" : ""}
              onClick={() => updateSession({ labelMode: "intervals" })}
            >
              Intervals
            </button>
          </div>
          <button
            className="expand-button"
            aria-label="Show 24 frets"
            onClick={() => updateSession({ frets: 24 })}
          >
            <Expand size={16} />
          </button>
        </div>
      </div>
      <div className="scale-note-strip">
        {notes.map((note, index) => (
          <button
            type="button"
            className={`scale-note ${note.isRoot ? "root" : ""}`}
            aria-label={`Hear ${musicalLabel(note.label)}`}
            onClick={() => audition([60 + note.pitchClass])}
            key={`${note.label}-${index}`}
          >
            <strong>{musicalLabel(note.label)}</strong>
            <span>
              {musicalLabel(
                SCALE_DEGREE_LABELS[session.scaleType][index] ?? "",
              )}
            </span>
          </button>
        ))}
        <span className="note-strip-hint">Click any note to hear it.</span>
      </div>
      <div className="board-toolbar">
        <div className="view-filters" aria-label="Visible notes">
          {(
            [
              ["scale", "Scale"],
              ["roots", "Roots"],
              ["triad", "Triad"],
              ["chromatic", "Chromatic"],
              ["pentatonic-overlay", overlayLabel],
            ] as const
          ).map(([display, label]) => (
            <button
              className={session.display === display ? "active" : ""}
              aria-pressed={session.display === display}
              onClick={() => updateSession({ display })}
              key={display}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="fret-count">
          <span>Visible frets</span>
          <select
            aria-label="Visible frets"
            value={session.frets}
            onChange={(event) =>
              updateSession({ frets: Number(event.target.value) })
            }
          >
            <option value={12}>12</option>
            <option value={15}>15</option>
            <option value={24}>24</option>
          </select>
          <ChevronDown size={12} />
        </label>
      </div>
      <div className="position-toolbar">
        <label>
          <span>Position</span>
          <select
            className="position-picker"
            aria-label="Position family"
            value={session.positionMode}
            onChange={(event) =>
              selectPosition(
                event.target.value as PracticeSession["positionMode"],
                0,
              )
            }
          >
            <option value="full">{POSITION_LABELS.full}</option>
            {pentatonicCompatible && (
              <option value="pentatonic">{POSITION_LABELS.pentatonic}</option>
            )}
            {cagedCompatible && (
              <option value="caged">{POSITION_LABELS.caged}</option>
            )}
            {threeNotesCompatible && (
              <option value="three-notes">
                {POSITION_LABELS["three-notes"]}
              </option>
            )}
          </select>
          <ChevronDown size={12} />
        </label>
        {positionCount > 1 && (
          <div className="position-picker" aria-label="Position number">
            {Array.from({ length: positionCount }, (_, index) => (
              <button
                className={session.positionIndex === index ? "active" : ""}
                aria-pressed={session.positionIndex === index}
                onClick={() => selectPosition(session.positionMode, index)}
                key={index}
              >
                {index + 1}
              </button>
            ))}
          </div>
        )}
        <div className="position-picker">
          <button
            aria-label="Previous position"
            disabled={positionCount === 1}
            onClick={() =>
              selectPosition(
                session.positionMode,
                (session.positionIndex - 1 + positionCount) % positionCount,
              )
            }
          >
            <ChevronLeft size={14} />
          </button>
          <button
            aria-label="Next position"
            disabled={positionCount === 1}
            onClick={() =>
              selectPosition(
                session.positionMode,
                (session.positionIndex + 1) % positionCount,
              )
            }
          >
            <ChevronRight size={14} />
          </button>
        </div>
        <p className="position-description" data-testid="position-description">
          {positionDescription}
        </p>
      </div>
      <Fretboard
        notes={notes}
        scaleType={session.scaleType}
        openMidi={openMidi}
        labels={tuning.stringLabels}
        startFret={boardStart}
        endFret={boardEnd}
        capo={session.capo}
        labelMode={session.labelMode}
        display={session.display}
        positions={positionSet}
        chordPcs={highlightedChord?.chordPitchClasses ?? null}
        activeMidi={activeMidi}
        onNote={(midi) => audition([midi])}
      />
      <div className="board-footer">
        <div className="note-legend">
          <span>
            <i className="legend-root" />
            Root note
          </span>
          <span>
            <i className="legend-chord" />
            Chord tone
          </span>
        </div>
        <span className="scroll-hint">Scroll sideways to travel the neck.</span>
      </div>
    </section>
  );
  const chordPanel = (
    <ChordWorkspace
      chords={chords}
      selected={selectedChord}
      voicingIndex={voicingIndex}
      onSelect={(index) => {
        setSelectedChord((current) => (current === index ? null : index));
        setVoicingIndex(0);
      }}
      onVoicing={setVoicingIndex}
      onAudition={() => {
        const chord = selected ?? chords[0];
        if (chord)
          audition(chordMidi(chord, openMidi, session.capo, voicingIndex));
      }}
      labels={tuning.stringLabels}
      openPcs={tuning.openStringPcs}
      capo={session.capo}
      progression={session.progression}
      onProgression={updateProgression}
      showProgression={view === "progressions"}
      activeChord={progressionActiveIndex}
      onPlayProgression={playProgression}
      parentLabel={harmony.label}
    />
  );
  const listeningPanel = (
    <ListeningPanel
      media={media}
      detected={detectedKey}
      cloud={cloud}
      locked={locked}
      auto={auto}
      onLock={() => setLocked((value) => !value)}
      onAuto={setAuto}
      onApply={applyCandidate}
      canApply={candidate !== null}
      onRetry={() => void resetDetection()}
      root={session.root}
      scale={session.scaleType}
    />
  );
  return (
    <MotionConfig reducedMotion="user">
      <div className={`studio-shell studio-${view}`}>
        <aside
          className={`sidebar ${sidebarOpen ? "open" : ""}`}
          id="studio-sidebar"
        >
          <div className="brand">
            <span className="brand-mark">
              <Guitar size={21} />
            </span>
            <div>
              <strong>fretboard</strong>
              <span className="brand-sub">STUDIO</span>
            </div>
          </div>
          <span className="nav-section-label">Workspace</span>
          <nav aria-label="Studio sections">
            <button
              className={`nav-item ${view === "jam" ? "active" : ""}`}
              aria-current={view === "jam" ? "page" : undefined}
              onClick={() => changeView("jam")}
            >
              <Headphones size={17} />
              <span>Live Jam</span>
              <i className="nav-dot" />
            </button>
            <button
              className={`nav-item ${view === "explore" ? "active" : ""}`}
              aria-current={view === "explore" ? "page" : undefined}
              onClick={() => changeView("explore")}
            >
              <Compass size={17} />
              <span>Explore</span>
              <i className="nav-dot" />
            </button>
            <button
              className={`nav-item ${view === "practice" ? "active" : ""}`}
              aria-current={view === "practice" ? "page" : undefined}
              onClick={() => changeView("practice")}
            >
              <Dumbbell size={17} />
              <span>Practice</span>
              <i className="nav-dot" />
            </button>
            <button
              className={`nav-item ${view === "progressions" ? "active" : ""}`}
              aria-current={view === "progressions" ? "page" : undefined}
              onClick={() => changeView("progressions")}
            >
              <ListMusic size={17} />
              <span>Progressions</span>
              <i className="nav-dot" />
            </button>
          </nav>
          <div className="saved-heading">
            <span className="nav-section-label">Saved setups</span>
            {view !== "jam" && (
              <button
                className="icon-button"
                aria-label="Save current setup"
                onClick={() => setSaveOpen(true)}
              >
                <BookmarkPlus size={15} />
              </button>
            )}
          </div>
          <div className="favorites">
            {favorites.map((favorite) => (
              <div className="favorite-row" key={favorite.id}>
                <button
                  onClick={() => loadFavorite(favorite)}
                  aria-label={`Load ${favorite.name}`}
                >
                  <span>{favorite.name}</span>
                  <small>
                    {musicalLabel(favorite.session.root)} ·{" "}
                    {SCALE_TYPE_LABELS[favorite.session.scaleType]}
                  </small>
                </button>
                <button
                  className="favorite-delete"
                  aria-label={`Delete ${favorite.name}`}
                  onClick={() =>
                    setFavorites((current) =>
                      current.filter((item) => item.id !== favorite.id),
                    )
                  }
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            {favorites.length === 0 && (
              <p className="favorites-empty">Save a setup to keep it close.</p>
            )}
          </div>
          <div className="sidebar-bottom">
            <div className="small-neck" aria-hidden>
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
              <b />
              <b />
              <b />
            </div>
            <strong>Every note is a way in.</strong>
            <p>Follow one shape until the whole neck starts to connect.</p>
            <button className="sidebar-help" onClick={() => setGuideOpen(true)}>
              <CircleHelp size={16} />
              <span>
                <strong>Quick guide</strong>
                <small>Notes, shapes & practice</small>
              </span>
            </button>
            <p className="sidebar-footer">
              <i className="status-dot" />
              Built for focused practice.
            </p>
          </div>
        </aside>
        <AnimatePresence>
          {sidebarOpen && (
            <motion.button
              className="sidebar-scrim"
              aria-label="Close navigation"
              onClick={() => setSidebarOpen(false)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            />
          )}
        </AnimatePresence>

        <main className="studio-main">
          <header className="topbar">
            <button
              className="mobile-menu icon-button"
              aria-label={
                sidebarOpen ? "Close navigation menu" : "Open navigation menu"
              }
              aria-controls="studio-sidebar"
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen((open) => !open)}
            >
              {sidebarOpen ? <X size={19} /> : <Menu size={19} />}
            </button>
            <div className="breadcrumb">
              <span>Studio</span>
              <i>/</i>
              <strong>
                {view === "jam"
                  ? "Live Jam"
                  : view[0]!.toUpperCase() + view.slice(1)}
              </strong>
            </div>
            <div className="topbar-actions">
              <span className="local-status">
                <i className="status-dot" />
                {cloud.sourceBadge}
              </span>
              {view !== "jam" && (
                <button
                  className="button save-button"
                  aria-label="Save setup"
                  onClick={() => setSaveOpen(true)}
                >
                  <Save size={15} />
                  Save setup
                </button>
              )}
            </div>
          </header>
          <StudioScreens
            view={view}
            context={contextControls}
            board={fretboardPanel}
            chords={chordPanel}
            listening={listeningPanel}
            jam={
              <LiveJam
                media={media}
                detected={detectedKey}
                cloud={cloud}
                session={session}
                onRetry={() => void resetDetection()}
                onAudition={audition}
                activeMidi={activeMidi}
              />
            }
            session={session}
            notes={notes}
            playing={audio.playing}
            beat={audio.step.index}
            chordName={
              chords[session.progression[progressionActiveIndex ?? 0] ?? -1]
                ?.chordName ?? ""
            }
            nextChord={
              chords[
                session.progression[
                  ((progressionActiveIndex ?? 0) + 1) %
                    session.progression.length
                ] ?? -1
              ]?.chordName ?? ""
            }
            position={positionWindow.label}
            exerciseCount={new Set(exerciseMidi).size}
            practiceDisabled={exerciseMidi.length === 0 || positionIncomplete}
            onChange={updateSession}
            onPractice={() => {
              setPlaybackMode("scale");
              playScale();
            }}
            onStop={audio.stop}
            onAudition={audition}
            onNavigate={changeView}
          />
          {view !== "jam" && (
            <Transport
              session={session}
              onChange={updateSession}
              playing={audio.playing}
              beat={audio.step.index}
              mode={playbackMode}
              onMode={setPlaybackMode}
              onPlay={onTransportPlay}
              onStop={audio.stop}
              disabled={transportDisabled}
            />
          )}
        </main>

        <Dialog
          open={saveOpen}
          title="Save practice setup"
          onClose={() => setSaveOpen(false)}
        >
          <form onSubmit={saveFavorite}>
            <label className="form-field">
              <span>Setup name</span>
              <input
                aria-label="Setup name"
                value={setupName}
                maxLength={60}
                onChange={(event) => setSetupName(event.target.value)}
                placeholder={`${musicalLabel(session.root)} practice`}
              />
            </label>
            <div className="dialog-actions">
              <button
                type="button"
                className="button subtle"
                onClick={() => setSaveOpen(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="button accent"
                disabled={!setupName.trim()}
              >
                <Save size={14} />
                Save favorite
              </button>
            </div>
          </form>
        </Dialog>
        <Dialog
          open={guideOpen}
          title="Quick guide"
          onClose={() => setGuideOpen(false)}
        >
          <div className="quick-guide">
            <p>
              <strong>1. Choose a sound.</strong> Set the root, scale, tuning,
              and capo.
            </p>
            <p>
              <strong>2. Learn a shape.</strong> Use positions to turn the full
              neck into a manageable pattern.
            </p>
            <p>
              <strong>3. Make music.</strong> Hear notes, build a progression,
              and practice it with the transport.
            </p>
            <p className="guide-note">
              The pentatonic overlay shows the opposite parallel major or minor
              pentatonic. It can add notes outside the selected scale.
            </p>
          </div>
          <div className="dialog-actions">
            <button
              type="button"
              className="button accent"
              onClick={() => setGuideOpen(false)}
            >
              Got it
            </button>
          </div>
        </Dialog>
        <AnimatePresence>
          {(toast || audio.error) && (
            <motion.div
              className="toast"
              role="status"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
            >
              {audio.error ?? toast}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}
