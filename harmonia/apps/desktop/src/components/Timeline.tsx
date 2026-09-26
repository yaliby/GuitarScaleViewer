// @ts-nocheck
import { useMemo, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { formatChord } from '../../../../packages/domain/chord';
import { displayChord, type ChordDisplayMode } from '../../../../packages/domain/notation';
import type { Analysis } from '../../../../packages/domain/types';

export function timeLabel(time: number) {
  const minutes = Math.floor(Math.max(0, time) / 60),
    seconds = Math.floor(Math.max(0, time) % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
export function Timeline({
  analysis,
  time,
  index,
  onSeek,
  notation,
}: {
  analysis: Analysis;
  time: number;
  index: number;
  onSeek: (seconds: number) => void;
  notation: ChordDisplayMode;
}) {
  const [zoom, setZoom] = useState(1);
  const waveform = useMemo(
    () =>
      analysis.waveform
        .map((v, i) => `${(i / Math.max(1, analysis.waveform.length - 1)) * 1200},${37 - v * 62}`)
        .join(' '),
    [analysis.waveform],
  );

  const chordLabels = useMemo(
    () =>
      analysis.segments.map((segment) =>
        displayChord(segment.chord, notation, analysis.key?.root ?? null),
      ),
    [analysis.segments, analysis.key, notation],
  );
  const timeRuler = useMemo(
    () => (
      <div className="time-ruler">
        {Array.from({ length: 13 }, (_, i) => (
          <span key={i} style={{ left: `${(i / 12) * 100}%` }}>
            {timeLabel((i / 12) * analysis.duration)}
          </span>
        ))}
      </div>
    ),
    [analysis.duration],
  );
  const waveformLayer = useMemo(
    () => (
      <div className="waveform">
        <svg viewBox="0 0 1200 76" preserveAspectRatio="none" aria-hidden="true">
          <polyline points={waveform} fill="none" stroke="#718881" strokeWidth="1.3" />
          <polyline
            points={waveform}
            transform="translate(0 74) scale(1 -1)"
            fill="none"
            stroke="#718881"
            strokeWidth="1.3"
          />
        </svg>
      </div>
    ),
    [waveform],
  );
  const chordLane = useMemo(
    () => (
      <div className="chord-lane">
        {analysis.segments.map((segment, i) => (
          <button
            key={segment.id}
            className={`chord-block ${i === index ? 'active' : ''}`}
            style={{
              left: `${(segment.start / analysis.duration) * 100}%`,
              width: `${((segment.end - segment.start) / analysis.duration) * 100}%`,
            }}
            onClick={(event) => {
              event.stopPropagation();
              onSeek(segment.start);
            }}
            aria-label={`Seek to ${chordLabels[i]} at ${Number(segment.start.toFixed(3))} seconds`}
            title={`${formatChord(segment.chord)} · ${segment.start.toFixed(2)}–${segment.end.toFixed(2)}s`}
          >
            <span>{chordLabels[i]}</span>
            <small>{(segment.end - segment.start).toFixed(1)}s</small>
          </button>
        ))}
      </div>
    ),
    [analysis.segments, analysis.duration, index, onSeek, chordLabels],
  );
  const beatRuler = useMemo(
    () => (
      <div className="beat-ruler">
        {analysis.beats
          .filter((_, i) => i % Math.max(1, Math.ceil(analysis.beats.length / 300)) === 0)
          .map((beat, i) => (
            <i key={i} style={{ left: `${(beat / analysis.duration) * 100}%` }} />
          ))}
      </div>
    ),
    [analysis.beats, analysis.duration],
  );
  return (
    <section className="timeline-section" aria-label="Chord timeline">
      <div className="section-heading">
        <div>
          <span className="eyebrow">THE HARMONIC LANDSCAPE</span>
          <span className="subtle">{analysis.segments.length} moments · click to explore</span>
        </div>
        <div className="zoom">
          <button
            className="icon-button"
            aria-label="Zoom out"
            disabled={zoom === 1}
            onClick={() => setZoom((z) => Math.max(1, z - 1))}
          >
            <Minus size={15} />
          </button>
          <span>{zoom}×</span>
          <button
            className="icon-button"
            aria-label="Zoom in"
            disabled={zoom === 8}
            onClick={() => setZoom((z) => Math.min(8, z + 1))}
          >
            <Plus size={15} />
          </button>
        </div>
      </div>
      <div className="timeline-scroll">
        <div
          className="timeline-inner"
          style={{ width: `${zoom * 100}%` }}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            onSeek(((event.clientX - rect.left) / rect.width) * analysis.duration);
          }}
        >
          {timeRuler}
          {waveformLayer}
          {chordLane}
          {beatRuler}
          <div
            className="playhead"
            style={{ left: `${Math.min(100, (time / analysis.duration) * 100)}%` }}
          >
            <span />
          </div>
        </div>
      </div>
    </section>
  );
}
