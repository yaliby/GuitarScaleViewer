// @ts-nocheck
import { ArrowUpRight, Heart, Music2, Upload } from 'lucide-react';
import type { SavedTrack } from '../../../../packages/domain/types';
import { timeLabel } from './Timeline';

interface LibraryProps {
  records: SavedTrack[];
  onOpen: (record: SavedTrack) => void;
}

export function LibraryView({
  records,
  onOpen,
  onImport,
}: LibraryProps & { onImport: () => void }) {
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR LOCAL COLLECTION</span>
          <h1>A little closer to the music.</h1>
        </div>
        <button className="primary" onClick={onImport}>
          <Upload size={16} /> Import audio
        </button>
      </div>
      <div className="library-list">
        {records.length === 0 ? (
          <p className="empty-library">
            Your listening history starts here. Import a song or explore the demo.
          </p>
        ) : (
          records.map((record) => (
            <button
              key={record.analysis.id}
              onClick={() => onOpen(record)}
              aria-label={`Open analysis: ${record.track.name}`}
            >
              <span className="library-art">
                <Music2 size={22} />
              </span>
              <span>
                <strong>{record.track.name}</strong>
                <small>
                  {record.analysis.segments.length} chord moments ·{' '}
                  {record.analysis.modelVersion === 'demo-reference-v1'
                    ? 'Reference demo'
                    : record.analysis.profile === 'accurate'
                      ? 'Experimental ML'
                      : 'DSP analysis'}
                </small>
              </span>
              {record.track.favorite && <Heart size={15} fill="currentColor" />}
              <span className="library-duration">{timeLabel(record.track.duration)}</span>
              <ArrowUpRight size={18} />
            </button>
          ))
        )}
      </div>
    </>
  );
}

export function RecentSessions({ records, onOpen }: LibraryProps) {
  if (records.length === 0) return null;
  return (
    <section className="recent">
      <span className="eyebrow">PICK UP WHERE YOU LEFT OFF</span>
      {records.slice(0, 3).map((record) => (
        <button
          key={record.analysis.id}
          onClick={() => onOpen(record)}
          aria-label={`Open analysis: ${record.track.name}`}
        >
          <Music2 size={16} />
          {record.track.name}
          <ArrowUpRight size={14} />
        </button>
      ))}
    </section>
  );
}
