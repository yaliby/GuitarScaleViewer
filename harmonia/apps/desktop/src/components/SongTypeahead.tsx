// @ts-nocheck
import { useId, useRef, useState } from 'react';
import { Music2, Search } from 'lucide-react';
import type { CatalogRecording } from '../../../../packages/application/catalog-contracts';
import { timeLabel } from './Timeline';

export function SongArtwork({
  recording,
  className = '',
}: {
  recording?: Pick<CatalogRecording, 'thumbnail'> | null;
  className?: string;
}) {
  return (
    <div className={`song-cover ${className}`}>
      {recording?.thumbnail ? (
        <img src={recording.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />
      ) : (
        <Music2 aria-hidden="true" size={32} strokeWidth={1.3} />
      )}
    </div>
  );
}

export function SongTypeahead({
  query,
  results,
  searching,
  onQuery,
  onSelect,
}: {
  query: string;
  results: CatalogRecording[];
  searching: boolean;
  onQuery(value: string): void;
  onSelect(recording: CatalogRecording): void;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState(-1);
  const list = useRef<HTMLDivElement>(null);
  const open = expanded && results.length > 0;
  const activeIndex = active < results.length ? active : -1;
  const select = (recording: CatalogRecording) => {
    setExpanded(false);
    setActive(-1);
    onSelect(recording);
  };
  return (
    <div
      className="consumer-search"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(false);
      }}
    >
      <label htmlFor={id}>Song or artist</label>
      <div className="consumer-search-field">
        <Search aria-hidden="true" size={22} />
        <input
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? `${id}-results` : undefined}
          aria-activedescendant={
            open && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined
          }
          value={query}
          placeholder="Find a song you love"
          maxLength={160}
          autoComplete="off"
          onFocus={() => setExpanded(true)}
          onChange={(event) => {
            setActive(-1);
            setExpanded(true);
            onQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              setExpanded(false);
              setActive(-1);
            }
            if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && results.length) {
              event.preventDefault();
              setExpanded(true);
              const next =
                event.key === 'ArrowDown'
                  ? (activeIndex + 1) % results.length
                  : activeIndex <= 0
                    ? results.length - 1
                    : activeIndex - 1;
              setActive(next);
              list.current?.children[next]?.scrollIntoView({ block: 'nearest' });
            }
            if (event.key === 'Enter' && open && activeIndex >= 0) {
              event.preventDefault();
              select(results[activeIndex]);
            }
          }}
        />
        {searching && <span className="search-spinner" aria-hidden="true" />}
      </div>
      <span className="sr-only" role="status">
        {searching ? 'Searching songs…' : query.trim() ? `${results.length} songs found` : ''}
      </span>
      {open && (
        <div
          ref={list}
          id={`${id}-results`}
          role="listbox"
          aria-label="Song search results"
          className="consumer-suggestions"
        >
          {results.map((recording, index) => (
            <div
              key={`${recording.provider}:${recording.id}`}
              id={`${id}-option-${index}`}
              role="option"
              data-recording-id={recording.id}
              data-provider={recording.provider}
              aria-selected={index === activeIndex}
              className={`consumer-suggestion ${index === activeIndex ? 'selected' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(recording)}
            >
              <SongArtwork recording={recording} />
              <div className="suggestion-copy">
                <strong>{recording.title}</strong>
                <span>
                  {recording.artist}
                  {recording.provider === 'youtube' ? ' · YouTube' : ''}
                </span>
                <span
                  className={`suggestion-availability ${recording.audio || recording.canPrepare ? 'available' : ''}`}
                >
                  {recording.audio || recording.canPrepare
                    ? 'Analyze & play'
                    : 'Watch only · no chord analysis'}
                </span>
              </div>
              {recording.duration !== null && (
                <span className="suggestion-duration">{timeLabel(recording.duration)}</span>
              )}
            </div>
          ))}
        </div>
      )}
      {expanded && query.trim() && !searching && !results.length && (
        <p className="search-empty" role="status">
          No songs found. Try another title or artist.
        </p>
      )}
    </div>
  );
}
