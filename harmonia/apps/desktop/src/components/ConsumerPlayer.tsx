// @ts-nocheck
import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { ArrowDownToLine, Heart, Pause, Play, RotateCcw, RotateCw } from 'lucide-react';
import type { SavedTrack } from '../../../../packages/domain/types';
import type { CatalogRecording } from '../../../../packages/application/catalog-contracts';
import type { SessionController } from '../../../../packages/application/session';
import { findSegmentIndex, transposeAnalysis } from '../../../../packages/domain/timeline';
import type { ChordDisplayMode } from '../../../../packages/domain/notation';
import { pitchName } from '../../../../packages/domain/chord';
import { buildPracticeArrangement } from '../../../../packages/domain/practice-arrangement';
import {
  createAnalysisExport,
  createTimelineExport,
} from '../../../../packages/application/export';
import { downloadAnalysisExport } from '../../../../packages/providers/browser-export';
import { ChordEditor } from './ChordEditor';
import { ChordInspector } from './ChordInspector';
import { ChordProgression } from './ChordProgression';
import { ChordLibrary } from './ChordLibrary';
import { PracticeControls } from './PracticeControls';
import { SongArtwork } from './SongTypeahead';
import { Timeline, timeLabel } from './Timeline';
import { usePlaybackClock } from './usePlaybackClock';
import { usePlaybackShortcuts } from './usePlaybackShortcuts';

/** What the player hands a host-drawn panel that follows the song (the lyric sheet). */
export interface PlayerSlot {
  segments: SavedTrack['analysis']['segments'];
  notation: ChordDisplayMode;
  keyRoot: number | null;
  time: number;
  playing: boolean;
  seekRevision: number;
  seek(seconds: number): void;
}

