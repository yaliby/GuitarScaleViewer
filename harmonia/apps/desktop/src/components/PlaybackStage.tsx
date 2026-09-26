// @ts-nocheck
import { useCallback, useEffect, useMemo, useState } from 'react';
import { findSegmentIndex, transposeAnalysis } from '../../../../packages/domain/timeline';
import type { Chord, SavedTrack } from '../../../../packages/domain/types';
import type { ChordDisplayMode } from '../../../../packages/domain/notation';
import type { SessionController } from '../../../../packages/application/session';
import { ChordEditor } from './ChordEditor';
import { ChordInspector } from './ChordInspector';
import { HarmonyStage } from './HarmonyStage';
import { PracticeControls } from './PracticeControls';
import { Timeline } from './Timeline';
import { Transport } from './Transport';
import { usePlaybackClock } from './usePlaybackClock';
import { usePlaybackShortcuts } from './usePlaybackShortcuts';
export function PlaybackStage({
  record,
  controller,
}: {
  record: SavedTrack;
  controller: SessionController;
}) {
  const { time, playing, seek } = usePlaybackClock(controller.player);
  const [transpose, setTranspose] = useState(0),
    [volume, setVolume] = useState(controller.player.volume),
    [notation, setNotation] = useState<ChordDisplayMode>('advanced'),
    [editingId, setEditingId] = useState<string | null>(null),
    [loopId, setLoopId] = useState<string | null>(null),
    [loop, setLoop] = useState(false),
    [speed, setSpeed] = useState(1);
  const analysis = useMemo(
    () => (transpose ? transposeAnalysis(record.analysis, transpose) : record.analysis),
    [record.analysis, transpose],
  );
  const index = findSegmentIndex(analysis.segments, time),
    segment = analysis.segments[index];
  usePlaybackShortcuts(controller, record.analysis.duration, editingId);
  useEffect(() => {
    setTranspose(0);
    setLoop(false);
    setSpeed(1);
    controller.player.setSpeed(1);
  }, [record.track.id, controller]);
  useEffect(() => {
    const selected = record.analysis.segments.find((item) => item.id === loopId);
    controller.player.setLoop(
      loop && selected ? { start: selected.start, end: selected.end } : null,
    );
  }, [loop, loopId, record.analysis, controller]);
  const segmentId = segment?.id;
  const toggleLoop = useCallback(() => {
    const next = !loop;
    setLoop(next);
    setLoopId(next && segmentId ? segmentId : null);
  }, [loop, segmentId]);
  const togglePlayback = useCallback(() => {
    void controller.togglePlayback();
  }, [controller]);
  const changeSpeed = useCallback(
    (value: number) => {
      controller.player.setSpeed(value);
      setSpeed(value);
    },
    [controller],
  );
  const changeVolume = useCallback(
    (value: number) => {
      controller.player.setVolume(value);
      setVolume(controller.player.volume);
    },
    [controller],
  );
  const selectChord = useCallback(
    (id: string, chord: Chord) => {
      void controller.editChord(id, chord).catch(() => undefined);
    },
    [controller],
  );
  const editedSegment = useMemo(
    () => record.analysis.segments.find((item) => item.id === editingId),
    [record.analysis.segments, editingId],
  );
  const beatIndex = analysis.beats.findLastIndex((beat) => beat <= time);
  return (
    <>
      <div className="listening-grid">
        <HarmonyStage
          analysis={analysis}
          index={index}
          time={time}
          transpose={transpose}
          notation={notation}
          playing={playing}
          beatIndex={beatIndex}
          onSeek={seek}
          onEdit={setEditingId}
        />
        <ChordInspector
          segment={segment}
          index={index}
          transpose={transpose}
          onSelectChord={selectChord}
        />
      </div>
      <Transport
        time={time}
        duration={analysis.duration}
        playing={playing}
        available={controller.player.available}
        hasSegment={Boolean(segment)}
        loop={loop}
        speed={speed}
        volume={volume}
        onSeek={seek}
        onTogglePlayback={togglePlayback}
        onToggleLoop={toggleLoop}
        onSpeedChange={changeSpeed}
        onVolumeChange={changeVolume}
      />
      <Timeline analysis={analysis} time={time} index={index} onSeek={seek} notation={notation} />
      <PracticeControls
        transpose={transpose}
        onChange={setTranspose}
        mode={notation}
        onModeChange={setNotation}
        hasKey={analysis.key !== null}
      />
      {(notation === 'roman' || notation === 'nashville') && (
        <p className="notice">
          Degrees use the major scale relative to the displayed tonic, including in minor keys.
          Local key changes are not inferred.
        </p>
      )}
      {!controller.player.available && (
        <p className="notice">
          Saved analysis loaded. Reopen its audio file to listen; your corrections are preserved.
        </p>
      )}
      <p className="analysis-note">{analysis.warnings[0]}</p>
      {editedSegment && (
        <ChordEditor
          key={editedSegment.id}
          segment={editedSegment}
          controller={controller}
          transposed={transpose !== 0}
          onClose={() => setEditingId(null)}
        />
      )}
    </>
  );
}
