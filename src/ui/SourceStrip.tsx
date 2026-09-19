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
import { GearButton, Led, SignalMeter } from './gear';

export type SourceStripProps = {
  mediaSession: MediaSessionUiState;
  detected: DetectedKeyState;
  resolutionState: string;
  hasCloudHit: boolean;
  /** Key the pipeline currently proposes, already merged across cloud and local detection. */
  proposedKeyName: string | null;
  confidence: number;
  canApply: boolean;
  onApply: () => void;
  locked: boolean;
  onToggleLock: () => void;
  onResetDetection: () => void;
};

/**
 * What the machine is hearing, and the controls that act on it — the Jam listening deck with the
 * Lab's own instrumentation: two pipeline lamps, a segmented confidence meter, and the three
 * momentary buttons that are the only things you can do about a detection.
 */
export function SourceStrip({
  mediaSession,
  detected,
  resolutionState,
  hasCloudHit,
  proposedKeyName,
  confidence,
  canApply,
  onApply,
  locked,
  onToggleLock,
  onResetDetection,
}: SourceStripProps) {
  const unavailable = mediaSession.playbackStatus === 'media_session_unavailable';
  const playing = mediaSession.playbackStatus === 'playing';
  const trackLine = unavailable
    ? 'No media session'
    : [mediaSession.artist, mediaSession.title].filter(Boolean).join(' — ') || 'Nothing playing';

  const det = detectionLed(detected.state);
  const res = resolutionLed(resolutionState);
  const progress = playbackProgressPct(mediaSession.positionMs, mediaSession.durationMs);
  const elapsed = clockLabel(mediaSession.positionMs);
  const total = clockLabel(mediaSession.durationMs);
  // A verified catalog key is not a measurement, so the meter pins rather than showing detector confidence.
  const meterValue = hasCloudHit ? 1 : confidence;

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
            <span className="legend">Cloud</span>
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
          className="lab-progress"
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
          <strong>{proposedKeyName ?? 'No key yet'}</strong>
          <span className="tele">{hasCloudHit ? 'verified' : `${Math.round(confidence * 100)}%`}</span>
        </div>
        <SignalMeter value={meterValue} label="Key confidence" />
      </div>

      <div className="lab-track-actions">
        <GearButton
          tone="primary"
          onClick={onApply}
          disabled={!canApply}
          title="Send the detected key to the neck"
        >
          Apply
        </GearButton>
        <GearButton onClick={onToggleLock} aria-pressed={locked} title="Freeze the current detection">
          <span className="flex items-center gap-1.5">
            <Led tone={locked ? 'hold' : 'off'} size={5} />
            {locked ? 'Locked' : 'Lock'}
          </span>
        </GearButton>
        <GearButton onClick={onResetDetection} title="Clear the detector and start over">
          Reset
        </GearButton>
      </div>
    </div>
  );
}
