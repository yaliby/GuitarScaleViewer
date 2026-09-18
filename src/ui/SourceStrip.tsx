import type { DetectedKeyState } from '../hooks/useDetectedKey';
import type { MediaSessionUiState } from '../hooks/useMediaSession';
import {
  detectionLed,
  detectionStateLabel,
  mediaPlaybackDisplayLabel,
  resolutionLed,
  resolutionStateLabel,
} from './statusLabels';
import { GearButton, Led, Legend, SignalMeter, Well } from './gear';

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
 * What the machine is hearing, and the controls that act on it. Deliberately one row: the source,
 * its signal quality, and the three things you can do about it.
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
  const trackLine = unavailable
    ? 'No media session'
    : [mediaSession.artist, mediaSession.title].filter(Boolean).join(' — ') || 'Nothing playing';

  const det = detectionLed(detected.state);
  const res = resolutionLed(resolutionState);
  // A verified catalog key is not a measurement, so the meter pins rather than showing detector confidence.
  const meterValue = hasCloudHit ? 1 : confidence;

  return (
    <Well className="flex min-w-0 flex-col gap-3 px-4 py-3 sm:px-5 sm:py-4" aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        <Legend>Source</Legend>
        <div className="flex items-center gap-2.5">
          <span className="flex items-center gap-1.5">
            <Led tone={det.tone} pulse={det.pulse} label={`Detection: ${detectionStateLabel(detected.state)}`} />
            <span className="legend">Detect</span>
          </span>
          <span className="flex items-center gap-1.5">
            <Led tone={res.tone} pulse={res.pulse} label={`Lookup: ${resolutionStateLabel(resolutionState)}`} />
            <span className="legend">Cloud</span>
          </span>
        </div>
      </div>

      <div className="min-w-0">
        <p className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em] text-gear-text" title={trackLine}>
          {trackLine}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-gear-engrave">
          {mediaPlaybackDisplayLabel(mediaSession.playbackStatus)}
          <span className="mx-1.5 text-gear-engrave/50">/</span>
          {resolutionStateLabel(resolutionState)}
        </p>
      </div>

      <div className="flex min-w-0 items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate text-[13px] font-bold text-gear-text/90">
              {proposedKeyName ?? 'No key yet'}
            </span>
            <span className="tele shrink-0 text-[11px] font-semibold text-gear-legend">
              {hasCloudHit ? 'verified' : `${Math.round(confidence * 100)}%`}
            </span>
          </div>
          <SignalMeter value={meterValue} label="Key confidence" />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <GearButton tone="primary" onClick={onApply} disabled={!canApply} title="Send the detected key to the neck">
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
    </Well>
  );
}
