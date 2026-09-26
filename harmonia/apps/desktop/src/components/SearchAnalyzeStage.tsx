// @ts-nocheck
﻿import { useRef, useSyncExternalStore } from 'react';
import { AudioLines, ArrowLeft, Upload } from 'lucide-react';
import type { SongSearchController } from '../../../../packages/application/song-search';
import type { SessionController } from '../../../../packages/application/session';
import { ConsumerPlayer } from './ConsumerPlayer';
import { SongArtwork, SongTypeahead } from './SongTypeahead';

export function SearchAnalyzeStage({
  search,
  session,
  localOnly = false,
  onLegacy,
}: {
  search: SongSearchController;
  session: SessionController;
  localOnly?: boolean;
  onLegacy(): void;
}) {
  const state = useSyncExternalStore(search.subscribe, search.snapshot);
  const analysis = useSyncExternalStore(session.subscribe, session.snapshot);
  const file = useRef<HTMLInputElement>(null);
  const busy = state.status === 'downloading' || state.status === 'analyzing';
  const current = state.status === 'ready' ? analysis.current : null;
  const progress =
    state.status === 'downloading'
      ? state.total
        ? state.received / state.total
        : null
      : analysis.progress;
  return (
    <div className="song-workspace consumer-workspace">
      <input
        ref={file}
        type="file"
        className="file-input"
        aria-label="Whole-song audio file"
        accept="audio/*,.flac,.ogg,.oga"
        onChange={(event) => {
          const selected = event.target.files?.[0];
          if (selected) void search.local(selected);
          event.target.value = '';
        }}
      />
      {(state.error || (state.status === 'ready' && analysis.error)) && (
        <div role="alert" className="error-banner">
          {state.error ?? analysis.error}
          {current && <span> Your song is ready. Press Play to try again.</span>}
        </div>
      )}
      {current && state.playbackNotice && (
        <p className="notice" role="status">
          {state.playbackNotice}
        </p>
      )}
      {current ? (
        <>
          <button
            className="text-button consumer-back"
            onClick={() => {
              session.player.pause();
              search.cancel(false);
            }}
          >
            <ArrowLeft size={16} /> Find another song
          </button>
          <ConsumerPlayer
            key={current.analysis.id}
            record={current}
            controller={session}
            recording={state.selected}
            preparationSeconds={state.elapsedSeconds}
            onReanalyze={() => void search.reanalyze()}
          />
        </>
      ) : busy ? (
        <section className="consumer-preparation" aria-label="Whole-song preparation">
          <SongArtwork recording={state.selected} className="preparation-cover" />
          <span className="eyebrow">GETTING YOUR SONG READY</span>
          <h1>{state.selected?.title ?? 'Your recording'}</h1>
          {state.selected?.artist && <p>{state.selected.artist}</p>}
          <div className="preparation-progress" role="status">
            <AudioLines size={24} />
            <h2>{state.status === 'downloading' ? 'Loading your song…' : 'Finding the chords…'}</h2>
            <progress
              aria-label="Song preparation"
              value={progress === null ? undefined : Math.max(0, Math.min(1, progress))}
              max="1"
            />
            <span>
              {progress === null ? 'Loading recording' : `${Math.round(progress * 100)}%`}
            </span>
          </div>
          <p>We prepare the whole song first, so every chord is ready when you listen.</p>
          <button className="text-button" onClick={() => search.cancel()}>
            Cancel analysis
          </button>
        </section>
      ) : (
        <>
          <div className="consumer-intro">
            <span className="eyebrow">HEAR IT. SEE IT. PLAY IT.</span>
            <h1>{localOnly ? 'Bring your own recording.' : 'Every song has a story.'}</h1>
            <p>
              {localOnly
                ? 'Discover its chords, from the first note to the last.'
                : 'Find your song. Follow the chords. Make it yours.'}
            </p>
          </div>
          {!localOnly && (
            <SongTypeahead
              query={state.query}
              results={state.results}
              searching={state.status === 'searching'}
              onQuery={(value) => search.query(value)}
              onSelect={(recording) => void search.select(recording)}
            />
          )}
          {!localOnly && state.notice && (
            <p className="consumer-search-notice" role="status">
              {state.notice}
            </p>
          )}
          {state.status === 'input-required' && (
            <section className="consumer-unavailable" role="status">
              <h2>{state.selected?.title}</h2>
              <p>
                {state.selected?.provider === 'youtube'
                  ? 'YouTube videos are watch-only here. For chord playback, choose a result marked Analyze & play.'
                  : 'Chord analysis is not available for this recording.'}
              </p>
              {state.selected?.provider === 'youtube' && (
                <a href={state.selected.pageUrl} target="_blank" rel="noreferrer">
                  Watch on YouTube
                </a>
              )}
            </section>
          )}
          <div className="consumer-local-actions">
            <button className="text-button" onClick={() => file.current?.click()}>
              <Upload size={15} /> Analyze local recording
            </button>
            <span>Already have the audio? Bring it along.</span>
            {localOnly && (
              <button className="text-button" onClick={onLegacy}>
                Earlier analysis profiles
              </button>
            )}
          </div>
          <p className="consumer-privacy">Your audio and chord analysis stay on this device.</p>
        </>
      )}
    </div>
  );
}
