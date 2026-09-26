import type { DetectedKeyAbState } from '../hooks/useDetectedKey';
import type { KeyCertainty } from '../services/keyFusion';
import { litSegments, METER_SEGMENTS, type LedTone } from './gear';

export type { KeyCertainty };

/** The gate setting itself, for the readout beside the slider. */
export function applyGateValueLabel(thresholdPct: number): string {
  return thresholdPct <= 0 ? 'Any' : `${Math.round(thresholdPct)}%`;
}

/**
 * The Apply gate read back in the unit the panel actually shows: rectangles.
 *
 * A percentage is an abstraction; the meter above the slider is not. Quoting the bar count means
 * the player sets the gate by looking at the strip they already read the key's certainty off,
 * and `litSegments` is shared with the meter so the number here is the number drawn there.
 */
export function applyGateLabel({
  thresholdPct,
  confidencePct,
  applyDetected,
  segments = METER_SEGMENTS,
}: {
  thresholdPct: number;
  confidencePct: number;
  applyDetected: boolean;
  segments?: number;
}): string {
  if (thresholdPct <= 0) {
    return 'Open — the neck takes whatever is heard';
  }
  const bars = `${litSegments(thresholdPct / 100, segments)} of ${segments} bars`;
  if (!applyDetected) {
    return `${bars} — Apply is off, so nothing is being taken`;
  }
  return confidencePct >= thresholdPct
    ? `${bars} — this reading is through`
    : `${bars} — holding: this reading is short`;
}

/**
 * How the deck words the pipeline's own certainty.
 *
 * The wording is deliberately about the evidence rather than about a score, because a number
 * invites the player to decide whether to trust it — and deciding is exactly what they are not
 * being asked to do. "Confirmed" says two independent legs agree; "estimated" says one leg is
 * guessing; neither asks for a reply.
 */
export function certaintyLabel(certainty: KeyCertainty): string {
  const labels: Record<KeyCertainty, string> = {
    verified: 'verified',
    lone: 'estimated',
    // Not "unsure": the notes are settled and only the root is open. Wording it as doubt would
    // send the player looking for a problem with a diagram that is already correct.
    tonic_open: 'notes sure, root open',
    hedged: 'unsure',
    held: 'holding',
    none: 'listening',
  };
  return labels[certainty] ?? 'listening';
}

export function mediaPlaybackDisplayLabel(status: string): string {
  const labels: Record<string, string> = {
    playing: 'Playing',
    paused: 'Paused',
    stopped: 'Stopped',
    none: 'No media',
    closed: 'Closed',
    opened: 'Opened',
    changing: 'Changing',
    unknown: 'Unknown',
    media_session_unavailable: 'Media session unavailable',
  };
  return labels[status] ?? status;
}

export function detectionStateLabel(state: string): string {
  const labels: Record<string, string> = {
    warming_up: 'Warming up',
    listening: 'Listening',
    likely_key: 'Likely key',
    ambiguous: 'Ambiguous',
    paused_hold: 'Paused (holding last stable key)',
    unavailable: 'Unavailable',
  };
  return labels[state] ?? state;
}

export function captureModeLabel(mode: string): string {
  const labels: Record<string, string> = {
    process_loopback: 'Process loopback',
    endpoint_loopback: 'System loopback fallback',
    unavailable: 'Unavailable',
  };
  return labels[mode] ?? mode;
}

export function resolutionStateLabel(state: string): string {
  const labels: Record<string, string> = {
    no_session: 'No active session',
    paused: 'Paused',
    cloud_lookup: 'Checking verified library',
    cloud_hit: 'Verified key found',
    cloud_miss_local_detecting: 'Not in the library, detecting locally',
    local_detecting: 'Local detection fallback',
    ready: 'Ready',
    ambiguous: 'Ambiguous',
    error: 'Error',
  };
  return labels[state] ?? state;
}

/** `m:ss` off the media-session clock; an em dash when the player reports no time. */
export function clockLabel(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) {
    return '—';
  }
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** How far into the track the player is, 0–100, or null when there is nothing to measure against. */
export function playbackProgressPct(positionMs: number | null, durationMs: number | null): number | null {
  if (positionMs === null || durationMs === null || !(durationMs > 0)) {
    return null;
  }
  return Math.min(100, Math.max(0, (positionMs / durationMs) * 100));
}

