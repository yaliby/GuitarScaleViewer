import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AudioLines,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Disc3,
  Headphones,
  Layers3,
  LockKeyhole,
  LockKeyholeOpen,
  Radio,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Waves,
} from "lucide-react";
import { useLiveJam } from "../hooks/useLiveJam";
import type { DetectedKeyState } from "../hooks/useDetectedKey";
import type { MediaSessionUiState } from "../hooks/useMediaSession";
import type { useCloudKeyResolution } from "../hooks/useCloudKeyResolution";
import type { PracticeSession } from "../practice/session";
import { tuningMidi } from "../practice/session";
import { TUNING_PRESETS } from "../tunings";
import { buildScaleNotes } from "../scaleSpell";
import { getDiatonicTriads } from "../chords/scaleChordTheory";
import { resolveChordVoicings } from "../chords/resolveChordVoicings";
import { ChordDiagram } from "../ChordDiagram";
import { Fretboard, musicalLabel } from "./Fretboard";
import { JamListeningProgress } from "./JamListeningProgress";
import "./live-jam.css";

type Props = {
  media: MediaSessionUiState;
  detected: DetectedKeyState;
  cloud: ReturnType<typeof useCloudKeyResolution>;
  session: PracticeSession;
  onRetry: () => void;
  onAudition: (notes: readonly number[]) => void;
  activeMidi: readonly number[];
};
const ROOTS = [
  "C",
  "C#",
  "Db",
  "D",
  "Eb",
  "E",
  "F",
  "F#",
  "Gb",
  "G",
  "Ab",
  "A",
  "Bb",
  "B",
];
function clock(ms: number | null) {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function LiveJam({
  media,
  detected,
  cloud,
  session,
  onRetry,
  onAudition,
  activeMidi,
}: Props) {
  const playing = media.playbackStatus === "playing";
  const desktop = media.playbackStatus !== "media_session_unavailable";
  const jam = useLiveJam({
    detected,
    cloudHit: cloud.cloudHit,
    trackIdentity: cloud.trackIdentity,
    playing,
  });
  const [tuningId, setTuningId] = useState(session.tuningId);
  const [capo, setCapo] = useState(session.capo);
  const [showChords, setShowChords] = useState(false);
  const [manual, setManual] = useState(false);
  const [labelMode, setLabelMode] = useState<"notes" | "intervals">(
    session.labelMode,
  );
  const [selected, setSelected] = useState<number | null>(null);
  const [voice, setVoice] = useState(0);
  const [focus, setFocus] = useState(false);
  const key = jam.key;
  const root = key?.root ?? "A";
  const scale = key?.scaleType ?? "minor";
  const notes = useMemo(
    () => (key ? buildScaleNotes(root, scale) : []),
    [!!key, root, scale],
  );
  const tuning =
    TUNING_PRESETS.find((t) => t.id === tuningId) ?? TUNING_PRESETS[0]!;
  const openMidi = tuningMidi(tuning.id);
  const chords = useMemo(
    () =>
      key
        ? resolveChordVoicings(getDiatonicTriads(root, scale), {
            tuningId: tuning.id,
            openStringPcs: tuning.openStringPcs,
            capo: capo,
            numFrets: 24,
          })
        : [],
    [!!key, root, scale, tuning, capo],
  );
  useEffect(() => {
    setSelected(null);
    setVoice(0);
  }, [root, scale, capo, tuningId]);
  const chord = selected === null ? null : chords[selected];
  const voicings = chord?.displayVoicings ?? [];
  const voicing = voicings[voice]?.voicing;
  const progress =
    media.durationMs && media.durationMs > 0 && media.positionMs !== null
      ? Math.min(100, Math.max(0, (media.positionMs / media.durationMs) * 100))
      : null;
  const status = !desktop
    ? "Desktop listening"
    : jam.locked
      ? "Key held"
      : !jam.following
        ? "Manual selection"
        : !playing
          ? "Waiting for music"
          : jam.settling
            ? key ? "Checking a key change" : "Settling on a key"
            : key && detected.ambiguous
              ? "Keeping the last key"
              : key
                ? "Following your song"
                : detected.ambiguous && detected.primaryKey
                  ? "Comparing possible keys"
                  : "Listening for harmony";
  const source =
    key?.source === "library"
      ? "Verified song library"
      : key?.source === "manual"
        ? "Chosen by you"
        : "Estimated from audio";
  const title = media.title || "Put a record on.";
  const auditionChord = () => {
    if (!voicing) return;
    const midi = voicing.frets.flatMap((f, i) =>
      f === "x"
        ? []
        : [(openMidi[i] ?? 40) + (f === "o" || f === 0 ? capo : f)],
    );
    onAudition(midi);
  };
  return (
    <section
      className={`jam-screen ${focus ? "jam-focused" : ""}`}
      aria-label="Live Jam workspace"
    >
      <header className="jam-heading">
        <div>
          <span className="screen-kicker">
            <span className="screen-index">04</span> MUSIC IN. POSSIBILITIES
            OUT.
          </span>
          <h1>
            Find your place <em>in the music.</em>
          </h1>
        </div>
        <span className={`jam-status ${playing ? "on" : ""}`}>
          <i />
          {status}
        </span>
      </header>

      <div className="jam-deck">
        <div
          className={`jam-record ${playing ? "spinning" : ""}`}
          aria-hidden="true"
        >
          <div className="record-orbit" />
          <div className="vinyl">
            <div className="vinyl-label">
              <Waves size={30} />
              <span>
                FRETBOARD
                <br />
                SESSIONS
              </span>
              <i />
            </div>
          </div>
          <span className="record-caption">YOUR MUSIC. YOUR MOMENT.</span>
        </div>
        <div className="jam-track">
          <span className="module-label">
            <Headphones size={14} />{" "}
            {playing ? "NOW PLAYING" : "THE LISTENING DECK"}
          </span>
          <h2>{title}</h2>
          <p>
            {media.artist ||
              "Play music in your desktop player. We’ll find a way in."}
          </p>
          {media.album && <span className="jam-album">{media.album}</span>}
          <div className="jam-timeline" aria-label="Song progress">
            <div className="jam-progress">
              <span style={{ width: `${progress ?? 0}%` }} />
            </div>
            <div>
              <span>{clock(media.positionMs)}</span>
              <span>{clock(media.durationMs)}</span>
            </div>
          </div>
          <span className="jam-player">
            <Disc3 size={14} />
            {media.sourceApp ||
              (desktop ? "Your desktop audio" : "Available in the Windows app")}
          </span>
        </div>
        <div className="jam-key-card">
          <span className="module-label">
            {key ? "YOUR TONAL HOME" : "FINDING YOUR TONAL HOME"}
          </span>
          <div aria-live="polite" aria-atomic="true">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={`${root}-${scale}-${!!key}`}
                className="jam-key-value"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
              >
                <strong data-testid="jam-key">
                  {key ? musicalLabel(root) : "—"}
                </strong>
                <span>{key ? scale : "Listening"}</span>
              </motion.div>
            </AnimatePresence>
          </div>
          <span className="jam-source">
            <Sparkles size={13} />
            {key ? source : "The fretboard follows when a key settles"}
          </span>
          <button
            className={`jam-lock ${jam.locked ? "held" : ""}`}
            aria-label={jam.locked ? "Release jam key" : "Hold jam key"}
            aria-pressed={jam.locked}
            onClick={() => jam.setLocked(!jam.locked)}
          >
            {jam.locked ? (
              <LockKeyhole size={15} />
            ) : (
              <LockKeyholeOpen size={15} />
            )}
            {jam.locked ? "Release this key" : "Hold this key"}
          </button>
        </div>
      </div>

      <div className="jam-control-strip">
        <button
          className={`jam-control ${jam.following ? "selected" : ""}`}
          aria-pressed={jam.following}
          disabled={!desktop}
          onClick={() => jam.setFollowing(!jam.following)}
        >
          <Radio size={19} />
          <span>
            <strong>Follow music</strong>
            <small>
              {jam.following ? "Automatic • settled keys" : "Following is off"}
            </small>
          </span>
          <i className="jam-toggle" />
        </button>
        <button
          className={`jam-control ${showChords ? "selected" : ""}`}
          aria-pressed={showChords}
          aria-controls="jam-harmony"
          onClick={() => {
            setShowChords(!showChords);
            setSelected(null);
          }}
        >
          <Layers3 size={19} />
          <span>
            <strong>Chords & shapes</strong>
            <small>Ideas that belong in this key</small>
          </span>
          <i className="jam-toggle" />
        </button>
        <button
          className={`jam-control ${focus ? "selected" : ""}`}
          aria-pressed={focus}
          onClick={() => setFocus(!focus)}
        >
          <Waves size={19} />
          <span>
            <strong>Fretboard focus</strong>
            <small>A little more room to play</small>
          </span>
          <i className="jam-toggle" />
        </button>
      </div>

      {!desktop && (
        <p className="jam-notice">
          Open the Windows app to follow music playing on your computer. You can
          choose a key manually to explore this workspace here.
        </p>
      )}
      {jam.pendingKey && (
        <p className="jam-notice" role="status" data-testid="jam-pending-key">
          Checking {musicalLabel(jam.pendingKey.root)} {jam.pendingKey.scaleType} against fresh audio.
          {key
            ? ` The fretboard and chord ideas stay in ${musicalLabel(root)} ${scale} until the change is sustained.`
            : " The fretboard and chord ideas appear when the estimate is sustained."}
        </p>
      )}
      <div className="jam-map panel">
        <div className="jam-map-heading">
          <div>
            <span className="module-label">THE WHOLE NECK, CONNECTED</span>
            <h2>
              {key
                ? `${musicalLabel(root)} ${scale}`
                : "Your next song, mapped."}
              <span>24 FRETS · {tuning.label}</span>
            </h2>
          </div>
          <div className="jam-map-actions">
            <div className="segmented" aria-label="Jam note labels">
              <button
                className={labelMode === "notes" ? "selected" : ""}
                aria-pressed={labelMode === "notes"}
                onClick={() => setLabelMode("notes")}
              >
                Notes
              </button>
              <button
                className={labelMode === "intervals" ? "selected" : ""}
                aria-pressed={labelMode === "intervals"}
                onClick={() => setLabelMode("intervals")}
              >
                Intervals
              </button>
            </div>
            <button
              className="icon-button"
              aria-label="Choose key manually"
              aria-expanded={manual}
              onClick={() => setManual(!manual)}
            >
              <SlidersHorizontal size={17} />
            </button>
          </div>
        </div>
        {manual && (
          <div className="jam-manual">
            <span>Make it your own</span>
            <label>
              Root
              <select
                aria-label="Jam root"
                value={root}
                onChange={(e) => jam.chooseKey(e.target.value, scale)}
              >
                {ROOTS.map((r) => (
                  <option key={r} value={r}>
                    {musicalLabel(r)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Scale
              <select
                aria-label="Jam scale"
                value={scale}
                onChange={(e) =>
                  jam.chooseKey(root, e.target.value as "major" | "minor")
                }
              >
                <option value="major">Major</option>
                <option value="minor">Minor</option>
              </select>
            </label>
            <button
              className="button subtle"
              onClick={() => jam.chooseKey(root, scale)}
            >
              Use this key
            </button>
            <label>
              Tuning
              <select
                aria-label="Jam tuning"
                value={tuningId}
                onChange={(e) => setTuningId(e.target.value)}
              >
                {TUNING_PRESETS.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Capo
              <select
                aria-label="Jam capo"
                value={capo}
                onChange={(e) => setCapo(Number(e.target.value))}
              >
                {Array.from({ length: 13 }, (_, i) => (
                  <option key={i} value={i}>
                    {i === 0 ? "None" : i}
                  </option>
                ))}
              </select>
            </label>
            <small>
              Manual key changes pause automatic following. Guitar settings stay
              in this workspace.
            </small>
          </div>
        )}
        {!key ? (
          <JamListeningProgress
            detected={detected}
            desktop={desktop}
            playing={playing}
            settling={jam.settling}
            following={jam.following}
            locked={jam.locked}
            suggestions={jam.suggestions}
            onManual={() => setManual(true)}
            onRetry={onRetry}
            onChoose={(root, mode) => {
              jam.chooseKey(root, mode);
              setShowChords(true);
            }}
          />
        ) : (
          <Fretboard
            notes={notes}
            scaleType={scale}
            openMidi={openMidi}
            labels={tuning.stringLabels}
            startFret={capo}
            endFret={24}
            capo={capo}
            labelMode={labelMode}
            display="scale"
            positions={null}
            chordPcs={showChords ? (chord?.chordPitchClasses ?? null) : null}
            activeMidi={activeMidi}
            onNote={(midi) => onAudition([midi])}
            fit
            dimmedOpacity={0.55}
          />
        )}
        <div className="jam-map-footer">
          <div className="note-legend">
            <span>
              <i className="legend-root" />
              Root / home
            </span>
            <span>
              <i className="legend-chord" />
              {chord && showChords
                ? `${musicalLabel(chord.chordName)} chord tones`
                : "Scale tones"}
            </span>
          </div>
          <span>
            {capo ? `Capo ${capo} · ` : ""}Click a note to hear it · Scroll to
            travel the neck
          </span>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {showChords && (
          <motion.section
            id="jam-harmony"
            className="jam-harmony"
            aria-label="Compatible chords and shapes"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className="jam-harmony-heading">
              <div>
                <span className="module-label">A PALETTE TO PLAY WITH</span>
                <h2>Good company for your melody.</h2>
                <p>
                  Chords from this key. Try them by ear—the song may use others.
                </p>
              </div>
              <Layers3 size={27} />
            </div>
            {!key ? (
              <p className="jam-notice">
                {jam.suggestions.length > 0
                  ? "The key is still uncertain. Use a Try key button above to see its chord ideas now."
                  : "No key is available yet. Check the listening status above, or choose a key with the sliders beside the map."}
              </p>
            ) : (
              <>
                <div className="jam-chord-shelf">
                  {chords.map((c, i) => (
                    <button
                      className={`jam-chord-card ${selected === i ? "selected" : ""}`}
                      key={c.degree}
                      aria-label={`Show ${c.chordName} shapes`}
                      aria-pressed={selected === i}
                      onClick={() => {
                        setSelected(selected === i ? null : i);
                        setVoice(0);
                      }}
                    >
                      <span>{c.degree}</span>
                      <strong>{musicalLabel(c.chordName)}</strong>
                      <small>
                        {c.quality === "dim" ? "diminished" : c.quality}
                      </small>
                      <span className="jam-shape-count">
                        {c.displayVoicings.length} shapes{" "}
                        <ChevronRight size={12} />
                      </span>
                    </button>
                  ))}
                </div>
                {chord && (
                  <div className="jam-shape-detail">
                    {voicing ? (
                      <>
                        <div className="jam-diagram">
                          <ChordDiagram
                            voicing={voicing}
                            rootPitchClass={chord.rootPitchClass}
                            openStringPcs={tuning.openStringPcs}
                            capo={capo}
                            stringLabels={tuning.stringLabels}
                            size="sm"
                          />
                        </div>
                        <div>
                          <span className="module-label">
                            SHAPE {voice + 1} / {voicings.length}
                          </span>
                          <h3>
                            {musicalLabel(chord.chordName)}{" "}
                            <span>
                              {voicing.variationLabel ?? voicings[voice]?.shape}
                            </span>
                          </h3>
                          <p>
                            {notes
                              .filter((note) =>
                                chord.chordPitchClasses.includes(
                                  note.pitchClass,
                                ),
                              )
                              .map((note) => musicalLabel(note.label))
                              .join(" · ")}{" "}
                            · {voicing.difficulty}
                          </p>
                          <div className="jam-shape-actions">
                            <button
                              className="icon-button"
                              aria-label="Previous jam shape"
                              disabled={voice === 0}
                              onClick={() => setVoice((v) => v - 1)}
                            >
                              <ChevronLeft size={16} />
                            </button>
                            <button
                              className="button accent"
                              onClick={auditionChord}
                            >
                              <AudioLines size={15} />
                              Hear this shape
                            </button>
                            <button
                              className="icon-button"
                              aria-label="Next jam shape"
                              disabled={voice >= voicings.length - 1}
                              onClick={() => setVoice((v) => v + 1)}
                            >
                              <ChevronRight size={16} />
                            </button>
                          </div>
                          <small>
                            Highlighted notes on the neck are this chord’s
                            tones.
                          </small>
                        </div>
                      </>
                    ) : (
                      <p>No playable shapes found for this tuning and capo.</p>
                    )}
                  </div>
                )}
              </>
            )}
          </motion.section>
        )}
      </AnimatePresence>

      <div className="jam-bottom">
        <section className="jam-history" aria-label="Key journey">
          <span className="module-label">
            KEY JOURNEY <small>THIS TRACK</small>
          </span>
          <div>
            {jam.history.length ? (
              jam.history.map((k, i) => (
                <span
                  className="journey-key"
                  key={`${i}-${k.root}-${k.scaleType}`}
                >
                  {i > 0 && <ChevronRight size={12} />}
                  <b>
                    {musicalLabel(k.root)} {k.scaleType}
                  </b>
                  <small>
                    {k.source === "library"
                      ? "library"
                      : k.source === "manual"
                        ? "manual"
                        : "estimate"}
                  </small>
                </span>
              ))
            ) : (
              <p>Every change of key will find a place here.</p>
            )}
          </div>
        </section>
        <details className="jam-diagnostics">
          <summary>
            Listening details <ChevronDown size={14} />
          </summary>
          <p>
            {key?.source === "library"
              ? "Song-library starting key. Audio analysis continues to follow sustained key changes."
              : `Audio: ${detected.captureMode.replaceAll("_", " ")} · ${detected.bufferSeconds.toFixed(0)} seconds collected.`}
          </p>
          <p>
            Audio key estimates can be uncertain, especially with borrowed
            chords, relative keys, or key changes. Hold a key or choose one
            manually whenever it sounds better.
          </p>
          {cloud.cloudError && (
            <p>Song library unavailable. Local audio analysis continues.</p>
          )}
          <button
            className="button subtle"
            disabled={!desktop}
            onClick={onRetry}
          >
            <RefreshCw size={14} />
            Retry listening
          </button>
        </details>
      </div>
    </section>
  );
}
