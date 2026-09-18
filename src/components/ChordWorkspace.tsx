import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronLeft,
  ChevronRight,
  Layers3,
  Plus,
  Play,
  Trash2,
  Music2,
} from "lucide-react";
import { ChordDiagram } from "../ChordDiagram";
import type { ScaleChordWithVoicings } from "../chords/chordTypes";
import { musicalLabel } from "./Fretboard";

type Props = {
  chords: ScaleChordWithVoicings[];
  selected: number | null;
  voicingIndex: number;
  onSelect: (n: number) => void;
  onVoicing: (n: number) => void;
  onAudition: () => void;
  labels: readonly string[];
  openPcs: readonly number[];
  capo: number;
  progression: number[];
  onProgression: (p: number[]) => void;
  showProgression: boolean;
  activeChord: number | undefined;
  onPlayProgression: () => void;
  parentLabel: string | null;
};
export function ChordWorkspace({
  chords,
  selected,
  voicingIndex,
  onSelect,
  onVoicing,
  onAudition,
  labels,
  openPcs,
  capo,
  progression,
  onProgression,
  showProgression,
  activeChord,
  onPlayProgression,
  parentLabel,
}: Props) {
  const chord = chords[selected ?? 0];
  const voices = chord?.displayVoicings ?? [];
  const current = voices[voicingIndex] ?? voices[0];
  return (
    <section
      className="panel chord-workspace"
      aria-label="Chords and progressions"
    >
      <div className="panel-heading">
        <div className="heading-with-icon">
          <Layers3 size={17} />
          <h2>
            {showProgression ? "Your chord progression" : "Chords in this key"}
          </h2>
        </div>
        <span className="small-tag">DIATONIC TRIADS</span>
      </div>
      {parentLabel && (
        <p className="section-note">
          Harmony from the parent {parentLabel} scale.
        </p>
      )}
      <div className="chord-strip">
        {chords.map((c, i) => (
          <button
            key={c.degree}
            className={`chord-chip ${selected === i ? "selected" : ""}`}
            onClick={() => onSelect(i)}
            aria-label={`Select ${c.chordName} chord`}
            aria-pressed={selected === i}
          >
            <span>{c.degree}</span>
            <strong>{musicalLabel(c.chordName)}</strong>
            <i>
              {c.quality === "major"
                ? "major"
                : c.quality === "minor"
                  ? "minor"
                  : c.quality}
            </i>
          </button>
        ))}
      </div>
      {showProgression && (
        <div className="progression-area">
          <div className="progression-heading">
            <span>4 beats per chord · {progression.length}/16 steps</span>
            <button
              className="text-button"
              disabled={!progression.length}
              onClick={onPlayProgression}
              aria-label="Play progression"
            >
              <Play size={13} />
              Play progression
            </button>
          </div>
          <div className="progression-list">
            <AnimatePresence initial={false}>
              {progression.map((degree, i) => (
                <motion.div
                  layout
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  transition={{ duration: 0.2 }}
                  key={`${i}-${degree}`}
                  className={`progression-step ${activeChord === i ? "playing" : ""}`}
                  data-testid="progression-step"
                >
                  <span className="step-order">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <strong>
                    {musicalLabel(chords[degree]?.chordName ?? "")}
                  </strong>
                  <span>{chords[degree]?.degree}</span>
                  <div className="step-actions">
                    <button
                      aria-label={`Move chord ${i + 1} left`}
                      disabled={i === 0}
                      onClick={() => {
                        const p = [...progression];
                        [p[i - 1], p[i]] = [p[i]!, p[i - 1]!];
                        onProgression(p);
                      }}
                    >
                      <ChevronLeft size={12} />
                    </button>
                    <button
                      aria-label={`Remove chord ${i + 1}`}
                      onClick={() =>
                        onProgression(progression.filter((_, j) => i !== j))
                      }
                    >
                      <Trash2 size={12} />
                    </button>
                    <button
                      aria-label={`Move chord ${i + 1} right`}
                      disabled={i === progression.length - 1}
                      onClick={() => {
                        const p = [...progression];
                        [p[i], p[i + 1]] = [p[i + 1]!, p[i]!];
                        onProgression(p);
                      }}
                    >
                      <ChevronRight size={12} />
                    </button>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
            {!progression.length && (
              <p className="empty-note">
                Choose a chord below and add it to start your progression.
              </p>
            )}
          </div>
        </div>
      )}
      {chord && (
        <div className="chord-detail">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={`${chord.chordName}-${current?.voicing.id}`}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 8 }}
              transition={{ duration: 0.15 }}
              className="chord-diagram-wrap"
            >
              {current ? (
                <ChordDiagram
                  voicing={current.voicing}
                  size="md"
                  isSelected
                  rootPitchClass={chord.rootPitchClass}
                  openStringPcs={openPcs}
                  stringLabels={labels}
                  capo={capo}
                />
              ) : (
                <div className="empty-note">
                  <Music2 size={24} />
                  <p>No comfortable shape found for this tuning and capo.</p>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
          <div className="chord-detail-info">
            <span className="eyebrow">
              {selected === null ? "PREVIEW" : (current?.type ?? "CHORD TONES")}
            </span>
            <h3>
              {musicalLabel(chord.chordName)}{" "}
              <span>
                {chord.quality === "major" || chord.quality === "minor"
                  ? chord.quality
                  : "triad"}
              </span>
            </h3>
            <p>
              {selected === null
                ? "Select a chord above to highlight its notes on the fretboard."
                : "Follow the highlighted chord tones on the fretboard. Click the selected chord again to clear it."}
            </p>
            <div className="shape-choices">
              {voices.map((v, i) => (
                <button
                  key={v.voicing.id}
                  onClick={() => onVoicing(i)}
                  className={i === voicingIndex ? "active" : ""}
                  aria-label={`Chord shape ${i + 1}`}
                  aria-pressed={i === voicingIndex}
                >
                  {i + 1}
                </button>
              ))}
              <span>
                {current?.voicing.difficulty ?? "Explore"}
                {capo > 0 ? ` · capo ${capo}` : ""}
              </span>
            </div>
            <div className="chord-detail-actions">
              <button className="button subtle" onClick={onAudition}>
                <Play size={13} />
                Hear chord
              </button>
              <button
                className="button subtle"
                disabled={progression.length >= 16}
                onClick={() => onProgression([...progression, selected ?? 0])}
                aria-label={`Add ${chord.chordName} to progression`}
              >
                <Plus size={14} />
                Add to progression
              </button>
            </div>
            {current && (
              <span className="shape-description">
                {current.shape} ·{" "}
                {capo ? "Absolute fret numbers" : "Low E → high e"}
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
