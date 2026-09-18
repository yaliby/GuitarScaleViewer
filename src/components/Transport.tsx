import { useEffect, useState } from "react";
import {
  ChevronDown,
  Minus,
  Plus,
  Play,
  Repeat2,
  Square,
  Volume2,
  AudioLines,
  Timer,
  ListMusic,
} from "lucide-react";
import type { PracticeSession } from "../practice/session";
import type { PlaybackMode } from "../audio/usePracticeAudio";
type Props = {
  session: PracticeSession;
  onChange: (patch: Partial<PracticeSession>) => void;
  playing: PlaybackMode | null;
  beat: number;
  mode: PlaybackMode;
  onMode: (mode: PlaybackMode) => void;
  onPlay: () => void;
  onStop: () => void;
  disabled: boolean;
};
export function Transport({
  session,
  onChange,
  playing,
  beat,
  mode,
  onMode,
  onPlay,
  onStop,
  disabled,
}: Props) {
  const [tempoDraft, setTempoDraft] = useState(String(session.tempo));
  useEffect(() => setTempoDraft(String(session.tempo)), [session.tempo]);
  const commitTempo = () => {
    const tempo = tempoDraft.trim()
      ? Math.round(
          Math.min(220, Math.max(40, Number(tempoDraft) || session.tempo)),
        )
      : session.tempo;
    setTempoDraft(String(tempo));
    if (tempo !== session.tempo) onChange({ tempo });
  };
  return (
    <div className="transport" role="region" aria-label="Practice playback">
      <div className="transport-main">
        <button
          className={`play-button ${playing ? "playing" : ""}`}
          onClick={playing ? onStop : onPlay}
          disabled={!playing && disabled}
          aria-label={
            playing
              ? "Stop playback"
              : mode === "scale"
                ? "Play scale exercise"
                : mode === "progression"
                  ? "Start progression playback"
                  : "Start metronome"
          }
        >
          {playing ? (
            <Square size={19} fill="currentColor" />
          ) : (
            <Play size={21} fill="currentColor" />
          )}
        </button>
        <div className="transport-mode">
          <label className="sr-only" htmlFor="playback-mode">
            Playback mode
          </label>
          <select
            id="playback-mode"
            value={mode}
            onChange={(e) => {
              onStop();
              onMode(e.target.value as PlaybackMode);
            }}
          >
            <option value="scale">Scale exercise</option>
            <option value="progression">Chord progression</option>
            <option value="metronome">Metronome</option>
          </select>
          <ChevronDown size={12} />
          <span>
            {playing
              ? "Playing · stay in the pocket"
              : "Make a little progress today"}
          </span>
        </div>
      </div>
      <div className="tempo-control">
        <button
          onClick={() => onChange({ tempo: Math.max(40, session.tempo - 5) })}
          aria-label="Decrease tempo"
        >
          <Minus size={13} />
        </button>
        <label>
          <input
            aria-label="Tempo"
            type="number"
            min="40"
            max="220"
            value={tempoDraft}
            onChange={(e) => {
              setTempoDraft(e.target.value);
              const tempo = Number(e.target.value);
              if (
                Number.isInteger(tempo) &&
                tempo >= 40 &&
                tempo <= 220 &&
                tempo !== session.tempo
              )
                onChange({ tempo });
            }}
            onBlur={commitTempo}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
          <span>BPM</span>
        </label>
        <button
          onClick={() => onChange({ tempo: Math.min(220, session.tempo + 5) })}
          aria-label="Increase tempo"
        >
          <Plus size={13} />
        </button>
      </div>
      <div
        className="beat-indicator"
        aria-label={playing ? `Beat ${(beat % 4) + 1}` : "Beat indicator"}
      >
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={playing && beat >= 0 && beat % 4 === i ? "active" : ""}
          />
        ))}
      </div>
      <div className="transport-options">
        <button
          className={`icon-button ${session.loop ? "is-active" : ""}`}
          aria-label="Loop playback"
          title="Repeat the exercise or progression"
          aria-pressed={session.loop}
          onClick={() => onChange({ loop: !session.loop })}
        >
          <Repeat2 size={18} />
        </button>
        <button
          className={`icon-button ${session.metronome ? "is-active" : ""}`}
          aria-label="Metronome during practice"
          title="Add a metronome to practice playback"
          aria-pressed={session.metronome}
          onClick={() => onChange({ metronome: !session.metronome })}
        >
          <Timer size={18} />
        </button>
        <div className="volume-control">
          <Volume2 size={16} />
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={session.volume}
            onChange={(e) => onChange({ volume: Number(e.target.value) })}
            aria-label="Playback volume"
          />
        </div>
      </div>
      <span className="transport-hint">
        {mode === "scale" ? (
          <AudioLines size={14} />
        ) : mode === "progression" ? (
          <ListMusic size={14} />
        ) : (
          <Timer size={14} />
        )}{" "}
        {mode === "scale" ? "ONE NOTE AT A TIME" : "FIND YOUR RHYTHM"}
      </span>
    </div>
  );
}