export function abLine(label: string, result: DetectedKeyAbState['current']): string {
  if (result.error) {
    return `${label}: error (${result.error})`;
  }
  const name = result.displayName ?? '—';
  const sharePct = Number.isFinite(result.share) ? Math.round(result.share * 100) : 0;
  return `${label}: ${name} (${sharePct}%, ${result.latencyMs}ms)`;
}

export function detectionReasonLabel(reason: string | null): string {
  if (!reason) {
    return 'Waiting for stable detection evidence.';
  }
  const labels: Record<string, string> = {
    warming_up: 'Warming up and collecting enough audio.',
    no_active_session: 'No active media session.',
    media_session_unavailable: 'Media session unavailable.',
    playback_paused: 'Playback is paused.',
    paused_holding_last_good_detection:
      'Playback paused: preserving last stable detection for a short grace period.',
    recent_silence_holding_last_good_detection:
      'Recent silence detected: preserving last stable detection for a short grace period.',
    paused_hold_last_good_apply_grace:
      'Playback paused/silent: Apply remains available briefly from last stable detection.',
    smtc_reported_paused_but_audio_active:
      'SMTC reported paused, but audio is still active (treating as listening).',
    capture_not_ready: 'Audio capture not ready yet.',
    collecting_audio_for_first_window: 'Collecting enough audio for the first analysis window (about 12s).',
    analysis_error: 'Analyzer unavailable or failed to respond.',
    no_analysis_windows: 'Analyzer did not return usable windows.',
    top_candidate_too_close_to_alternative: 'Top key is too close to alternatives.',
    unstable_across_windows: 'Key candidates are unstable across windows.',
    low_confidence: 'Confidence is too low.',
    candidate_switch_unstable: 'Recent key switch is not stable yet.',
    waiting_for_stability_confirmation: 'Waiting for repeated stable detections.',
    insufficient_consensus_for_likely_key: 'Consensus is not strong enough yet.',
    contradiction_detected_multiple_tonics: 'Contradiction detected: multiple tonic centers in recent horizon.',
    contradiction_detected_major_minor_conflict: 'Contradiction detected: major/minor identity conflict.',
    contradiction_detected_profile_disagreement: 'Contradiction detected: profile disagreement across windows.',
    contradiction_detected_mixed_tonic_family:
      'Contradiction detected: mixed tonic family in recent horizon (not clean enough yet).',
    relative_pair_ambiguity:
      'Relative major/minor ambiguity detected; waiting for clearer minor/major center evidence.',
    relative_pair_minor_center_selected:
      'Relative pair detected; minor center selected by structural evidence.',
    recent_capture_silence_detected:
      'Recent audio capture is silent; waiting for reliable non-silent capture before promotion.',
    apply_blocked_numpy_fallback_requires_essentia:
      'Apply blocked: fallback backend is active; waiting for stable Essentia evidence.',
    apply_blocked: 'Apply blocked: waiting for cleaner and more stable agreement.',
    gating_denied: 'Likely-key blocked: recent windows are still contradictory or unstable.',
  };
  let key = reason;
  if (reason.startsWith('analysis_error')) {
    key = 'analysis_error';
  } else if (reason.startsWith('gating_denied')) {
    key = 'gating_denied';
  } else if (reason.startsWith('apply_blocked')) {
    key = 'apply_blocked';
  } else if (reason.startsWith('insufficient_consensus_for_likely_key')) {
    key = 'insufficient_consensus_for_likely_key';
  } else if (reason.startsWith('waiting_for_stability_confirmation')) {
    key = 'waiting_for_stability_confirmation';
  } else if (reason.startsWith('relative_pair_ambiguity')) {
    key = 'relative_pair_ambiguity';
  } else if (reason.startsWith('relative_pair_minor_center_selected')) {
    key = 'relative_pair_minor_center_selected';
  } else if (reason.startsWith('paused_holding_last_good_detection')) {
    key = 'paused_holding_last_good_detection';
  } else if (reason.startsWith('recent_silence_holding_last_good_detection')) {
    key = 'recent_silence_holding_last_good_detection';
  } else if (reason.startsWith('paused_hold_last_good_apply_grace')) {
    key = 'paused_hold_last_good_apply_grace';
  }
  return labels[key] ?? reason.replaceAll('_', ' ');
}

