// @ts-nocheck
import { Pause, Play, Repeat2, SkipBack, Volume2 } from 'lucide-react';
import { timeLabel } from './Timeline';
interface TransportProps {
  time: number;
  duration: number;
  playing: boolean;
  available: boolean;
  hasSegment: boolean;
  loop: boolean;
  speed: number;
  volume: number;
  onSeek: (seconds: number) => void;
  onTogglePlayback: () => void;
  onToggleLoop: () => void;
  onSpeedChange: (speed: number) => void;
  onVolumeChange: (volume: number) => void;
}
export function Transport({
  time,
  duration,
  playing,
  available,
  hasSegment,
  loop,
  speed,
  volume,
  onSeek,
  onTogglePlayback,
  onToggleLoop,
  onSpeedChange,
  onVolumeChange,
}: TransportProps) {
  return (
    <>
      <div className="transport">
        <div className="transport-time">
          <strong>{timeLabel(time)}</strong>
          <span>/ {timeLabel(duration)}</span>
        </div>
        <div className="transport-main">
          <button className="icon-button" aria-label="Restart" onClick={() => onSeek(0)}>
            <SkipBack size={18} />
          </button>
          <button
            className="play-button"
            aria-label={playing ? 'Pause' : 'Play'}
            disabled={!available}
            onClick={() => onTogglePlayback()}
          >
            {playing ? (
              <Pause size={22} fill="currentColor" />
            ) : (
              <Play size={22} fill="currentColor" />
            )}
          </button>
          <button
            className={`icon-button ${loop ? 'selected' : ''}`}
            aria-label="Loop current chord"
            aria-pressed={loop}
            disabled={!hasSegment}
            onClick={onToggleLoop}
          >
            <Repeat2 size={20} />
          </button>
        </div>
        <div className="transport-options">
          <label className="speed">
            Speed
            <select
              aria-label="Playback speed"
              value={speed}
              onChange={(event) => {
                const value = Number(event.target.value);
                onSpeedChange(value);
              }}
            >
              {[0.5, 0.75, 1, 1.25, 1.5].map((v) => (
                <option key={v} value={v}>
                  {v}×
                </option>
              ))}
            </select>
          </label>
          <Volume2 size={16} />
          <input
            aria-label="Volume"
            className="volume"
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={volume}
            onChange={(event) => {
              onVolumeChange(Number(event.target.value));
            }}
          />
        </div>
      </div>
      <input
        className="seek-range"
        aria-label="Playback position"
        type="range"
        min="0"
        max={duration}
        step="0.01"
        value={time}
        onChange={(event) => onSeek(Number(event.target.value))}
      />
    </>
  );
}
