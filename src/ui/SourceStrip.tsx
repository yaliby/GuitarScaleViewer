import { useState } from 'react';
import { Headphones } from 'lucide-react';
import type { DetectedKeyState } from '../hooks/useDetectedKey';
import type { MediaSessionUiState } from '../hooks/useMediaSession';
import {
  applyGateLabel,
  applyGateValueLabel,
  clockLabel,
  detectionLed,
  detectionStateLabel,
  mediaPlaybackDisplayLabel,
  playbackProgressPct,
  resolutionLed,
  resolutionStateLabel,
} from './statusLabels';
import { certaintyLabel, type KeyCertainty } from './statusLabels';
import { GearToggle, Led, litSegments, METER_SEGMENTS, SignalMeter } from './gear';

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
  /** 0–100: how sure the pipeline has to be before Apply acts. 0 takes every reading. */
  applyThreshold: number;
  onApplyThresholdChange: (thresholdPct: number) => void;
  /** Live vinyl cue; when set, the transport clock follows the platter instead of the OS poll. */
  cuePositionMs?: number | null;
};

/**
 * Five points a notch. Not a bar's width (100/14 ≈ 7.1), because the numbers worth landing on are
 * the pipeline's own rungs — 35 hedged, 70 notes-sure-root-open, 85 a lone engine reading at its
 * ceiling, 100 a human transcription (see `CERTAINTY_PCT`) — and every one of those is a multiple
 * of five. Two neighbouring notches can round to the same bar count; that is what fourteen
 * rectangles can say, and the percentage beside them says the rest.
 */
const GATE_STEP_PCT = 5;

/**
 * What the machine is hearing — the Jam listening deck with the Lab's own instrumentation: two
 * pipeline lamps, a segmented certainty meter, and the Apply latch.
 *
 * Apply ships engaged and its gate ships open: the neck follows the song without anything being
 * pressed, and the deck reports how sure the pipeline is rather than asking the player to decide
 * whether to believe it. Raising the gate is how a player who *does* want to decide says so in
 * one number; switching Apply off stops the song moving the neck at all.
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
  applyThreshold,
  onApplyThresholdChange,
  cuePositionMs,
}: SourceStripProps) {
  /* True while the gate is being set, so the bars it is asking for can be counted off the strip
     as the slider moves — the whole reason the gate is drawn on the meter and not in a field. */
  const [gateLive, setGateLive] = useState(false);
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
        <SignalMeter
          value={meterValue}
          gate={applyThreshold > 0 ? applyThreshold / 100 : null}
          gateLive={gateLive}
          label="Key certainty"
        />
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

      {/* The gate. It sits under the meter it is set against: the slider names a percentage, the
          strip above answers in rectangles, and the two are the same reading. */}
      <div className={`lab-gate ${gateLive ? 'is-live' : ''}`}>
        <label className="lab-gate-row">
          <span className="legend">Apply at</span>
          <input
            className="gear-fader"
            type="range"
            min={0}
            max={100}
            step={GATE_STEP_PCT}
            value={applyThreshold}
            onChange={(event) => onApplyThresholdChange(Number(event.target.value))}
            onPointerDown={() => setGateLive(true)}
            onPointerUp={() => setGateLive(false)}
            onPointerCancel={() => setGateLive(false)}
            onFocus={() => setGateLive(true)}
            onBlur={() => setGateLive(false)}
            aria-label="Apply confidence gate"
            aria-valuetext={
              applyThreshold <= 0
                ? 'Any reading'
                : `${applyThreshold}%, ${litSegments(applyThreshold / 100)} of ${METER_SEGMENTS} bars`
            }
          />
          <span className="tele lab-gate-value">{applyGateValueLabel(applyThreshold)}</span>
        </label>
        <p className="lab-gate-note">
          {applyGateLabel({ thresholdPct: applyThreshold, confidencePct, applyDetected })}
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