/** Which lamp the detection pipeline lights. Grouped by what the user should do, not by enum name. */
export function detectionLed(state: string): { tone: LedTone; pulse: boolean } {
  switch (state) {
    case 'likely_key':
      return { tone: 'live', pulse: false };
    case 'listening':
    case 'warming_up':
      return { tone: 'hold', pulse: true };
    case 'paused_hold':
    case 'ambiguous':
      return { tone: 'hold', pulse: false };
    case 'unavailable':
      return { tone: 'fault', pulse: false };
    default:
      return { tone: 'off', pulse: false };
  }
}

/** Lamp for the verified-library lookup leg of the pipeline. */
export function resolutionLed(state: string): { tone: LedTone; pulse: boolean } {
  switch (state) {
    case 'cloud_hit':
      return { tone: 'data', pulse: false };
    case 'cloud_lookup':
      return { tone: 'data', pulse: true };
    case 'error':
      return { tone: 'fault', pulse: false };
    case 'no_session':
      return { tone: 'off', pulse: false };
    default:
      return { tone: 'hold', pulse: false };
  }
}

/** Third deck lamp: the song file saving in the background, not the key. */
export function captureLed(
  status: string,
  autoEnabled = false,
): { tone: LedTone; pulse: boolean } {
  switch (status) {
    case 'capturing':
      return { tone: 'hold', pulse: true };
    case 'ready':
      return { tone: 'live', pulse: false };
    case 'error':
      return { tone: 'fault', pulse: false };
    default:
      return { tone: autoEnabled ? 'hold' : 'off', pulse: false };
  }
}

export function captureStageLabel(stage: string | null | undefined): string {
  switch (stage) {
    case 'extract':
    case 'start':
      return 'Finding';
    case 'download':
      return 'Downloading';
    case 'encode':
      return 'Encoding';
    case 'copy':
      return 'Saving';
    case 'cache':
      return 'Already saved';
    case 'done':
      return 'Saved';
    default:
      return 'Saving';
  }
}

export function captureLampLabel(status: string, autoEnabled = false): string {
  switch (status) {
    case 'capturing':
      return 'Saving in the background';
    case 'ready':
      return 'Song saved';
    case 'error':
      return 'Save failed';
    default:
      return autoEnabled ? 'Auto-save armed' : 'Auto-save off';
  }
}

/**
 * One line for the heading pill: what the pipeline is doing right now, phrased for a player rather
 * than for the log. Ordered by what overrides what — a held snapshot beats everything, a key the
 * neck already shows beats a lookup still in flight.
 */
export function deckStatusLabel({
  playbackStatus,
  detectionState,
  resolutionState,
  hasCloudHit,
  showingProposedKey,
  applyDetected,
}: {
  playbackStatus: string;
  detectionState: string;
  resolutionState: string;
  hasCloudHit: boolean;
  showingProposedKey: boolean;
  applyDetected: boolean;
}): string {
  if (!applyDetected) {
    return 'Detection held';
  }
  if (playbackStatus === 'media_session_unavailable') {
    return 'Manual key';
  }
  if (showingProposedKey) {
    return hasCloudHit ? 'Following the library' : 'Following the song';
  }
  if (resolutionState === 'cloud_lookup') {
    return 'Checking the library';
  }
  switch (detectionState) {
    case 'likely_key':
      return 'Key ready to apply';
    case 'ambiguous':
      return 'Comparing possible keys';
    case 'listening':
    case 'warming_up':
      return 'Listening for harmony';
    case 'paused_hold':
      return 'Holding the last key';
    case 'unavailable':
      return 'Listening unavailable';
    default:
      return 'Manual key';
  }
}

/**
 * Where the key currently drawn on the neck came from. The neck follows whatever the user picked,
 * which is only the pipeline's proposal once it has actually been applied — so this reports
 * "Manual" until the two agree, rather than claiming credit for a hand-typed key.
 */
export function keySourceLabel({
  hasCloudHit,
  showingProposedKey,
}: {
  hasCloudHit: boolean;
  showingProposedKey: boolean;
}): string {
  if (!showingProposedKey) {
    return 'Manual';
  }
  if (hasCloudHit) {
    return 'Verified';
  }
  return 'Detected';
}
