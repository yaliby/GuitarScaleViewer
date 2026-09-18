import type { DetectedKeyAbState } from '../hooks/useDetectedKey';
import type { LedTone } from './gear';

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
    cloud_lookup: 'Checking cloud database and catalogs',
    cloud_hit: 'Verified key found',
    catalog_hit: 'Catalog key found',
    cloud_miss_local_detecting: 'No catalog key, detecting locally',
    local_detecting: 'Local detection fallback',
    ready: 'Ready',
    ambiguous: 'Ambiguous',
    error: 'Error',
  };
  return labels[state] ?? state;
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

/** Lamp for the cloud/catalog lookup leg of the pipeline. */
export function resolutionLed(state: string): { tone: LedTone; pulse: boolean } {
  switch (state) {
    case 'cloud_hit':
    case 'catalog_hit':
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

/**
 * Where the key currently drawn on the neck came from. The neck follows whatever the user picked,
 * which is only the pipeline's proposal once it has actually been applied — so this reports
 * "Manual" until the two agree, rather than claiming credit for a hand-typed key.
 */
export function keySourceLabel({
  resolutionState,
  hasCloudHit,
  showingProposedKey,
}: {
  resolutionState: string;
  hasCloudHit: boolean;
  showingProposedKey: boolean;
}): string {
  if (!showingProposedKey) {
    return 'Manual';
  }
  if (hasCloudHit) {
    return resolutionState === 'catalog_hit' ? 'Catalog' : 'Verified';
  }
  return 'Detected';
}
