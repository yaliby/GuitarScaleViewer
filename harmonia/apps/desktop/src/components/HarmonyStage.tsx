// @ts-nocheck
import { memo } from 'react';
import { Edit3 } from 'lucide-react';
import { formatChord, pitchName } from '../../../../packages/domain/chord';
import { displayChord, type ChordDisplayMode } from '../../../../packages/domain/notation';
import { findSegmentNeighbors } from '../../../../packages/domain/timeline';
import type { Analysis } from '../../../../packages/domain/types';
interface HarmonyStageProps {
  analysis: Analysis;
  index: number;
  time: number;
  transpose: number;
  notation: ChordDisplayMode;
  playing: boolean;
  beatIndex: number;
  onSeek: (seconds: number) => void;
  onEdit: (segmentId: string) => void;
}
export const HarmonyStage = memo(function HarmonyStage({
  analysis,
  index,
  time,
  transpose,
  notation,
  playing,
  beatIndex,
  onSeek,
  onEdit,
}: HarmonyStageProps) {
  const segment = analysis.segments[index],
    chord = segment?.chord ?? { kind: 'unknown' as const };
  const { previous, next } = findSegmentNeighbors(analysis.segments, time);
  const demo = analysis.modelVersion === 'demo-reference-v1';
  return (
    <section className="harmony-stage" aria-label="Synchronized harmony">
      <div className="stage-meta">
        <span className="eyebrow">
          <i className={`status-dot ${playing ? 'pulsing' : ''}`} />
          {playing ? 'IN THE MOMENT' : 'READY WHEN YOU ARE'}
        </span>
        <span className="tag">
          {demo
            ? 'REFERENCE DEMO'
            : analysis.profile === 'accurate'
              ? 'EXPERIMENTAL ML'
              : 'DSP ESTIMATE'}
        </span>
      </div>
      <div className="chord-orbit">
        <div className="neighbor previous">
          <span className="eyebrow">PREVIOUS</span>
          <button onClick={() => previous && onSeek(previous.start)} disabled={!previous}>
            {previous ? displayChord(previous.chord, notation, analysis.key?.root ?? null) : '—'}
          </button>
        </div>
        <div className="current-chord">
          <span className="eyebrow">CURRENT CHORD</span>
          <h1 key={`${index}-${transpose}-${formatChord(chord)}`} data-testid="current-chord">
            {segment ? displayChord(chord, notation, analysis.key?.root ?? null) : '—'}
          </h1>
          <div className="chord-annotation">
            <span className="tiny-dot" />
            {!segment
              ? 'No harmonic label'
              : demo
                ? 'Authored reference'
                : `Model score ${Math.round((segment?.score ?? 0) * 100)}% · uncalibrated`}
          </div>
        </div>
        <div className="neighbor next">
          <span className="eyebrow">UP NEXT</span>
          <button onClick={() => next && onSeek(next.start)} disabled={!next}>
            {next ? displayChord(next.chord, notation, analysis.key?.root ?? null) : '—'}
          </button>
        </div>
      </div>
      <div className="musical-position">
        <span>
          {analysis.meter && beatIndex >= 0
            ? `Bar ${Math.floor(beatIndex / analysis.meter) + 1}`
            : 'Bar —'}
        </span>
        <div className="beat-lights">
          {Array.from({ length: analysis.meter ?? 4 }, (_, i) => (
            <i
              key={i}
              className={analysis.meter && beatIndex % analysis.meter === i ? 'lit' : ''}
            />
          ))}
        </div>
        <span>
          {analysis.meter && beatIndex >= 0
            ? `Beat ${(beatIndex % analysis.meter) + 1} / ${analysis.meter}`
            : 'Meter unknown'}
        </span>
      </div>
      <div className="stage-footer">
        <span>
          {analysis.key ? `${pitchName(analysis.key.root)} ${analysis.key.mode}` : 'Key unknown'}{' '}
          <small>{!demo && analysis.key ? '· estimated' : ''}</small>
        </span>
        <span>
          {analysis.tempo ? `${Math.round(analysis.tempo)} BPM` : 'Tempo unknown'}
          <small>{!demo && analysis.tempo ? ' · estimated' : ''}</small>
        </span>
        <button
          className="text-button"
          disabled={!segment}
          onClick={() => onEdit(segment.id)}
          aria-label="Edit current chord"
        >
          <Edit3 size={13} /> Refine chord
        </button>
      </div>
    </section>
  );
});
