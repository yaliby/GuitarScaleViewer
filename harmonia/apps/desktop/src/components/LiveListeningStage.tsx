// @ts-nocheck
import { useState, useSyncExternalStore } from 'react';
import { AudioLines, RefreshCw, Square } from 'lucide-react';
import type { LiveSessionController } from '../../../../packages/application/live-session';
import { formatChord } from '../../../../packages/domain/chord';
import type { Chord } from '../../../../packages/domain/types';
import { Piano, Guitar } from './Instrument';
import { SessionError } from './SessionStatus';
import { timeLabel } from './Timeline';

const statusLabels = {
  idle: 'Ready to listen',
  starting: 'Connecting to audio',
  listening: 'Listening',
  waiting: 'Waiting for audio',
  silence: 'No accessible audio',
  stopping: 'Stopping capture',
  ended: 'Audio source ended',
  error: 'Capture unavailable',
};

export function LiveListeningStage({ controller }: { controller: LiveSessionController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [instrument, setInstrument] = useState<'piano' | 'guitar'>('piano');
  const source = state.sources.find((item) => item.id === state.selectedSourceId);
  const active =
    Boolean(state.session) ||
    ['starting', 'listening', 'waiting', 'silence', 'stopping'].includes(state.status);
  const current = state.status === 'listening' ? state.update?.current : null;
  const chord: Chord = current?.chord ?? { kind: 'unknown' };
  const recent = state.update?.recent ?? [];
  return (
    <div className="live-workspace">
      <div className="page-heading live-heading">
        <div>
          <span className="eyebrow">Experimental live recognition</span>
          <h1>Listen Live</h1>
          <p>
            Choose an application or system output. Follow its harmony without importing a file.
          </p>
        </div>
        <span className="tag">LOCAL AUDIO · DSP ESTIMATE</span>
      </div>
      {state.error && (
        <SessionError message={state.error} onDismiss={() => controller.clearError()} />
      )}
      <section className="live-source-panel" aria-label="Live audio source">
        <div className="live-source-picker">
          <label htmlFor="live-source">Audio source</label>
          <select
            id="live-source"
            value={state.selectedSourceId ?? ''}
            disabled={active || state.refreshing}
            onChange={(event) => controller.selectSource(event.target.value)}
          >
            <option value="">Choose an audio source</option>
            {(['process', 'system'] as const).map((kind) => (
              <optgroup
                key={kind}
                label={
                  kind === 'process'
                    ? 'Applications · process tree'
                    : 'System output · selected device'
                }
              >
                {state.sources
                  .filter((item) => item.kind === kind)
                  .map((item) => (
                    <option key={item.id} value={item.id} disabled={!item.available}>
                      {item.label}
                      {item.available ? '' : ` — ${item.reason ?? 'Unavailable'}`}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </div>
        <button
          className="secondary"
          disabled={active || state.refreshing}
          onClick={() => void controller.refreshSources()}
          aria-label="Refresh sources"
        >
          <RefreshCw size={15} /> {state.refreshing ? 'Refreshing…' : 'Refresh sources'}
        </button>
        {active ? (
          <button
            className="primary"
            disabled={state.status === 'stopping'}
            onClick={() => void controller.stop()}
          >
            <Square size={15} /> {state.status === 'stopping' ? 'Stopping…' : 'Stop listening'}
          </button>
        ) : (
          <button
            className="primary"
            disabled={!source?.available || state.refreshing}
            onClick={() => void controller.start()}
          >
            <AudioLines size={17} /> Start listening
          </button>
        )}
        <p className="live-source-scope">
          {source?.kind === 'process'
            ? 'Captures this application and its child processes, not an individual browser tab.'
            : source?.kind === 'system'
              ? 'Captures the mix playing through this output device.'
              : 'Select a source explicitly. Capture starts only when you choose Start listening.'}
        </p>
        <p className="live-source-scope">
          App missing? Start playback in it, then refresh sources. Stop listening before switching
          sources.
        </p>
      </section>
      <div className="listening-grid">
        <section className="harmony-stage live-harmony" aria-label="Live harmony">
          <div className="stage-meta">
            <span className="eyebrow" role="status">
              <i className={`status-dot ${state.status === 'listening' ? 'pulsing' : ''}`} />
              {statusLabels[state.status]}
            </span>
            <span className="live-elapsed">Captured {timeLabel(state.update?.position ?? 0)}</span>
          </div>
          <div className="live-current-chord">
            <span className="eyebrow">CURRENT ESTIMATE</span>
            <h2 data-testid="live-current-chord">{current ? formatChord(chord) : '—'}</h2>
            <p>
              {current
                ? `Model score ${Math.round(current.score * 100)}% · uncalibrated`
                : state.status === 'silence'
                  ? 'The source may be paused, quiet, or withholding audio.'
                  : state.status === 'ended'
                    ? 'The selected source has stopped. Choose a source to continue.'
                    : active
                      ? 'Listening for enough audio to estimate a chord.'
                      : 'Your current chord will appear here.'}
            </p>
          </div>
          <div className="stage-footer live-stage-footer">
            <span>Upcoming unavailable during live listening.</span>
            <span>
              Analysis lookahead{' '}
              {state.update ? `${state.update.lookaheadSeconds.toFixed(2)} s` : '—'}
            </span>
          </div>
        </section>
        <aside className="inspector live-inspector" aria-label="Live chord tones">
          <div className="section-heading">
            <span className="eyebrow">INSIDE THE CHORD</span>
          </div>
          <h2>{current ? formatChord(chord) : '—'}</h2>
          <p className="chord-description">
            {chord.kind === 'chord' ? chord.triad : 'No harmonic label'}
          </p>
          <div className="instrument-tabs">
            <button
              className={instrument === 'piano' ? 'selected' : ''}
              onClick={() => setInstrument('piano')}
            >
              Piano
            </button>
            <button
              className={instrument === 'guitar' ? 'selected' : ''}
              onClick={() => setInstrument('guitar')}
            >
              Guitar
            </button>
          </div>
          {instrument === 'piano' ? <Piano chord={chord} /> : <Guitar chord={chord} />}
        </aside>
      </div>
      <section className="live-history" aria-label="Recent live chords">
        <div className="section-heading">
          <span className="eyebrow">RECENT HARMONY</span>
          <span className="subtle">Captured time · recent estimates</span>
        </div>
        {recent.length ? (
          <ol>
            {recent.map((segment) => (
              <li key={`${segment.start}-${segment.end}`}>
                <span>{formatChord(segment.estimate.chord)}</span>
                <small>
                  {timeLabel(segment.start)}–{timeLabel(segment.end)}
                </small>
              </li>
            ))}
          </ol>
        ) : (
          <p>Recent chords will appear as the music changes.</p>
        )}
        {Boolean(state.update?.discontinuities) && (
          <p className="notice">Audio was interrupted. Estimates restart after each gap.</p>
        )}
      </section>
      <p className="analysis-note">
        Live audio is processed locally and is not saved. Chord estimates may be incomplete or
        incorrect.
      </p>
    </div>
  );
}
