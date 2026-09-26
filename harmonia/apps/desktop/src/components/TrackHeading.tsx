// @ts-nocheck
import { ArrowDownToLine, ArrowUpRight, AudioLines, Check, Heart } from 'lucide-react';
import type { SavedTrack } from '../../../../packages/domain/types';
import type { SessionState } from '../../../../packages/application/session';
import { timeLabel } from './Timeline';

export function TrackHeading({
  record,
  saveState,
  onFavorite,
  onExport,
  onExportTimeline,
  onLibrary,
}: {
  record: SavedTrack;
  saveState: SessionState['saveState'];
  onFavorite: () => void;
  onExport: () => void;
  onExportTimeline: () => void;
  onLibrary: () => void;
}) {
  return (
    <div className="track-heading">
      <div className="album-art">
        <AudioLines size={35} strokeWidth={1} />
        <span>h.</span>
      </div>
      <div className="track-info">
        <span className="eyebrow">YOUR LISTENING ROOM</span>
        <h2 data-testid="track-title">{record.track.name}</h2>
        <div className="track-meta">
          <span>
            {record.analysis.modelVersion === 'demo-reference-v1'
              ? 'Synthetic studio demonstration'
              : 'Local audio'}
          </span>
          <i /> <span>{timeLabel(record.track.duration)}</span>
          <i />
          <span>
            <Check size={12} />{' '}
            {saveState === 'saved'
              ? 'Saved on this device'
              : saveState === 'saving'
                ? 'Saving locally…'
                : 'Changes not saved'}
          </span>
        </div>
      </div>
      <div className="track-actions">
        <button
          className={`icon-button ${record.track.favorite ? 'selected' : ''}`}
          aria-label="Favorite track"
          aria-pressed={record.track.favorite}
          onClick={onFavorite}
        >
          <Heart size={20} fill={record.track.favorite ? 'currentColor' : 'none'} />
        </button>
        <button className="secondary" onClick={onExport}>
          <ArrowDownToLine size={14} /> Export
        </button>
        <button
          className="secondary"
          onClick={onExportTimeline}
          title="Original corrected chords and timestamps as a Harte .lab file"
        >
          Export timeline
        </button>
        <button className="text-button" onClick={onLibrary}>
          All sessions <ArrowUpRight size={14} />
        </button>
      </div>
    </div>
  );
}
