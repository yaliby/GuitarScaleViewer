import { useSyncExternalStore } from 'react';
import { Download, Pause, Play } from 'lucide-react';
import { getChordJobs, subscribeChordJobs } from '../harmonia/chordJobs';
import type { TrackCaptureApi } from '../hooks/useTrackCapture';
import { engineLabel } from '../services/trackCapture';
import { Led } from '../ui/gear';
import { captureLed, captureStageLabel } from '../ui/statusLabels';
import './TrackCaptureBar.css';

type Props = {
  capture: TrackCaptureApi;
  compact?: boolean;
  /** Explore already shows the now-playing title; keep the form to a link + actions. */
  hideQuery?: boolean;
};

function faceCopy(
  capture: TrackCaptureApi,
  readingChords: boolean,
): { title: string; detail: string } {
  if (capture.status === 'capturing') {
    return { title: captureStageLabel(capture.stage), detail: 'in the background' };
  }
  if (capture.status === 'ready' && capture.track) {
    if (readingChords) {
      return { title: 'Saved', detail: 'Reading chords in the background' };
    }
    const via = engineLabel(capture.track.engine);
    const how = capture.track.cached ? `${via} cache` : via;
    const who = [capture.track.artist, capture.track.title].filter(Boolean).join(' — ');
    return { title: 'Saved', detail: who ? `${who} · ${how}` : how };
  }
  if (capture.status === 'error') {
    return { title: "Couldn't save", detail: capture.error || 'Capture failed' };
  }
  if (capture.autoEnabled) {
    return { title: 'Auto-save on', detail: 'Will grab the song that is playing' };
  }
  return { title: 'Not saving', detail: 'Paste a YouTube link, or save the song that is playing' };
}

export function TrackCaptureBar({ capture, compact = false, hideQuery = false }: Props) {
  const jobs = useSyncExternalStore(subscribeChordJobs, getChordJobs, getChordJobs);
  const readingChords = Boolean(capture.track && jobs[capture.track.id]);
  const busy = capture.status === 'capturing';
  const lamp = captureLed(capture.status, capture.autoEnabled);
  const { title, detail } = faceCopy(capture, readingChords);
  const pct = capture.progressPct;
  const showMeter = busy;
  const indeterminate = busy && (pct == null || pct < 4);
  const meterWidth = indeterminate ? undefined : Math.max(pct ?? 8, 8);

  return (
    <section
      className={`track-capture is-${capture.status}${compact ? ' is-compact' : ''}`}
      aria-label="Song capture"
    >
      <div className="track-capture-face" data-testid="track-capture-status">
        <Led tone={lamp.tone} pulse={lamp.pulse} size={8} />
        <div className="track-capture-copy">
          <strong>{title}</strong>
          <p>{detail}</p>
        </div>
        {busy ? (
          <span className="track-capture-pct tele" aria-hidden="true">
            {pct == null ? '…' : `${Math.round(pct)}%`}
          </span>
        ) : null}
        {showMeter ? (
          <div
            className={`track-capture-meter${indeterminate ? ' is-indeterminate' : ''}`}
            role="progressbar"
            aria-label="Capture progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={indeterminate || pct == null ? undefined : Math.round(pct)}
            aria-valuetext={
              indeterminate || pct == null ? title : `${title}, ${Math.round(pct)} percent`
            }
          >
            <span style={meterWidth == null ? undefined : { width: `${meterWidth}%` }} />
          </div>
        ) : null}
      </div>
      {hideQuery ? null : (
        <form
          className="track-capture-form"
          onSubmit={(event) => {
            event.preventDefault();
            capture.captureQuery();
          }}
        >
          <label>
            <span>YouTube link or search</span>
            <input
              value={capture.query}
              onChange={(event) => capture.setQuery(event.target.value)}
              placeholder="https://youtu.be/… or song name"
              aria-label="YouTube link or search"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button type="submit" className="track-capture-go" disabled={busy}>
            <Download size={14} />
            Save
          </button>
        </form>
      )}
      <div className="track-capture-row">
        <button
          type="button"
          className="track-capture-now"
          onClick={() => capture.captureNow()}
          disabled={busy}
        >
          <Download size={14} />
          This song
        </button>
        <label className="track-capture-auto">
          <input
            type="checkbox"
            checked={capture.autoEnabled}
            onChange={(event) => capture.setAutoEnabled(event.target.checked)}
          />
          Auto
        </label>
        {capture.status === 'ready' && capture.track ? (
          <button
            type="button"
            className="track-capture-play"
            onClick={() => capture.togglePlayback()}
            aria-label={capture.playing ? 'Pause captured audio' : 'Play captured audio'}
          >
            {capture.playing ? <Pause size={14} /> : <Play size={14} />}
            {capture.playing ? 'Pause' : 'Play'}
          </button>
        ) : null}
      </div>
    </section>
  );
}
