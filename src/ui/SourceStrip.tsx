import { Headphones } from 'lucide-react';
import type { DetectedKeyState } from '../hooks/useDetectedKey';
import type { MediaSessionUiState } from '../hooks/useMediaSession';
import {
  clockLabel,
  detectionLed,
  detectionStateLabel,
  mediaPlaybackDisplayLabel,
  playbackProgressPct,
  resolutionLed,
  resolutionStateLabel,
} from './statusLabels';
import { certaintyLabel, type KeyCertainty } from './statusLabels';
import { GearToggle, Led, SignalMeter } from './gear';

export type SourceStripProps = {
  mediaSession: MediaSessionUiState;
  detected: DetectedKeyState;
  resolutionState: string;
  /** The key on the neck right now. The pipeline put it there; nobody had to. */
  keyName: string | null;
  certainty: KeyCertainty;
  confidencePct: number;
  /** Every leg that answered agrees on the seven notes — the diagram itself is right. */
  notesSettled: boolean;
  /** ...and on which of them is home. False on a relative-pair hedge. */
  tonicSettled: boolean;
  /** The other name for the same seven notes, e.g. "E minor" while the neck reads G major. */
  relativeAlternative: string | null;
  /** Is the neck allowed to take the pipeline's key? On by default; off freezes what is drawn. */
  applyDetected: boolean;
  onToggleApply: () => void;
  /** Live vinyl cue; when set, the transport clock follows the platter instead of the OS poll. */
  cuePositionMs?: number | null;
};

/**
 * What the machine is hearing — the Jam listening deck with the Lab's own instrumentation: two
 * pipeline lamps, a segmented certainty meter, and the Apply latch.
 *
 * Apply ships engaged: the neck follows the song without anything being pressed, and the deck
 * reports how sure the pipeline is rather than asking the player to decide whether to believe
 * it. Switching Apply off is the only way to stop the song moving the neck.
 */
export function SourceStrip({
  mediaSession,
  detected,
  resolutionState,
  keyName,
  certainty,
  confidencePct,
  notesSettled,
  tonicSettled,
  relativeAlternative,
  applyDetected,
  onToggleApply,
  cuePositionMs,
}: SourceStripProps) {
  const unavailable = mediaSession.playbackStatus === 'media_session_unavailable';
  const playing = mediaSession.playbackStatus === 'playing';
  const trackLine = unavailable
    ? 'No media session'
    : [mediaSession.artist, mediaSession.title].filter(Boolean).join(' — ') || 'Nothing playing';

  const det = detectionLed(detected.state);
  const res = resolutionLed(resolutionState);
  const positionMs = cuePositionMs ?? mediaSession.positionMs;
  const cueing = cuePositionMs != null;
  const progress = playbackProgressPct(positionMs, mediaSession.durationMs);
  const elapsed = clockLabel(positionMs);
  const total = clockLabel(mediaSession.durationMs);
  // One scale for every source: `confidencePct` is already priced by provenance in keyFusion,
  // so the meter no longer has to special-case where the key came from.
  const meterValue = confidencePct / 100;

  return (
    <div className="lab-track" aria-live="polite">
      <span className="lab-module-label">
        <Headphones size={14} />
        {playing ? 'Now playing' : 'The listening deck'}
        <span className="lab-lamps">
          <span>
            <Led
              tone={det.tone}
              pulse={det.pulse}
              label={`Detection: ${detectionStateLabel(detected.state)}`}
            />
            <span className="legend">Detect</span>
          </span>
          <span>
            <Led
              tone={res.tone}
              pulse={res.pulse}
              label={`Lookup: ${resolutionStateLabel(resolutionState)}`}
            />
            <span className="legend">Library</span>
          </span>
        </span>
      </span>

      <h2 title={trackLine}>{trackLine}</h2>
      <p>
        {mediaPlaybackDisplayLabel(mediaSession.playbackStatus)}
        <span className="mx-1.5 opacity-50">/</span>
        {resolutionStateLabel(resolutionState)}
      </p>

      {/* The Jam transport clock. aria-live is off so a ticking readout does not narrate itself. */}
      <div className="lab-timeline" aria-live="off">
        <div
          className={`lab-progress ${cueing ? 'is-cueing' : ''}`}
          role="progressbar"
          aria-label="Song progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress === null ? undefined : Math.round(progress)}
          aria-valuetext={progress === null ? 'Unknown' : `${elapsed} of ${total}`}
        >
          <span style={{ width: `${progress ?? 0}%` }} />
        </div>
        <div className="lab-timeline-clock tele">
          <span>{elapsed}</span>
          <span>{total}</span>
        </div>
      </div>

      <div className="lab-meter">
        <div className="lab-meter-head">
          <strong>{keyName ?? 'Listening…'}</strong>
          <span className="tele">{certaintyLabel(certainty)}</span>
        </div>
        <SignalMeter value={meterValue} label="Key certainty" />
        {/* The distinction that matters to somebody holding a guitar: a key and its relative
            draw the same diagram, so settled notes mean the neck is right even while the two
            legs are still arguing about which note is home. Measured on the corpus, that is the
            engine's most common miss by far — and the one a player can ignore. */}
        <p className="lab-meter-note">
          {!notesSettled
            ? 'Scale tones still settling'
            : tonicSettled
              ? 'Scale tones confirmed'
              : relativeAlternative
                ? `Scale tones confirmed — could be ${relativeAlternative}`
                : 'Scale tones confirmed — root still open'}
        </p>
      </div>

      <div className="lab-track-actions">
        <GearToggle
          engaged={applyDetected}
          onClick={onToggleApply}
          title={
            applyDetected
              ? 'Apply is on: the neck follows the song. Switch it off to keep this key.'
              : 'Apply is off: the neck holds this key. Switch it on to take the key being heard.'
          }
        >
          Apply
        </GearToggle>
      </div>
    </div>
  );
}
