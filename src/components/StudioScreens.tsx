import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowDown,
  ArrowUpRight,
  AudioLines,
  ChevronDown,
  Disc3,
  Layers3,
  Play,
  Repeat2,
  Square,
  Target,
  Waves,
} from "lucide-react";
import type { PracticeSession } from "../practice/session";
import type { ScaleNote } from "../scaleSpell";
import { musicalLabel } from "./Fretboard";
import "./studio-screens.css";

export type StudioView = "explore" | "practice" | "progressions" | "jam";
type Props = {
  view: StudioView;
  context: ReactNode;
  board: ReactNode;
  chords: ReactNode;
  listening: ReactNode;
  jam: ReactNode;
  session: PracticeSession;
  notes: ScaleNote[];
  playing: string | null;
  beat: number;
  chordName: string;
  nextChord: string;
  position: string;
  exerciseCount: number;
  practiceDisabled: boolean;
  onChange: (patch: Partial<PracticeSession>) => void;
  onPractice: () => void;
  onStop: () => void;
  onAudition: (midi: readonly number[]) => void;
  onNavigate: (view: StudioView) => void;
};

function PitchOrbit({
  notes,
  onAudition,
}: Pick<Props, "notes" | "onAudition">) {
  const root = notes[0]?.pitchClass ?? 9;
  return (
    <svg
      className="pitch-orbit"
      viewBox="0 0 180 180"
      role="group"
      aria-label="Scale pitch map"
    >
      <circle cx="90" cy="90" r="62" className="orbit-guide" />
      <circle cx="90" cy="90" r="43" className="orbit-inner" />
      <polygon
        points={notes
          .map((note) => {
            const a =
              (((note.pitchClass - root + 12) % 12) * Math.PI) / 6 -
              Math.PI / 2;
            return `${90 + 62 * Math.cos(a)},${90 + 62 * Math.sin(a)}`;
          })
          .join(" ")}
      />
      {Array.from({ length: 12 }, (_, i) => {
        const a = (i * Math.PI) / 6 - Math.PI / 2,
          x = 90 + 62 * Math.cos(a),
          y = 90 + 62 * Math.sin(a);
        const note = notes.find((n) => n.pitchClass === (root + i) % 12);
        return (
          <g key={i}>
            <circle
              cx={x}
              cy={y}
              r={note ? 5 : 2}
              className={note ? "orbit-note" : "orbit-empty"}
            />
            {note && (
              <g
                role="button"
                tabIndex={0}
                aria-label={`Audition ${musicalLabel(note.label)} from pitch map`}
                onClick={() => onAudition([60 + note.pitchClass])}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onAudition([60 + note.pitchClass]);
                  }
                }}
              >
                <circle
                  cx={90 + 79 * Math.cos(a)}
                  cy={90 + 79 * Math.sin(a)}
                  r="10"
                  fill="transparent"
                />
                <text x={90 + 79 * Math.cos(a)} y={93 + 79 * Math.sin(a)}>
                  {musicalLabel(note.label)}
                </text>
              </g>
            )}
          </g>
        );
      })}
      <text x="90" y="88" className="orbit-root">
        {musicalLabel(notes[0]?.label ?? "A")}
      </text>
      <text x="90" y="105" className="orbit-caption">
        {notes.length} TONES
      </text>
    </svg>
  );
}