export function ConsumerPlayer({
  record,
  controller,
  recording,
  preparationSeconds,
  onReanalyze,
  sheet,
}: {
  record: SavedTrack;
  controller: SessionController;
  recording?: CatalogRecording | null;
  preparationSeconds?: number | null;
  onReanalyze?(): void;
  /** Drawn under the transport, on the player's clock. */
  sheet?(slot: PlayerSlot): ReactNode;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const source = recording ?? record.source;
  const { time, playing, seek, seekRevision } = usePlaybackClock(controller.player);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [transpose, setTranspose] = useState(0);
  const [notation, setNotation] = useState<ChordDisplayMode>('advanced');
  const [speed, setSpeed] = useState(1);
  const [volume, setVolume] = useState(controller.player.volume);
  const [practiceMode, setPracticeMode] = useState<'classic' | 'easy'>('classic');
  const [capo, setCapo] = useState<number | 'recommended'>('recommended');
  const analysis = useMemo(
    () => (transpose ? transposeAnalysis(record.analysis, transpose) : record.analysis),
    [record.analysis, transpose],
  );
  const index = findSegmentIndex(analysis.segments, time);
  const segment = analysis.segments[index];
  const arrangement = useMemo(
    () =>
      buildPracticeArrangement(analysis.segments, {
        mode: practiceMode,
        capo: practiceMode === 'classic' ? 0 : capo,
      }),
    [analysis.segments, practiceMode, capo],
  );
  const arrangedOccurrences = useMemo(
    () => new Map(arrangement.occurrences.map((item) => [item.segmentId, item])),
    [arrangement],
  );
  const currentArrangement = segment ? arrangedOccurrences.get(segment.id) : undefined;
  const suggestedVoicing = useMemo(
    () =>
      currentArrangement
        ? {
            ...currentArrangement,
            capo: arrangement.capo,
            shapeLabel: arrangement.entries.find((entry) => entry.id === currentArrangement.entryId)
              ?.shapeLabel,
          }
        : undefined,
    [currentArrangement, arrangement],
  );
  const editing = record.analysis.segments.find((item) => item.id === editingId);
  const boundedSeek = (value: number) => seek(Math.max(0, Math.min(analysis.duration, value)));
  usePlaybackShortcuts(controller, analysis.duration, editingId, seek);
  return (
    <section className="consumer-player" aria-label="Song player">
      <div className="consumer-track">
        <SongArtwork recording={source} className="player-cover" />
        <div>
          <span className="eyebrow">YOUR LISTENING ROOM</span>
          <h1 data-testid="track-title">{source?.title ?? record.track.name}</h1>
          <p>
            {source?.artist ?? 'Your recording'} <span aria-hidden="true">·</span>{' '}
            {timeLabel(analysis.duration)}
          </p>
        </div>
        <button
          className={`icon-button ${record.track.favorite ? 'selected' : ''}`}
          aria-label="Favorite track"
          aria-pressed={record.track.favorite}
          onClick={() => void controller.favorite()}
        >
          <Heart size={22} fill={record.track.favorite ? 'currentColor' : 'none'} />
        </button>
      </div>
      <div className="consumer-transport">
        <button
          className="icon-button jump-button"
          aria-label="Back 10 seconds"
          onClick={() => boundedSeek(time - 10)}
        >
          <RotateCcw size={25} />
          <span>10</span>
        </button>
        <button
          className="play-button"
          aria-label={playing ? 'Pause' : 'Play'}
          disabled={!controller.player.available}
          onClick={() => void controller.togglePlayback()}
        >
          {playing ? (
            <Pause size={26} fill="currentColor" />
          ) : (
            <Play size={26} fill="currentColor" />
          )}
        </button>
        <button
          className="icon-button jump-button"
          aria-label="Forward 10 seconds"
          onClick={() => boundedSeek(time + 10)}
        >
          <RotateCw size={25} />
          <span>10</span>
        </button>
      </div>
      <div className="consumer-position">
        <span>{timeLabel(time)}</span>
        <input
          className="seek-range"
          aria-label="Playback position"
          type="range"
          min="0"
          max={analysis.duration}
          step="0.01"
          value={time}
          onChange={(event) => boundedSeek(Number(event.target.value))}
        />
        <span>{timeLabel(analysis.duration)}</span>
      </div>
      {!controller.player.available && (
        <p className="notice">
          Reopen this recording to listen. Your chords and corrections are saved.
        </p>
      )}
      {sheet?.({
        segments: analysis.segments,
        notation,
        keyRoot: analysis.key?.root ?? null,
        time,
        playing,
        seekRevision,
        seek,
      })}
      <Timeline analysis={analysis} time={time} index={index} onSeek={seek} notation={notation} />
      <ChordProgression
        segments={analysis.segments}
        index={index}
        notation={notation}
        keyRoot={analysis.key?.root ?? null}
        playing={playing}
        seekRevision={seekRevision}
        onSeek={seek}
      />
      <section className="consumer-details" aria-label="Practice tools">
        <div className="practice-heading">
          <div>
            <span className="eyebrow">PLAY ALONG</span>
            <h2>Make it your own</h2>
          </div>
          <p>Your key, your pace. Everything you need to practice.</p>
        </div>
        <div className="consumer-details-body">
          <div className="practice-settings">
            <div className="consumer-song-facts">
              {analysis.key && (
                <span>
                  Key: {pitchName(analysis.key.root)} {analysis.key.mode} · estimated
                </span>
              )}
              {analysis.tempo !== null && <span>{Math.round(analysis.tempo)} BPM · estimated</span>}
              {analysis.meter && <span>Meter: {analysis.meter}</span>}
              <span>
                {state.saveState === 'saved'
                  ? 'Saved on this device'
                  : state.saveState === 'saving'
                    ? 'Saving locally…'
                    : 'Changes not saved'}
              </span>
            </div>
            <p>
              Complete timeline ready · {analysis.segments.length} chord segments
              {preparationSeconds != null
                ? ` · Prepared in ${preparationSeconds.toFixed(2)} s`
                : ''}
              .
            </p>
            {state.stage === 'Loaded cached analysis' && <p>Loaded cached analysis.</p>}
            <div className="consumer-detail-actions">
              <button
                className="secondary"
                aria-label="Edit current chord"
                disabled={!segment}
                onClick={() => setEditingId(segment.id)}
              >
                Refine chord
              </button>
              <button
                className="secondary"
                onClick={() => downloadAnalysisExport(createAnalysisExport(record))}
              >
                <ArrowDownToLine size={14} /> Export
              </button>
              <button
                className="secondary"
                onClick={() => downloadAnalysisExport(createTimelineExport(record))}
              >
                Export timeline
              </button>
              {onReanalyze && (
                <button className="text-button" onClick={onReanalyze}>
                  Analyze again
                </button>
              )}
            </div>
            {isTauri() && record.analysis.modelVersion === 'dsp-whole-song-v1' && (
              <p className="notice" role="status">
                This analysis used the prototype decoder, not the desktop recognizer. Analyze again
                to rebuild the chord timeline.
              </p>
            )}
            <PracticeControls
              transpose={transpose}
              onChange={setTranspose}
              mode={notation}
              onModeChange={setNotation}
              hasKey={analysis.key !== null}
            />
            <div className="consumer-audio-options">
              <label>
                Speed{' '}
                <select
                  aria-label="Playback speed"
                  value={speed}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    controller.player.setSpeed(value);
                    setSpeed(value);
                  }}
                >
                  {[0.5, 0.75, 1, 1.25, 1.5].map((value) => (
                    <option key={value} value={value}>
                      {value}×
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Volume{' '}
                <input
                  aria-label="Volume"
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={volume}
                  onChange={(event) => {
                    controller.player.setVolume(Number(event.target.value));
                    setVolume(controller.player.volume);
                  }}
                />
              </label>
            </div>
          </div>
          <ChordInspector
            practiceVoicings={suggestedVoicing}
            segment={segment}
            index={index}
            transpose={transpose}
            onSelectChord={(id, chord) =>
              void controller.editChord(id, chord).catch(() => undefined)
            }
          />
          {source?.audio && source.audio.kind !== 'acquired' && (
            <p className="song-attribution">
              Recording: {source.audio.attribution} ·{' '}
              <a href={source.pageUrl} target="_blank" rel="noreferrer">
                Source and credits
              </a>{' '}
              ·{' '}
              <a href={source.audio.licenseUrl} target="_blank" rel="noreferrer">
                {source.audio.license}
              </a>
              . Analysis and playback use this same recording.
            </p>
          )}
          <p className="analysis-note">{analysis.warnings.join(' ')}</p>
        </div>
      </section>
      <ChordLibrary
        arrangement={arrangement}
        transpose={transpose}
        onSeek={seek}
        onModeChange={setPracticeMode}
        capoChoice={capo}
        onCapoChange={setCapo}
      />
      {editing && (
        <ChordEditor
          key={editing.id}
          segment={editing}
          controller={controller}
          transposed={transpose !== 0}
          onClose={() => setEditingId(null)}
        />
      )}
    </section>
  );
}