export function StudioScreens(p: Props) {
  const reduceMotion = useReducedMotion();
  const { view, session, playing, beat } = p;
  const isRunning = playing !== null;
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={view}
        className={`workspace screen screen-${view}`}
        initial={
          reduceMotion ? false : { opacity: 0, y: 14, filter: "blur(5px)" }
        }
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        exit={
          reduceMotion
            ? { opacity: 0 }
            : { opacity: 0, y: -8, filter: "blur(3px)" }
        }
        transition={{
          duration: reduceMotion ? 0 : 0.22,
          ease: [0.22, 1, 0.36, 1],
        }}
      >
        {view === "jam" && p.jam}
        {view === "explore" && (
          <section className="atlas-screen" aria-label="Scale atlas">
            <header className="screen-heading atlas-heading">
              <div>
                <span className="screen-kicker">
                  <span className="screen-index">01</span> DISCOVER / CONNECT /
                  PLAY
                </span>
                <h1>
                  The neck is
                  <br />
                  <em>your playground.</em>
                </h1>
                <p>Trace a shape. Hear a colour. Make the connection.</p>
              </div>
              <div className="atlas-identity">
                <PitchOrbit notes={p.notes} onAudition={p.onAudition} />
                <span>YOUR SOUND, MAPPED</span>
              </div>
            </header>
            {p.context}
            <div className="atlas-board">{p.board}</div>
            <div className="atlas-bottom">
              <div>
                {p.chords}
                <button
                  className="screen-link"
                  onClick={() => p.onNavigate("progressions")}
                >
                  Take these chords to the arranger <ArrowUpRight size={16} />
                </button>
              </div>
              {p.listening}
            </div>
          </section>
        )}
        {view === "practice" && (
          <section className="practice-screen" aria-label="Practice room">
            <header className="screen-heading">
              <div>
                <span className="screen-kicker">
                  <span className="screen-index">02</span> THE PRACTICE ROOM
                </span>
                <h1>
                  Less thinking.
                  <br />
                  <em>More playing.</em>
                </h1>
              </div>
              <span className={`session-status ${isRunning ? "running" : ""}`}>
                <i />
                {isRunning ? "SESSION IN MOTION" : "READY WHEN YOU ARE"}
              </span>
            </header>
            <div className="practice-stage">
              <aside className="practice-setup">
                <span className="module-label">
                  <Target size={14} /> YOUR FOCUS
                </span>
                <h2>
                  {musicalLabel(session.root)}{" "}
                  <span>{session.scaleType.replaceAll("-", " ")}</span>
                </h2>
                <p>{p.position}</p>
                <label className="room-field">
                  Exercise direction
                  <select
                    aria-label="Exercise direction"
                    value={session.direction}
                    onChange={(e) =>
                      p.onChange({
                        direction: e.target
                          .value as PracticeSession["direction"],
                      })
                    }
                  >
                    <option value="ascending">Ascending ↗</option>
                    <option value="descending">Descending ↘</option>
                    <option value="up-down">Up and back ↗↘</option>
                  </select>
                </label>
                <button
                  className={`room-toggle ${session.loop ? "enabled" : ""}`}
                  aria-pressed={session.loop}
                  onClick={() => p.onChange({ loop: !session.loop })}
                >
                  <Repeat2 size={17} />
                  <span>Keep it looping</span>
                  <i />
                </button>
                <div className="focus-advice">
                  <Waves size={20} />
                  <p>
                    Start slowly enough to make every note sound intentional.
                  </p>
                </div>
              </aside>
              <div className={`tempo-stage ${isRunning ? "is-playing" : ""}`}>
                <div className="tempo-orbit" aria-hidden>
                  <span />
                  <span />
                  <span />
                </div>
                <span className="module-label">FIND YOUR PULSE</span>
                <div className="hero-tempo">
                  <motion.strong
                    key={session.tempo}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.15 }}
                  >
                    {session.tempo}
                  </motion.strong>
                  <span>BPM</span>
                </div>
                <div className="room-beats" aria-label="Practice beat display">
                  {[0, 1, 2, 3].map((i) => (
                    <span
                      key={i}
                      className={
                        isRunning && beat >= 0 && beat % 4 === i ? "lit" : ""
                      }
                    >
                      {String(i + 1).padStart(2, "0")}
                    </span>
                  ))}
                </div>
                <button
                  className="focus-play"
                  disabled={!isRunning && p.practiceDisabled}
                  aria-label={
                    isRunning
                      ? "Stop focused practice"
                      : "Start focused practice"
                  }
                  onClick={isRunning ? p.onStop : p.onPractice}
                >
                  {isRunning ? (
                    <Square size={17} fill="currentColor" />
                  ) : (
                    <Play size={17} fill="currentColor" />
                  )}
                  {isRunning ? "Pause & breathe" : "Start your session"}
                </button>
                {p.practiceDisabled && (
                  <p className="practice-warning">
                    Choose a complete position below to begin.
                  </p>
                )}
              </div>
              <aside className="practice-readout">
                <div>
                  <AudioLines size={20} />
                  <strong>{p.exerciseCount}</strong>
                  <span>NOTES IN YOUR RANGE</span>
                </div>
                <div>
                  <Disc3 size={20} />
                  <strong>{session.metronome ? "On" : "Off"}</strong>
                  <span>METRONOME</span>
                </div>
                <div className="practice-mantra">
                  Accuracy first.
                  <br />
                  <em>Speed follows.</em>
                </div>
              </aside>
            </div>
            <div className="room-neck-heading">
              <span>
                <span className="module-label">YOUR WORKING NECK</span>
                <small>Every repetition starts here.</small>
              </span>
              <ArrowDown size={18} />
            </div>
            {p.context}
            {p.board}
          </section>
        )}
        {view === "progressions" && (
          <section
            className="arranger-screen"
            aria-label="Progression arranger"
          >
            <header className="screen-heading">
              <div>
                <span className="screen-kicker">
                  <span className="screen-index">03</span> THE ARRANGEMENT DESK
                </span>
                <h1>
                  Give your chords
                  <br />
                  <em>somewhere to go.</em>
                </h1>
              </div>
              <div className="arrangement-meta">
                <Layers3 size={20} />
                <strong>{session.progression.length}</strong>
                <span>CHORDS / {session.progression.length * 4} BEATS</span>
              </div>
            </header>
            {p.context}
            <div className="arranger-layout">
              <div className="arrangement-desk">{p.chords}</div>
              <aside
                className={`now-playing-card ${playing === "progression" ? "active" : ""}`}
              >
                <span className="module-label">
                  <span className="live-indicator" />
                  {playing === "progression"
                    ? "ON THE PLAYHEAD"
                    : "FIRST IN THE SEQUENCE"}
                </span>
                <AnimatePresence mode="wait">
                  <motion.strong
                    key={p.chordName}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.18 }}
                  >
                    {musicalLabel(p.chordName || "—")}
                  </motion.strong>
                </AnimatePresence>
                <div className="arranger-meter">
                  {[0, 1, 2, 3].map((i) => (
                    <i
                      key={i}
                      className={
                        playing === "progression" && beat >= 0 && beat % 4 === i
                          ? "lit"
                          : ""
                      }
                    />
                  ))}
                </div>
                <p>
                  Let it ring.
                  <br />
                  Hear where it wants to land.
                </p>
                <div className="next-chord">
                  <span>UP NEXT</span>
                  <strong>{musicalLabel(p.nextChord || "—")}</strong>
                  <ArrowUpRight size={18} />
                </div>
                <small>{session.tempo} BPM · 4 BEATS PER CHORD</small>
              </aside>
            </div>
            <details className="arranger-neck">
              <summary>
                <span>
                  <Waves size={18} /> Fretboard reference{" "}
                  <small>See the notes behind your chords</small>
                </span>
                <ChevronDown size={18} />
              </summary>
              {p.board}
            </details>
          </section>
        )}
        <footer className="screen-footer">
          <span>
            FRETBOARD STUDIO <i /> {view.toUpperCase()}
          </span>
          <span>Made for the long game.</span>
        </footer>
      </motion.div>
    </AnimatePresence>
  );
}
