use crate::audio_capture::AudioCaptureManager;
use crate::audio_models::{CaptureMode, DetectedKeyPayload, KeyCandidate, WindowAnalysisResult};
use crate::key_detection::{AnalysisOutput, KeyDetector, LibKeyFinderDetector, SidecarKeyDetector};
use crate::media_session::{self, MediaSessionPayload};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const REQUIRED_AUDIO_SECONDS: f32 = 45.0;
const ANALYSIS_WINDOW_SECONDS: usize = 12;
const ANALYSIS_HOP_SECONDS: usize = 4;
const ANALYZE_EVERY_MS: u64 = 3_000;
const MIN_CONFIDENCE_READY: f32 = 0.84;
const MIN_STABILITY_READY: f32 = 0.82;
const MIN_CONFIDENCE_LIKELY: f32 = 0.78;
const MIN_STABILITY_LIKELY: f32 = 0.76;
const STALE_CAPTURE_TIMEOUT_MS: u64 = 7_000;
const MIN_READY_STREAK: usize = 6;
const KEY_SWITCH_HYSTERESIS_CONF_MARGIN: f32 = 0.08;
const CAPTURE_STABLE_MIN_CYCLES: usize = 3;
const SESSION_STABLE_MIN_CYCLES: usize = 3;
const PRIMARY_KEY_REPEAT_MIN: usize = 7;
const DISRUPTION_COOLDOWN_MS: u64 = 9_000;
const ANALYZER_UNAVAILABLE_LOG_THROTTLE_MS: u64 = 12_000;
const LAST_GOOD_HOLD_MS: u64 = 25_000;
const HISTORY_HORIZON: usize = 16;
const AGGREGATION_RECENT_WINDOW_COUNT: usize = 9;
const MAX_TONIC_ENTROPY: f32 = 0.76;
const MIN_DOMINANCE_SHARE: f32 = 0.84;
const MIN_PRIMARY_MARGIN: f32 = 0.34;
const CONTRADICTION_COOLDOWN_MS: u64 = 15_000;
const CONTRADICTION_CLEAR_CLEAN_CYCLES: usize = 4;
const COMPETING_TONIC_MIN_SHARE: f32 = 0.15;

static LATEST_DETECTED_KEY: OnceLock<Arc<Mutex<DetectedKeyPayload>>> = OnceLock::new();
static RESET_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static CLOUD_RESOLUTION: OnceLock<Arc<Mutex<CloudResolutionControl>>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct AbEngineResult {
    backend: String,
    key: Option<String>,
    scale: Option<String>,
    display_name: Option<String>,
    share: f32,
    window_count: usize,
    latency_ms: u128,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct AbComparePayload {
    current: AbEngineResult,
    libkeyfinder: AbEngineResult,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CloudResolutionControl {
    pub track_identity: Option<String>,
    pub state: String, // idle | lookup_pending | hit | miss | error
    pub key: Option<String>,
    pub mode: Option<String>,
    pub error: Option<String>,
}

fn cloud_control_cell() -> Arc<Mutex<CloudResolutionControl>> {
    CLOUD_RESOLUTION
        .get_or_init(|| {
            Arc::new(Mutex::new(CloudResolutionControl {
                track_identity: None,
                state: "idle".to_string(),
                key: None,
                mode: None,
                error: None,
            }))
        })
        .clone()
}

#[tauri::command]
pub fn set_cloud_resolution(control: CloudResolutionControl) -> bool {
    if let Ok(mut lock) = cloud_control_cell().lock() {
        *lock = control.clone();
        log::info!(
            "key_engine: cloud resolution updated state={} track={:?} key={:?} mode={:?}",
            control.state,
            control.track_identity,
            control.key,
            control.mode
        );
        true
    } else {
        false
    }
}

#[tauri::command]
pub fn get_cloud_resolution() -> CloudResolutionControl {
    cloud_control_cell()
        .lock()
        .map(|s| s.clone())
        .unwrap_or(CloudResolutionControl {
            track_identity: None,
            state: "idle".to_string(),
            key: None,
            mode: None,
            error: Some("cloud_resolution_lock_poisoned".to_string()),
        })
}

fn state_cell() -> Arc<Mutex<DetectedKeyPayload>> {
    LATEST_DETECTED_KEY
        .get_or_init(|| Arc::new(Mutex::new(DetectedKeyPayload::unavailable("engine_not_started"))))
        .clone()
}

#[tauri::command]
pub fn get_detected_key() -> DetectedKeyPayload {
    state_cell()
        .lock()
        .map(|s| s.clone())
        .unwrap_or_else(|_| DetectedKeyPayload::unavailable("state_lock_poisoned"))
}

#[tauri::command]
pub fn reset_detected_key() -> bool {
    RESET_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    true
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum EngineLifecycleState {
    NoSession,
    Paused,
    PlayingWarmup,
    PlayingAnalyzing,
    TrackChanging,
}

fn normalize_track_field(value: Option<&str>) -> String {
    value
        .unwrap_or("")
        .trim()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

fn track_identity(media: &MediaSessionPayload) -> Option<String> {
    let source = normalize_track_field(media.source_app.as_deref());
    let title = normalize_track_field(media.title.as_deref());
    let artist = normalize_track_field(media.artist.as_deref());
    let album = normalize_track_field(media.album.as_deref());
    let duration_s = media.duration_ms.unwrap_or(0) / 1000;

    if source.is_empty() && title.is_empty() && artist.is_empty() && album.is_empty() {
        return None;
    }

    Some(format!(
        "src={source}|title={title}|artist={artist}|album={album}|dur={duration_s}"
    ))
}

fn find_existing_path(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|p| p.exists()).cloned()
}

fn apply_capture_degrade(mut payload: DetectedKeyPayload) -> DetectedKeyPayload {
    if payload.capture_mode == CaptureMode::EndpointLoopback {
        payload.confidence *= 0.85;
        payload.reason = Some(
            payload
                .reason
                .clone()
                .unwrap_or_else(|| "system loopback fallback may include unrelated audio".to_string()),
        );
    }
    payload.ready_to_apply = payload.confidence >= MIN_CONFIDENCE_READY
        && payload.stability >= MIN_STABILITY_READY
        && !payload.ambiguous
        && payload.enough_audio;
    payload
}

fn is_valid_stable_detection(payload: &DetectedKeyPayload) -> bool {
    payload.enough_audio
        && !payload.ambiguous
        && payload.primary_key.is_some()
        && payload.primary_scale.is_some()
        && payload.confidence >= MIN_CONFIDENCE_LIKELY
        && payload.stability >= MIN_STABILITY_LIKELY
}

fn tonic_from_choice(choice: &str) -> String {
    choice.split(':').next().unwrap_or("?").to_string()
}

fn split_choice(choice: &str) -> (String, String) {
    let mut it = choice.split(':');
    let tonic = it.next().unwrap_or("?").to_string();
    let scale = it.next().unwrap_or("?").to_string();
    (tonic, scale)
}

fn tonic_to_pc(tonic: &str) -> Option<i32> {
    match tonic.trim().to_ascii_uppercase().as_str() {
        "C" => Some(0),
        "C#" | "DB" => Some(1),
        "D" => Some(2),
        "D#" | "EB" => Some(3),
        "E" | "FB" => Some(4),
        "F" | "E#" => Some(5),
        "F#" | "GB" => Some(6),
        "G" => Some(7),
        "G#" | "AB" => Some(8),
        "A" => Some(9),
        "A#" | "BB" => Some(10),
        "B" | "CB" => Some(11),
        _ => None,
    }
}

fn circular_interval(a: i32, b: i32) -> i32 {
    let d = (a - b).rem_euclid(12);
    d.min(12 - d)
}

fn is_relative_major_minor(
    key_a: &str,
    scale_a: &str,
    key_b: &str,
    scale_b: &str,
) -> bool {
    let (Some(pc_a), Some(pc_b)) = (tonic_to_pc(key_a), tonic_to_pc(key_b)) else {
        return false;
    };
    if scale_a == "minor" && scale_b == "major" {
        return (pc_a + 3).rem_euclid(12) == pc_b;
    }
    if scale_a == "major" && scale_b == "minor" {
        return (pc_b + 3).rem_euclid(12) == pc_a;
    }
    false
}

fn relative_pair_label(key_a: &str, scale_a: &str, key_b: &str, scale_b: &str) -> String {
    format!("{key_a} {scale_a} vs {key_b} {scale_b}")
}

fn family_mixture_detected(tonic_counts: &BTreeMap<String, usize>) -> bool {
    if tonic_counts.len() < 3 {
        return false;
    }
    let Some((dominant_tonic, _)) = tonic_counts.iter().max_by_key(|(_, c)| *c) else {
        return false;
    };
    let Some(dominant_pc) = tonic_to_pc(dominant_tonic) else {
        return false;
    };
    let mut relatives = 0usize;
    let mut fifth_family = 0usize;
    let mut neighbors = 0usize;
    for tonic in tonic_counts.keys() {
        if tonic == dominant_tonic {
            continue;
        }
        let Some(pc) = tonic_to_pc(tonic) else {
            continue;
        };
        let diff = circular_interval(pc, dominant_pc);
        if diff == 3 {
            relatives += 1;
        }
        if diff == 5 || diff == 7 {
            fifth_family += 1;
        }
        if diff == 2 {
            neighbors += 1;
        }
    }
    (fifth_family >= 2) || (relatives >= 1 && (fifth_family >= 1 || neighbors >= 1))
}

fn window_vote_quality(window_tonic_votes: &BTreeMap<String, usize>) -> (f32, usize) {
    let total: usize = window_tonic_votes.values().sum();
    if total == 0 {
        return (0.0, 0);
    }
    let dominant = window_tonic_votes.values().copied().max().unwrap_or(0);
    (dominant as f32 / total as f32, window_tonic_votes.len())
}

fn tonic_entropy_from_history(history: &VecDeque<String>) -> (f32, BTreeMap<String, usize>, f32) {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for h in history {
        let tonic = tonic_from_choice(h);
        *counts.entry(tonic).or_insert(0) += 1;
    }
    let n = history.len().max(1) as f32;
    let mut entropy = 0.0f32;
    let mut max_share = 0.0f32;
    for c in counts.values() {
        let p = *c as f32 / n;
        if p > 0.0 {
            entropy -= p * p.log2();
            if p > max_share {
                max_share = p;
            }
        }
    }
    (entropy, counts, max_share)
}

#[derive(Debug, Clone)]
struct ContradictionMetrics {
    tonic_entropy: f32,
    dominant_share: f32,
    tonic_counts: BTreeMap<String, usize>,
    competing_tonics: usize,
    distinct_tonics: usize,
    rapid_switches: usize,
    major_minor_conflict: bool,
    family_mixture: bool,
    contradiction_burst: bool,
}

fn contradiction_metrics_from_history(history: &VecDeque<String>) -> ContradictionMetrics {
    let (entropy, tonic_counts, dominant_share) = tonic_entropy_from_history(history);
    let n = history.len().max(1) as f32;
    let competing_tonics = tonic_counts
        .values()
        .filter(|c| (**c as f32 / n) >= COMPETING_TONIC_MIN_SHARE)
        .count();
    let distinct_tonics = tonic_counts.len();

    let mut rapid_switches = 0usize;
    let mut prev = "";
    let mut tonic_scales: BTreeMap<String, BTreeMap<String, usize>> = BTreeMap::new();
    for choice in history {
        if !prev.is_empty() && prev != choice {
            rapid_switches += 1;
        }
        let (tonic, scale) = split_choice(choice);
        *tonic_scales
            .entry(tonic)
            .or_default()
            .entry(scale)
            .or_insert(0) += 1;
        prev = choice;
    }
    let major_minor_conflict = tonic_scales
        .values()
        .any(|scales| scales.contains_key("major") && scales.contains_key("minor"));

    let family_mixture = family_mixture_detected(&tonic_counts);
    let contradiction_burst = (competing_tonics >= 3)
        || (distinct_tonics >= 3 && rapid_switches >= 4)
        || major_minor_conflict
        || family_mixture
        || (entropy > MAX_TONIC_ENTROPY + 0.10);

    ContradictionMetrics {
        tonic_entropy: entropy,
        dominant_share,
        tonic_counts,
        competing_tonics,
        distinct_tonics,
        rapid_switches,
        major_minor_conflict,
        family_mixture,
        contradiction_burst,
    }
}

#[derive(Debug, Clone)]
struct WindowDisagreementMetrics {
    tonic_entropy: f32,
    distinct_tonics: usize,
    scale_conflict_ratio: f32,
    profile_disagreement_ratio: f32,
    family_mixture: bool,
    contradiction_score: f32,
}

fn window_disagreement_metrics(results: &[WindowAnalysisResult]) -> WindowDisagreementMetrics {
    if results.is_empty() {
        return WindowDisagreementMetrics {
            tonic_entropy: 0.0,
            distinct_tonics: 0,
            scale_conflict_ratio: 0.0,
            profile_disagreement_ratio: 0.0,
            family_mixture: false,
            contradiction_score: 0.0,
        };
    }
    let mut tonic_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut tonic_scales: BTreeMap<String, BTreeMap<String, usize>> = BTreeMap::new();
    let mut by_window: BTreeMap<u64, Vec<&WindowAnalysisResult>> = BTreeMap::new();
    for w in results {
        *tonic_counts.entry(w.key.clone()).or_insert(0) += 1;
        *tonic_scales
            .entry(w.key.clone())
            .or_default()
            .entry(w.scale.clone())
            .or_insert(0) += 1;
        by_window.entry(w.window_start_ms).or_default().push(w);
    }
    let total = results.len() as f32;
    let mut entropy = 0.0;
    for c in tonic_counts.values() {
        let p = *c as f32 / total;
        if p > 0.0 {
            entropy -= p * p.log2();
        }
    }
    let scale_conflict_ratio = tonic_scales
        .values()
        .filter(|m| m.contains_key("major") && m.contains_key("minor"))
        .count() as f32
        / tonic_scales.len().max(1) as f32;

    let mut disagreement_windows = 0usize;
    for ws in by_window.values() {
        let mut seen_tonics: BTreeMap<String, usize> = BTreeMap::new();
        for w in ws {
            *seen_tonics.entry(w.key.clone()).or_insert(0) += 1;
        }
        if seen_tonics.len() >= 2 {
            disagreement_windows += 1;
        }
    }
    let profile_disagreement_ratio = disagreement_windows as f32 / by_window.len().max(1) as f32;
    let family_mixture = family_mixture_detected(&tonic_counts);
    let contradiction_score = (entropy / 2.0).clamp(0.0, 1.0) * 0.40
        + scale_conflict_ratio * 0.20
        + profile_disagreement_ratio * 0.25
        + if family_mixture { 0.30 } else { 0.0 };
    WindowDisagreementMetrics {
        tonic_entropy: entropy,
        distinct_tonics: tonic_counts.len(),
        scale_conflict_ratio,
        profile_disagreement_ratio,
        family_mixture,
        contradiction_score: contradiction_score.clamp(0.0, 1.0),
    }
}

fn recent_key_sequence_from_results(results: &[WindowAnalysisResult]) -> Vec<String> {
    let mut by_window: BTreeMap<u64, (&str, &str, f32)> = BTreeMap::new();
    for r in results {
        let e = by_window
            .entry(r.window_start_ms)
            .or_insert((r.key.as_str(), r.scale.as_str(), r.strength));
        if r.strength > e.2 {
            *e = (r.key.as_str(), r.scale.as_str(), r.strength);
        }
    }
    by_window
        .values()
        .map(|(k, s, _)| format!("{k}:{s}"))
        .collect()
}

#[derive(Debug, Clone)]
struct WindowWinner {
    window_start_ms: u64,
    window_end_ms: u64,
    key: String,
    scale: String,
    display_name: String,
    score: f32,
    rel: f32,
}

fn result_vote_score(r: &WindowAnalysisResult) -> (f32, f32) {
    let rel = r.first_to_second_relative_strength.unwrap_or(0.0).max(0.0);
    let score = (r.strength.max(0.0) * 0.7) + (rel * 0.3);
    (score, rel)
}

fn window_winners_from_results(results: &[WindowAnalysisResult]) -> Vec<WindowWinner> {
    let mut by_window: BTreeMap<u64, WindowWinner> = BTreeMap::new();
    for r in results {
        let (score, rel) = result_vote_score(r);
        let candidate = WindowWinner {
            window_start_ms: r.window_start_ms,
            window_end_ms: r.window_end_ms,
            key: r.key.clone(),
            scale: r.scale.clone(),
            display_name: r.display_name.clone(),
            score,
            rel,
        };
        let entry = by_window.entry(r.window_start_ms).or_insert(candidate.clone());
        if candidate.score > entry.score {
            *entry = candidate;
        }
    }
    by_window.into_values().collect()
}

fn recent_window_horizon(winners: &[WindowWinner], recent_count: usize) -> Vec<WindowWinner> {
    if winners.len() <= recent_count {
        return winners.to_vec();
    }
    winners[winners.len().saturating_sub(recent_count)..].to_vec()
}

fn contradiction_burst(keys: &[String]) -> bool {
    if keys.len() < 4 {
        return false;
    }
    let mut tonic_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut switches = 0usize;
    let mut tonic_scales: BTreeMap<String, BTreeMap<String, usize>> = BTreeMap::new();
    let mut prev = "";
    for k in keys.iter().rev().take(6).rev() {
        let (tonic, scale) = split_choice(k);
        *tonic_counts.entry(tonic.clone()).or_insert(0) += 1;
        *tonic_scales
            .entry(tonic)
            .or_default()
            .entry(scale)
            .or_insert(0) += 1;
        if !prev.is_empty() && prev != k {
            switches += 1;
        }
        prev = k;
    }
    let n = keys.len().min(6) as f32;
    let competing = tonic_counts
        .values()
        .filter(|c| (**c as f32 / n) >= COMPETING_TONIC_MIN_SHARE)
        .count();
    let major_minor_conflict = tonic_scales
        .values()
        .any(|sc| sc.contains_key("major") && sc.contains_key("minor"));
    competing >= 3 || (tonic_counts.len() >= 3 && switches >= 3) || major_minor_conflict
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DebugSnapshot {
    backend_used: String,
    fallback_reason: Option<String>,
    decision_history: Vec<String>,
    window_predictions: Vec<String>,
    tonic_counts: BTreeMap<String, usize>,
    primary_key: Option<String>,
    primary_scale: Option<String>,
    confidence: f32,
    stability: f32,
    reason: Option<String>,
}

fn save_debug_artifacts(
    samples: &[f32],
    sample_rate_hz: u32,
    output: &AnalysisOutput,
    payload: &DetectedKeyPayload,
    decision_history: &VecDeque<String>,
) {
    let base = std::env::temp_dir().join("gsv-key-debug");
    if fs::create_dir_all(&base).is_err() {
        return;
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let stem = format!("contradiction_{}_{}", std::process::id(), ts);
    let wav_path = base.join(format!("{stem}.wav"));
    let json_path = base.join(format!("{stem}.json"));
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: sample_rate_hz,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    if let Ok(mut writer) = hound::WavWriter::create(&wav_path, spec) {
        for s in samples.iter().rev().take((sample_rate_hz as usize * 12).min(samples.len())).rev() {
            let s16 = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
            let _ = writer.write_sample(s16);
        }
        let _ = writer.finalize();
    }
    let (_, tonic_counts, _) = tonic_entropy_from_history(decision_history);
    let snapshot = DebugSnapshot {
        backend_used: output.backend_used.clone(),
        fallback_reason: output.fallback_reason.clone(),
        decision_history: decision_history.iter().cloned().collect(),
        window_predictions: recent_key_sequence_from_results(&output.windows),
        tonic_counts,
        primary_key: payload.primary_key.clone(),
        primary_scale: payload.primary_scale.clone(),
        confidence: payload.confidence,
        stability: payload.stability,
        reason: payload.reason.clone(),
    };
    if let Ok(encoded) = serde_json::to_string_pretty(&snapshot) {
        let _ = fs::write(&json_path, encoded);
    }
    log::warn!(
        "key_engine: contradiction burst debug artifacts saved wav='{}' snapshot='{}'",
        wav_path.display(),
        json_path.display()
    );
}

fn aggregate_results(
    results: &[WindowAnalysisResult],
    capture_mode: CaptureMode,
    target_app: Option<String>,
    enough_audio: bool,
    stability_history: &VecDeque<String>,
) -> DetectedKeyPayload {
    if results.is_empty() {
        return DetectedKeyPayload {
            primary_key: None,
            primary_scale: None,
            display_name: None,
            confidence: 0.0,
            stability: 0.0,
            alternatives: Vec::new(),
            source: "audio_analysis".to_string(),
            capture_mode,
            target_app,
            enough_audio,
            buffer_seconds: 0.0,
            window_count: 0,
            ambiguous: true,
            reason: Some("no_analysis_windows".to_string()),
            state: "warming_up".to_string(),
            ready_to_apply: false,
        };
    }

    let winners_all = window_winners_from_results(results);
    let winners = recent_window_horizon(&winners_all, AGGREGATION_RECENT_WINDOW_COUNT);
    let mut vote_map: HashMap<(String, String, String), (f32, usize, f32)> = HashMap::new();
    let denom = winners.len().max(1) as f32;
    for (idx, window) in winners.iter().enumerate() {
        let recency_weight = if winners.len() <= 1 {
            1.0
        } else {
            0.45 + 0.55 * (idx as f32 / (denom - 1.0))
        };
        let score = window.score * recency_weight;
        let entry = vote_map
            .entry((
                window.key.clone(),
                window.scale.clone(),
                window.display_name.clone(),
            ))
            .or_insert((0.0, 0, 0.0));
        entry.0 += score;
        entry.1 += 1;
        entry.2 += window.rel * recency_weight;
    }

    let mut ranked: Vec<(String, String, String, f32, usize, f32)> = vote_map
        .into_iter()
        .map(|((k, s, d), (score, count, rel_sum))| (k, s, d, score, count, rel_sum))
        .collect();
    ranked.sort_by(|a, b| b.3.partial_cmp(&a.3).unwrap_or(std::cmp::Ordering::Equal));

    let mut relative_pair_unresolved = false;
    let mut relative_pair_selected_minor = false;
    let mut relative_pair_label_value: Option<String> = None;
    let mut relative_pair_margin = 0.0f32;
    let mut relative_pair_minor_score = 0.0f32;
    if ranked.len() >= 2 {
        let first = ranked[0].clone();
        let second = ranked[1].clone();
        if is_relative_major_minor(&first.0, &first.1, &second.0, &second.1) {
            relative_pair_label_value =
                Some(relative_pair_label(&first.0, &first.1, &second.0, &second.1));
            let pair_total = (first.3 + second.3).max(1e-6);
            let first_share = first.3 / pair_total;
            let second_share = second.3 / pair_total;
            relative_pair_margin = (first_share - second_share).abs();
            let (minor_choice, top_is_major) = if first.1 == "minor" {
                (format!("{}:{}", first.0, first.1), false)
            } else if second.1 == "minor" {
                (format!("{}:{}", second.0, second.1), true)
            } else {
                (format!("{}:{}", second.0, second.1), false)
            };
            let winner_choices: Vec<String> = winners
                .iter()
                .map(|w| format!("{}:{}", w.key, w.scale))
                .collect();
            let winner_total = winner_choices.len().max(1);
            let third = (winner_total / 3).max(1);
            let early_end = third.min(winner_choices.len());
            let late_start = winner_choices.len().saturating_sub(third);
            let share = |slice: &[String], choice: &str| -> f32 {
                if slice.is_empty() {
                    return 0.0;
                }
                let hits = slice.iter().filter(|c| c.as_str() == choice).count();
                hits as f32 / slice.len() as f32
            };
            let minor_total_share = share(&winner_choices, &minor_choice);
            let minor_early_share = share(&winner_choices[..early_end], &minor_choice);
            let minor_late_share = share(&winner_choices[late_start..], &minor_choice);
            let mut pair_raw_total = 0usize;
            let mut pair_minor_raw = 0usize;
            let mut pair_minor_rel_sum = 0.0f32;
            for r in results {
                let choice = format!("{}:{}", r.key, r.scale);
                if choice == format!("{}:{}", first.0, first.1)
                    || choice == format!("{}:{}", second.0, second.1)
                {
                    pair_raw_total += 1;
                    if choice == minor_choice {
                        pair_minor_raw += 1;
                        pair_minor_rel_sum += r.first_to_second_relative_strength.unwrap_or(0.0).max(0.0);
                    }
                }
            }
            let minor_profile_share = if pair_raw_total > 0 {
                pair_minor_raw as f32 / pair_raw_total as f32
            } else {
                0.0
            };
            let minor_margin_avg = if pair_minor_raw > 0 {
                (pair_minor_rel_sum / pair_minor_raw as f32).clamp(0.0, 1.0)
            } else {
                0.0
            };
            relative_pair_minor_score = (minor_profile_share * 0.30)
                + (minor_early_share * 0.35)
                + (minor_late_share * 0.20)
                + (minor_margin_avg * 0.15);
            // Conservative rule: if major only wins by relative-pair vote advantage and minor center remains meaningful,
            // avoid promoting the relative major as if it were clean.
            if top_is_major
                && minor_early_share >= 0.55
                && minor_total_share >= 0.25
                && relative_pair_minor_score >= 0.46
            {
                ranked.swap(0, 1);
                relative_pair_selected_minor = true;
            } else {
                relative_pair_unresolved =
                    relative_pair_margin <= 0.34 || minor_total_share >= 0.25 || minor_early_share >= 0.50;
            }
            log::info!(
                "key_engine: relative-pair analysis detected={} pair={} pairMargin={:.3} minorChoice={} minorTotalShare={:.3} minorEarlyShare={:.3} minorLateShare={:.3} minorProfileShare={:.3} minorMarginAvg={:.3} minorScore={:.3} selectedMinor={} unresolved={}",
                true,
                relative_pair_label_value.clone().unwrap_or_else(|| "<none>".to_string()),
                relative_pair_margin,
                minor_choice,
                minor_total_share,
                minor_early_share,
                minor_late_share,
                minor_profile_share,
                minor_margin_avg,
                relative_pair_minor_score,
                relative_pair_selected_minor,
                relative_pair_unresolved
            );
        }
    }
    let total_score: f32 = ranked.iter().map(|x| x.3).sum::<f32>().max(1e-6);
    let top = ranked.first().cloned();
    let second = ranked.get(1).cloned();

    let Some((top_key, top_scale, top_display, top_score, top_count, top_rel_sum)) = top else {
        return DetectedKeyPayload::unavailable("no_consensus");
    };

    let top_share = top_score / total_score;
    let second_share = second.map(|s| s.3 / total_score).unwrap_or(0.0);
    let separation = (top_share - second_share).max(0.0);

    let disagreement = window_disagreement_metrics(results);
    let mut alternatives = Vec::new();
    for (key, scale, display, score, _, _) in ranked.iter().skip(1).take(2) {
        alternatives.push(KeyCandidate {
            key: key.clone(),
            scale: scale.clone(),
            display_name: display.clone(),
            confidence: (*score / total_score).min(1.0),
        });
    }

    let history_size = stability_history.len().max(1) as f32;
    let history_match_count = stability_history
        .iter()
        .filter(|h| **h == format!("{top_key}:{top_scale}"))
        .count() as f32;
    let temporal_stability = history_match_count / history_size;
    let window_repeat_ratio = top_count as f32 / winners.len().max(1) as f32;
    let profile_margin = (top_rel_sum / top_count as f32).min(1.0);
    let mut stability =
        ((window_repeat_ratio * 0.55) + (temporal_stability * 0.35) + (profile_margin * 0.10))
            .clamp(0.0, 1.0);
    let mut confidence = ((top_share * 0.65) + (separation * 0.35)).clamp(0.0, 1.0);
    // Penalize mixed tonal evidence to keep v1 conservative.
    let disagreement_penalty = disagreement.contradiction_score;
    confidence = (confidence * (1.0 - 0.55 * disagreement_penalty)).clamp(0.0, 1.0);
    stability = (stability * (1.0 - 0.60 * disagreement_penalty)).clamp(0.0, 1.0);
    let ambiguous = !enough_audio
        || confidence < 0.70
        || stability < 0.68
        || separation < 0.20
        || relative_pair_unresolved
        || disagreement.distinct_tonics >= 3
        || disagreement.tonic_entropy > 0.98
        || disagreement.profile_disagreement_ratio > 0.38
        || disagreement.scale_conflict_ratio > 0.30
        || disagreement.family_mixture;
    let state = if !enough_audio {
        "warming_up"
    } else if ambiguous {
        "ambiguous"
    } else {
        "likely_key"
    };
    let reason = if !enough_audio {
        Some("warming_up".to_string())
    } else if disagreement.distinct_tonics >= 3 {
        Some("contradiction_detected_multiple_tonics".to_string())
    } else if disagreement.scale_conflict_ratio > 0.35 {
        Some("contradiction_detected_major_minor_conflict".to_string())
    } else if disagreement.profile_disagreement_ratio > 0.38 {
        Some("contradiction_detected_profile_disagreement".to_string())
    } else if disagreement.family_mixture {
        Some("contradiction_detected_mixed_tonic_family".to_string())
    } else if relative_pair_unresolved {
        Some(format!(
            "relative_pair_ambiguity:detected=true pair={} pairMargin={:.3} minorScore={:.3}",
            relative_pair_label_value
                .clone()
                .unwrap_or_else(|| "unknown".to_string()),
            relative_pair_margin,
            relative_pair_minor_score
        ))
    } else if relative_pair_selected_minor {
        Some(format!(
            "relative_pair_minor_center_selected:pair={} pairMargin={:.3} minorScore={:.3}",
            relative_pair_label_value
                .clone()
                .unwrap_or_else(|| "unknown".to_string()),
            relative_pair_margin,
            relative_pair_minor_score
        ))
    } else if separation < 0.20 {
        Some("top_candidate_too_close_to_alternative".to_string())
    } else if stability < 0.68 {
        Some("unstable_across_windows".to_string())
    } else if confidence < 0.70 {
        Some("low_confidence".to_string())
    } else {
        None
    };

    apply_capture_degrade(DetectedKeyPayload {
        primary_key: Some(top_key),
        primary_scale: Some(top_scale),
        display_name: Some(top_display),
        confidence,
        stability,
        alternatives,
        source: "audio_analysis".to_string(),
        capture_mode,
        target_app,
        enough_audio,
        buffer_seconds: 0.0,
        window_count: winners.len(),
        ambiguous,
        reason,
        state: state.to_string(),
        ready_to_apply: false,
    })
}

fn with_switch_hysteresis(
    mut next: DetectedKeyPayload,
    last_payload: Option<&DetectedKeyPayload>,
) -> DetectedKeyPayload {
    let Some(last) = last_payload else {
        return next;
    };
    if last.ambiguous {
        return next;
    }
    let (Some(last_key), Some(last_scale), Some(next_key), Some(next_scale)) = (
        last.primary_key.as_deref(),
        last.primary_scale.as_deref(),
        next.primary_key.as_deref(),
        next.primary_scale.as_deref(),
    ) else {
        return next;
    };
    if last_key == next_key && last_scale == next_scale {
        return next;
    }
    if next.confidence < (last.confidence + KEY_SWITCH_HYSTERESIS_CONF_MARGIN) {
        next.ambiguous = true;
        next.ready_to_apply = false;
        next.state = "ambiguous".to_string();
        next.reason = Some("candidate_switch_unstable".to_string());
    }
    next
}

fn apply_ready_streak_gate(
    mut payload: DetectedKeyPayload,
    streak: usize,
    backend_used: &str,
    tonic_entropy: f32,
    dominant_share: f32,
) -> DetectedKeyPayload {
    if payload.state == "likely_key" {
        let (min_conf, min_stab) = if backend_used == "numpy_fallback" {
            (0.80, 0.82)
        } else {
            (MIN_CONFIDENCE_LIKELY, MIN_STABILITY_LIKELY)
        };
        let strong_enough = payload.confidence >= MIN_CONFIDENCE_LIKELY
            && payload.stability >= MIN_STABILITY_LIKELY
            && !payload.ambiguous
            && payload.enough_audio;
        let strong_enough = strong_enough && payload.confidence >= min_conf && payload.stability >= min_stab;
        let diverse_tonics = tonic_entropy > MAX_TONIC_ENTROPY || dominant_share < MIN_DOMINANCE_SHARE;
        if !strong_enough || diverse_tonics {
            payload.ready_to_apply = false;
            payload.reason = Some(format!(
                "insufficient_consensus_for_likely_key:backend={} entropy={:.3} dominance={:.3}",
                backend_used, tonic_entropy, dominant_share
            ));
            return payload;
        }
        if streak < MIN_READY_STREAK {
            payload.ready_to_apply = false;
            payload.reason = Some(format!(
                "waiting_for_stability_confirmation:backend={} streak={}/{}",
                backend_used, streak, MIN_READY_STREAK
            ));
        }
        if backend_used == "numpy_fallback" {
            payload.ready_to_apply = false;
            payload.reason = Some("apply_blocked_numpy_fallback_requires_essentia".to_string());
        }
    }
    payload
}

fn enforce_apply_gate(
    mut payload: DetectedKeyPayload,
    backend_used: &str,
    capture_stable: bool,
    session_stable: bool,
    repeated_key: bool,
    contradiction_active: bool,
    contradiction_cooldown: bool,
    recent_silence: bool,
    window_dominance: f32,
    window_distinct_tonics: usize,
    cm: &ContradictionMetrics,
    likely_streak: usize,
) -> DetectedKeyPayload {
    let endpoint_conservative_ok = if payload.capture_mode == CaptureMode::EndpointLoopback {
        payload.confidence >= 0.88 && payload.stability >= 0.86 && window_dominance >= 0.86
    } else {
        true
    };
    let stable_horizon = cm.tonic_entropy <= MAX_TONIC_ENTROPY
        && cm.dominant_share >= MIN_DOMINANCE_SHARE
        && cm.competing_tonics <= 2
        && !cm.major_minor_conflict
        && !cm.family_mixture
        && window_dominance >= 0.82
        && window_distinct_tonics <= 2;
    let hold_apply_allowed = payload.state == "paused_hold"
        && payload.ready_to_apply
        && backend_used == "essentia"
        && payload.confidence >= MIN_CONFIDENCE_READY
        && payload.stability >= MIN_STABILITY_READY;
    let apply_allowed = hold_apply_allowed || (backend_used == "essentia"
        && payload.state == "likely_key"
        && !payload.ambiguous
        && payload.confidence >= MIN_CONFIDENCE_READY
        && payload.stability >= MIN_STABILITY_READY
        && capture_stable
        && session_stable
        && repeated_key
        && likely_streak >= MIN_READY_STREAK
        && !contradiction_active
        && !contradiction_cooldown
        && !recent_silence
        && !cm.contradiction_burst
        && endpoint_conservative_ok
        && stable_horizon);
    if !apply_allowed {
        payload.ready_to_apply = false;
        if payload.reason.is_none() {
            payload.reason = Some(format!(
                "apply_blocked:backend={} state={} captureMode={:?} captureStable={} sessionStable={} repeatedKey={} likelyStreak={} contradictionActive={} contradictionCooldown={} recentSilence={} contradictionBurst={} endpointConservativeOk={} stableHorizon={} entropy={:.3} dominantShare={:.3} windowDominance={:.3} windowDistinctTonics={}",
                backend_used,
                payload.state,
                payload.capture_mode,
                capture_stable,
                session_stable,
                repeated_key,
                likely_streak,
                contradiction_active,
                contradiction_cooldown,
                recent_silence,
                cm.contradiction_burst,
                endpoint_conservative_ok,
                stable_horizon,
                cm.tonic_entropy,
                cm.dominant_share,
                window_dominance,
                window_distinct_tonics
            ));
        }
    } else {
        payload.ready_to_apply = true;
        if hold_apply_allowed {
            payload.reason = Some("paused_hold_last_good_apply_grace".to_string());
        } else {
            payload.reason = None;
        }
    }
    payload
}

fn relative_pair_from_payload(payload: &DetectedKeyPayload) -> (bool, Option<String>, f32) {
    let (Some(pk), Some(ps)) = (payload.primary_key.as_deref(), payload.primary_scale.as_deref()) else {
        return (false, None, 0.0);
    };
    for alt in &payload.alternatives {
        if is_relative_major_minor(pk, ps, &alt.key, &alt.scale) {
            let margin = (payload.confidence - alt.confidence).abs();
            return (
                true,
                Some(relative_pair_label(pk, ps, &alt.key, &alt.scale)),
                margin,
            );
        }
    }
    (false, None, 0.0)
}

fn default_python_command() -> String {
    std::env::var("KEY_ANALYZER_PYTHON")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            if cfg!(windows) {
                "py".to_string()
            } else {
                "python3".to_string()
            }
        })
}

fn analyzer_executable_candidates(cwd: &std::path::Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if cfg!(windows) {
        out.push(cwd.join("sidecars").join("key_analyzer").join("key_analyzer.exe"));
        out.push(
            cwd.join("src-tauri")
                .join("sidecars")
                .join("key_analyzer")
                .join("key_analyzer.exe"),
        );
    } else {
        out.push(cwd.join("sidecars").join("key_analyzer").join("key_analyzer"));
        out.push(
            cwd.join("src-tauri")
                .join("sidecars")
                .join("key_analyzer")
                .join("key_analyzer"),
        );
    }
    out
}

fn build_current_detector() -> Box<dyn KeyDetector> {
    if let Ok(wsl_sidecar) = std::env::var("KEY_ANALYZER_WSL_SIDECAR") {
        let wsl_sidecar = wsl_sidecar.trim().to_string();
        if !wsl_sidecar.is_empty() {
            let wsl_python = std::env::var("KEY_ANALYZER_WSL_PYTHON")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "python3".to_string());
            return Box::new(SidecarKeyDetector::from_wsl_python_script(
                wsl_python,
                wsl_sidecar,
            ));
        }
    }

    if let Ok(configured) = std::env::var("KEY_ANALYZER_SIDECAR") {
        let path = PathBuf::from(&configured);
        if configured.to_ascii_lowercase().ends_with(".py") {
            let python = default_python_command();
            return Box::new(SidecarKeyDetector::from_python_script(&python, path));
        }
        return Box::new(SidecarKeyDetector::from_executable(path));
    }

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if let Some(exe) = find_existing_path(&analyzer_executable_candidates(&cwd)) {
        return Box::new(SidecarKeyDetector::from_executable(exe));
    }

    let py_candidates = [
        cwd.join("sidecars").join("key_analyzer").join("key_analyzer.py"),
        cwd.join("src-tauri")
            .join("sidecars")
            .join("key_analyzer")
            .join("key_analyzer.py"),
    ];
    if let Some(py_script) = find_existing_path(&py_candidates) {
        let python = default_python_command();
        return Box::new(SidecarKeyDetector::from_python_script(&python, py_script));
    }

    let fallback = if cfg!(windows) {
        PathBuf::from("sidecars/key_analyzer/key_analyzer.exe")
    } else {
        PathBuf::from("sidecars/key_analyzer/key_analyzer")
    };
    Box::new(SidecarKeyDetector::from_executable(fallback))
}

fn build_libkeyfinder_detector() -> Option<Box<dyn KeyDetector>> {
    if let Ok(wsl_cli) = std::env::var("KEY_ANALYZER_LIBKEYFINDER_WSL_CLI") {
        let cli = wsl_cli.trim().to_string();
        if !cli.is_empty() {
            log::info!("key_engine: using libkeyfinder analyzer via WSL CLI");
            return Some(Box::new(LibKeyFinderDetector::from_wsl_executable(cli)));
        }
    }
    if let Ok(cli) = std::env::var("KEY_ANALYZER_LIBKEYFINDER_CLI") {
        let cli = cli.trim().to_string();
        if !cli.is_empty() {
            log::info!("key_engine: using libkeyfinder analyzer via native CLI");
            return Some(Box::new(LibKeyFinderDetector::from_executable(PathBuf::from(cli))));
        }
    }
    None
}

fn build_detector() -> Box<dyn KeyDetector> {
    let analyzer_backend = std::env::var("KEY_ANALYZER_BACKEND")
        .ok()
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "libkeyfinder".to_string());
    if analyzer_backend == "libkeyfinder" {
        if let Some(det) = build_libkeyfinder_detector() {
            return det;
        }
        log::warn!(
            "key_engine: KEY_ANALYZER_BACKEND=libkeyfinder but no CLI configured; falling back to current analyzer"
        );
    }
    build_current_detector()
}

fn top_from_windows(windows: &[WindowAnalysisResult]) -> (Option<String>, Option<String>, Option<String>, f32) {
    if windows.is_empty() {
        return (None, None, None, 0.0);
    }
    let mut votes: HashMap<(String, String), f32> = HashMap::new();
    for w in windows {
        let k = w.key.to_ascii_uppercase();
        let s = w.scale.to_ascii_lowercase();
        *votes.entry((k, s)).or_insert(0.0) += w.strength.max(0.01);
    }
    let mut ranked: Vec<_> = votes.into_iter().collect();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let total: f32 = ranked.iter().map(|(_, s)| *s).sum::<f32>().max(1e-6);
    let ((k, s), top_score) = ranked[0].clone();
    let share = top_score / total;
    let display = format!("{k} {s}");
    (Some(k), Some(s), Some(display), share)
}

#[allow(clippy::too_many_arguments)]
fn hard_reset_engine_state(
    capture: &mut AudioCaptureManager,
    decision_history: &mut VecDeque<String>,
    likely_streak: &mut usize,
    last_buffer_bucket: &mut i32,
    capture_stable_streak: &mut usize,
    session_stable_streak: &mut usize,
    recent_disruption_until: &mut Instant,
    primary_key_repeat_streak: &mut usize,
    last_primary_key_choice: &mut Option<String>,
    last_analyzer_unavailable_sig: &mut Option<String>,
    last_analyzer_unavailable_log: &mut Option<Instant>,
    zero_window_streak: &mut usize,
    last_window_predictions: &mut Vec<String>,
    last_window_tonic_votes: &mut BTreeMap<String, usize>,
    contradiction_active: &mut bool,
    contradiction_clean_streak: &mut usize,
    contradiction_cooldown_until: &mut Instant,
    last_contradiction_cooldown: &mut bool,
    last_apply_eligible: &mut bool,
    analysis_cycles: &mut usize,
    has_valid_analysis: &mut bool,
    last_good_payload: &mut Option<DetectedKeyPayload>,
    last_good_valid_until: &mut Option<Instant>,
    last_payload: &mut Option<DetectedKeyPayload>,
    last_engine_state: &mut String,
    reason: &str,
) {
    capture.reset();
    decision_history.clear();
    *likely_streak = 0;
    *last_buffer_bucket = -1;
    *capture_stable_streak = 0;
    *session_stable_streak = 0;
    *recent_disruption_until = Instant::now();
    *primary_key_repeat_streak = 0;
    *last_primary_key_choice = None;
    *last_analyzer_unavailable_sig = None;
    *last_analyzer_unavailable_log = None;
    *zero_window_streak = 0;
    last_window_predictions.clear();
    last_window_tonic_votes.clear();
    *contradiction_active = false;
    *contradiction_clean_streak = 0;
    *contradiction_cooldown_until = Instant::now();
    *last_contradiction_cooldown = false;
    *last_apply_eligible = false;
    *analysis_cycles = 0;
    *has_valid_analysis = false;
    *last_good_payload = None;
    *last_good_valid_until = None;
    *last_payload = None;
    last_engine_state.clear();
    if let Ok(mut c) = cloud_control_cell().lock() {
        *c = CloudResolutionControl {
            track_identity: None,
            state: "idle".to_string(),
            key: None,
            mode: None,
            error: None,
        };
    }
    log::info!("key_engine: hard reset reason={reason}");
}

pub fn spawn_key_engine(app: AppHandle) {
    let state = state_cell();
    let app_for_thread = app.clone();
    std::thread::Builder::new()
        .name("key-engine".to_string())
        .spawn(move || {
            let detector = build_detector();
            let ab_enabled = std::env::var("KEY_ANALYZER_AB")
                .ok()
                .map(|v| v.trim() == "1" || v.trim().eq_ignore_ascii_case("true"))
                .unwrap_or(false);
            let backend_selected = std::env::var("KEY_ANALYZER_BACKEND")
                .ok()
                .map(|s| s.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "current".to_string());
            let ab_current = if backend_selected == "current" || !ab_enabled {
                None
            } else {
                Some(build_current_detector())
            };
            let ab_libkeyfinder = if backend_selected == "libkeyfinder" || !ab_enabled {
                None
            } else {
                build_libkeyfinder_detector()
            };
            let mut last_ab_payload: Option<AbComparePayload> = None;
            let mut capture = AudioCaptureManager::new();
            let mut last_payload: Option<DetectedKeyPayload> = None;
            let mut last_track_identity: Option<String> = None;
            let mut last_session_available = false;
            let mut last_playback_status = String::new();
            let mut lifecycle_state = EngineLifecycleState::NoSession;
            let mut analyzer_running = false;
            let mut decision_history: VecDeque<String> = VecDeque::with_capacity(10);
            let mut reset_cursor = RESET_SEQUENCE.load(std::sync::atomic::Ordering::Relaxed);
            let mut last_engine_state = String::new();
            let mut likely_streak: usize = 0;
            let mut last_buffer_bucket: i32 = -1;
            let mut last_capture_mode: Option<CaptureMode> = None;
            let mut last_capture_target: Option<String> = None;
            let mut capture_stable_streak: usize = 0;
            let mut session_stable_streak: usize = 0;
            let mut recent_disruption_until = Instant::now();
            let mut last_primary_key_choice: Option<String> = None;
            let mut primary_key_repeat_streak: usize = 0;
            let mut last_analyzer_unavailable_sig: Option<String> = None;
            let mut last_analyzer_unavailable_log: Option<Instant> = None;
            let mut zero_window_streak: usize = 0;
            let mut last_window_predictions: Vec<String> = Vec::new();
            let mut last_window_tonic_votes: BTreeMap<String, usize> = BTreeMap::new();
            let mut contradiction_active = false;
            let mut contradiction_clean_streak: usize = 0;
            let mut contradiction_cooldown_until = Instant::now();
            let mut last_contradiction_cooldown = false;
            let mut last_apply_eligible = false;
            let mut analysis_cycles: usize = 0;
            let mut has_valid_analysis = false;
            let mut last_good_payload: Option<DetectedKeyPayload> = None;
            let mut last_good_valid_until: Option<Instant> = None;

            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("key-engine runtime");

            loop {
                let reset_now = RESET_SEQUENCE.load(std::sync::atomic::Ordering::Relaxed);
                if reset_now != reset_cursor {
                    reset_cursor = reset_now;
                    hard_reset_engine_state(
                        &mut capture,
                        &mut decision_history,
                        &mut likely_streak,
                        &mut last_buffer_bucket,
                        &mut capture_stable_streak,
                        &mut session_stable_streak,
                        &mut recent_disruption_until,
                        &mut primary_key_repeat_streak,
                        &mut last_primary_key_choice,
                        &mut last_analyzer_unavailable_sig,
                        &mut last_analyzer_unavailable_log,
                        &mut zero_window_streak,
                        &mut last_window_predictions,
                        &mut last_window_tonic_votes,
                        &mut contradiction_active,
                        &mut contradiction_clean_streak,
                        &mut contradiction_cooldown_until,
                        &mut last_contradiction_cooldown,
                        &mut last_apply_eligible,
                        &mut analysis_cycles,
                        &mut has_valid_analysis,
                        &mut last_good_payload,
                        &mut last_good_valid_until,
                        &mut last_payload,
                        &mut last_engine_state,
                        "explicit_engine_reset",
                    );
                }

                let media = rt.block_on(media_session::get_current_media_payload());
                let playback_status = media.playback_status.clone();
                let has_session = playback_status != "none" && playback_status != "media_session_unavailable";
                let is_playing = playback_status == "playing";
                let is_paused_or_stopped = matches!(
                    playback_status.as_str(),
                    "paused" | "stopped" | "closed" | "opened" | "changing"
                );
                let current_track_identity = track_identity(&media);
                let cloud_control = cloud_control_cell()
                    .lock()
                    .map(|s| s.clone())
                    .unwrap_or(CloudResolutionControl {
                        track_identity: None,
                        state: "idle".to_string(),
                        key: None,
                        mode: None,
                        error: Some("cloud_resolution_lock_poisoned".to_string()),
                    });
                let cloud_track_matches =
                    current_track_identity.is_some() && cloud_control.track_identity == current_track_identity;
                let cloud_pending = cloud_track_matches && cloud_control.state == "lookup_pending";
                let cloud_hit = cloud_track_matches
                    && cloud_control.state == "hit"
                    && cloud_control.key.is_some()
                    && cloud_control.mode.is_some();

                if has_session != last_session_available {
                    if has_session {
                        log::info!(
                            "key_engine: media session appeared app={:?} status={}",
                            media.source_app,
                            playback_status
                        );
                    } else {
                        log::info!("key_engine: media session disappeared status={}", playback_status);
                        hard_reset_engine_state(
                            &mut capture,
                            &mut decision_history,
                            &mut likely_streak,
                            &mut last_buffer_bucket,
                            &mut capture_stable_streak,
                            &mut session_stable_streak,
                            &mut recent_disruption_until,
                            &mut primary_key_repeat_streak,
                            &mut last_primary_key_choice,
                            &mut last_analyzer_unavailable_sig,
                            &mut last_analyzer_unavailable_log,
                            &mut zero_window_streak,
                            &mut last_window_predictions,
                            &mut last_window_tonic_votes,
                            &mut contradiction_active,
                            &mut contradiction_clean_streak,
                            &mut contradiction_cooldown_until,
                            &mut last_contradiction_cooldown,
                            &mut last_apply_eligible,
                            &mut analysis_cycles,
                            &mut has_valid_analysis,
                            &mut last_good_payload,
                            &mut last_good_valid_until,
                            &mut last_payload,
                            &mut last_engine_state,
                            "session_disappeared",
                        );
                        capture.stop_capture("session_disappeared");
                        last_track_identity = None;
                    }
                    last_session_available = has_session;
                }

                if playback_status != last_playback_status {
                    log::info!(
                        "key_engine: playback state changed {} -> {}",
                        if last_playback_status.is_empty() {
                            "<none>"
                        } else {
                            last_playback_status.as_str()
                        },
                        playback_status
                    );
                    last_playback_status = playback_status.clone();
                }

                let track_changed = has_session
                    && current_track_identity.is_some()
                    && last_track_identity.is_some()
                    && current_track_identity != last_track_identity;
                if track_changed {
                    log::info!(
                        "key_engine: track identity changed old={:?} new={:?}",
                        last_track_identity,
                        current_track_identity
                    );
                    hard_reset_engine_state(
                        &mut capture,
                        &mut decision_history,
                        &mut likely_streak,
                        &mut last_buffer_bucket,
                        &mut capture_stable_streak,
                        &mut session_stable_streak,
                        &mut recent_disruption_until,
                        &mut primary_key_repeat_streak,
                        &mut last_primary_key_choice,
                        &mut last_analyzer_unavailable_sig,
                        &mut last_analyzer_unavailable_log,
                        &mut zero_window_streak,
                        &mut last_window_predictions,
                        &mut last_window_tonic_votes,
                        &mut contradiction_active,
                        &mut contradiction_clean_streak,
                        &mut contradiction_cooldown_until,
                        &mut last_contradiction_cooldown,
                        &mut last_apply_eligible,
                        &mut analysis_cycles,
                        &mut has_valid_analysis,
                        &mut last_good_payload,
                        &mut last_good_valid_until,
                        &mut last_payload,
                        &mut last_engine_state,
                        "track_identity_changed",
                    );
                }
                if has_session && current_track_identity.is_some() {
                    last_track_identity = current_track_identity.clone();
                }
                if has_session && !track_changed {
                    session_stable_streak = session_stable_streak.saturating_add(1);
                }

                if !has_session {
                    if analyzer_running {
                        analyzer_running = false;
                        log::info!("key_engine: analyzer stopped reason=no_active_session");
                    }
                    capture.stop_capture("no_active_session");
                } else if is_paused_or_stopped {
                    if analyzer_running {
                        analyzer_running = false;
                        log::info!("key_engine: analyzer stopped reason=playback_paused_or_stopped");
                    }
                    capture.stop_capture("playback_paused_or_stopped");
                } else if is_playing {
                    if cloud_pending {
                        if analyzer_running {
                            analyzer_running = false;
                            log::info!("key_engine: analyzer stopped reason=cloud_lookup_pending");
                        }
                        capture.stop_capture("cloud_lookup_pending");
                        log::info!("key_engine: local detector skipped due cloud lookup pending");
                    } else if cloud_hit {
                        if analyzer_running {
                            analyzer_running = false;
                            log::info!("key_engine: analyzer stopped reason=cloud_hit");
                        }
                        capture.stop_capture("cloud_hit");
                        log::info!("key_engine: local detector skipped due cloud hit");
                    } else {
                        capture.ensure_capture_running_for_target(media.source_app.clone());
                        capture.poll_capture_samples();
                    }
                }

                capture.mark_stale_if_inactive(Duration::from_millis(STALE_CAPTURE_TIMEOUT_MS));
                let snapshot = capture.snapshot();
                let enough_audio = capture.enough_audio(REQUIRED_AUDIO_SECONDS);
                let analyzer_health = detector.health();
                let lifecycle_target = if !has_session {
                    EngineLifecycleState::NoSession
                } else if track_changed {
                    EngineLifecycleState::TrackChanging
                } else if !is_playing {
                    EngineLifecycleState::Paused
                } else if snapshot.has_live_capture
                    && snapshot.buffer_seconds >= ANALYSIS_WINDOW_SECONDS as f32
                {
                    EngineLifecycleState::PlayingAnalyzing
                } else {
                    EngineLifecycleState::PlayingWarmup
                };
                if lifecycle_state != lifecycle_target {
                    log::info!(
                        "key_engine: lifecycle {:?} -> {:?}",
                        lifecycle_state,
                        lifecycle_target
                    );
                    lifecycle_state = lifecycle_target;
                }
                let buffer_bucket = (snapshot.buffer_seconds / 3.0).floor() as i32;
                if snapshot.has_live_capture && buffer_bucket != last_buffer_bucket {
                    log::debug!(
                        "key_engine: buffer progress {:.1}s (first window {}s, ready target {}s) mode={:?} target={:?}",
                        snapshot.buffer_seconds,
                        ANALYSIS_WINDOW_SECONDS,
                        REQUIRED_AUDIO_SECONDS as usize,
                        snapshot.capture_mode,
                        snapshot.target_app
                    );
                    last_buffer_bucket = buffer_bucket;
                }

                let capture_changed =
                    last_capture_mode != Some(snapshot.capture_mode)
                        || last_capture_target != snapshot.target_app;
                if snapshot.requested_mode != snapshot.capture_mode {
                    log::warn!(
                        "key_engine: capture requestedMode={:?} activeMode={:?} reason={:?} phase={}",
                        snapshot.requested_mode,
                        snapshot.capture_mode,
                        snapshot.mode_reason,
                        if analysis_cycles == 0 {
                            "pre_analysis"
                        } else {
                            "steady_state"
                        }
                    );
                }
                if capture_changed {
                    if last_capture_mode.is_some() {
                        log::warn!(
                            "key_engine: capture mode/target changed {:?}/{:?} -> {:?}/{:?}; requestedMode={:?} reason={:?} phase={}; invalidating confidence",
                            last_capture_mode,
                            last_capture_target,
                            snapshot.capture_mode,
                            snapshot.target_app,
                            snapshot.requested_mode,
                            snapshot.mode_reason,
                            if analysis_cycles == 0 {
                                "pre_analysis"
                            } else {
                                "steady_state"
                            }
                        );
                    }
                    last_capture_mode = Some(snapshot.capture_mode);
                    last_capture_target = snapshot.target_app.clone();
                    capture_stable_streak = 0;
                    recent_disruption_until = if has_valid_analysis {
                        Instant::now() + Duration::from_millis(DISRUPTION_COOLDOWN_MS)
                    } else {
                        Instant::now()
                    };
                    decision_history.clear();
                    likely_streak = 0;
                    primary_key_repeat_streak = 0;
                    last_primary_key_choice = None;
                    contradiction_active = false;
                    contradiction_clean_streak = 0;
                    contradiction_cooldown_until = Instant::now();
                } else if snapshot.has_live_capture {
                    capture_stable_streak = capture_stable_streak.saturating_add(1);
                }

                let mut payload = if !has_session {
                    likely_streak = 0;
                    if media.playback_status == "media_session_unavailable" {
                        DetectedKeyPayload::unavailable("media_session_unavailable")
                    } else {
                        DetectedKeyPayload::unavailable("no_active_session")
                    }
                } else if is_playing && cloud_pending {
                    likely_streak = 0;
                    DetectedKeyPayload::warming_up(
                        CaptureMode::Unavailable,
                        media.source_app.clone(),
                        "cloud_lookup_pending",
                    )
                } else if is_playing && cloud_hit {
                    likely_streak = 0;
                    let key = cloud_control.key.clone().unwrap_or_default().to_ascii_uppercase();
                    let mode = cloud_control.mode.clone().unwrap_or_default().to_ascii_lowercase();
                    let display_name = format!("{key} {mode}");
                    DetectedKeyPayload {
                        primary_key: Some(key),
                        primary_scale: Some(mode),
                        display_name: Some(display_name),
                        confidence: 1.0,
                        stability: 1.0,
                        alternatives: Vec::new(),
                        source: "cloud_verified".to_string(),
                        capture_mode: CaptureMode::Unavailable,
                        target_app: media.source_app.clone(),
                        enough_audio: true,
                        buffer_seconds: snapshot.buffer_seconds,
                        window_count: 0,
                        ambiguous: false,
                        reason: Some("cloud_verified_key".to_string()),
                        state: "likely_key".to_string(),
                        ready_to_apply: true,
                    }
                } else if !analyzer_health.healthy {
                    if analyzer_running {
                        analyzer_running = false;
                        log::info!(
                            "key_engine: analyzer stopped reason=analyzer_unavailable backend={}",
                            analyzer_health.backend
                        );
                    }
                    likely_streak = 0;
                    primary_key_repeat_streak = 0;
                    last_primary_key_choice = None;
                    contradiction_active = false;
                    contradiction_clean_streak = 0;
                    contradiction_cooldown_until = Instant::now();
                    last_contradiction_cooldown = false;
                    has_valid_analysis = false;
                    last_good_payload = None;
                    last_good_valid_until = None;
                    let backend = analyzer_health.backend.clone();
                    let reason = analyzer_health
                        .reason
                        .clone()
                        .unwrap_or_else(|| "analyzer_unavailable".to_string());
                    let sig = format!("{backend}|{reason}");
                    let now = Instant::now();
                    let should_log = last_analyzer_unavailable_sig.as_deref() != Some(sig.as_str())
                        || last_analyzer_unavailable_log
                            .map(|t| now.duration_since(t) >= Duration::from_millis(ANALYZER_UNAVAILABLE_LOG_THROTTLE_MS))
                            .unwrap_or(true);
                    if should_log {
                        log::warn!(
                            "key_engine: analyzer unavailable backend={} reason={}",
                            backend,
                            reason
                        );
                        last_analyzer_unavailable_sig = Some(sig);
                        last_analyzer_unavailable_log = Some(now);
                    }
                    DetectedKeyPayload {
                        source: format!("audio_analysis:{backend}"),
                        capture_mode: snapshot.capture_mode,
                        target_app: snapshot.target_app.clone().or(media.source_app.clone()),
                        reason: Some(format!("analyzer_unavailable:{reason}")),
                        ..DetectedKeyPayload::unavailable("analyzer_unavailable")
                    }
                } else if !is_playing {
                    likely_streak = 0;
                    if !has_valid_analysis {
                        contradiction_active = false;
                        contradiction_clean_streak = 0;
                        contradiction_cooldown_until = Instant::now();
                        last_contradiction_cooldown = false;
                        decision_history.clear();
                        log::info!(
                            "key_engine: contradiction state reset reason=paused_startup_before_first_valid_analysis"
                        );
                    }
                    let hold_active = last_good_valid_until
                        .map(|t| Instant::now() < t)
                        .unwrap_or(false);
                    if hold_active {
                        if let Some(mut held) = last_good_payload.clone() {
                            held.capture_mode = snapshot.capture_mode;
                            held.target_app = snapshot.target_app.clone().or(media.source_app.clone());
                            held.reason = Some("paused_holding_last_good_detection".to_string());
                            held.state = "paused_hold".to_string();
                            log::info!(
                                "key_engine: preserving last good detection during pause for grace window ({}ms)",
                                LAST_GOOD_HOLD_MS
                            );
                            held
                        } else {
                            apply_capture_degrade(DetectedKeyPayload::warming_up(
                                snapshot.capture_mode,
                                snapshot.target_app.clone().or(media.source_app.clone()),
                                "playback_paused",
                            ))
                        }
                    } else {
                        apply_capture_degrade(DetectedKeyPayload::warming_up(
                            snapshot.capture_mode,
                            snapshot.target_app.clone().or(media.source_app.clone()),
                            "playback_paused",
                        ))
                    }
                } else if !snapshot.has_live_capture {
                    likely_streak = 0;
                    apply_capture_degrade(DetectedKeyPayload::warming_up(
                        snapshot.capture_mode,
                        snapshot.target_app.clone().or(media.source_app.clone()),
                        "capture_not_ready",
                    ))
                } else if snapshot.buffer_seconds < ANALYSIS_WINDOW_SECONDS as f32 {
                    // Avoid blaming the analyzer when we simply don't have a full analysis window yet.
                    likely_streak = 0;
                    apply_capture_degrade(DetectedKeyPayload::warming_up(
                        snapshot.capture_mode,
                        snapshot.target_app.clone().or(media.source_app.clone()),
                        "collecting_audio_for_first_window",
                    ))
                } else {
                    if !analyzer_running {
                        analyzer_running = true;
                        log::info!(
                            "key_engine: analyzer started backend={} track={:?}",
                            analyzer_health.backend,
                            current_track_identity
                        );
                    }
                    let samples = capture.latest_samples(REQUIRED_AUDIO_SECONDS as usize);
                    let analyze_started = Instant::now();
                    log::debug!(
                        "key_engine: running analysis on {:.1}s buffer ({} samples)",
                        snapshot.buffer_seconds,
                        samples.len()
                    );
                    let analyzed = detector.analyze(
                        &samples,
                        capture.sample_rate_hz(),
                        ANALYSIS_WINDOW_SECONDS,
                        ANALYSIS_HOP_SECONDS,
                    );
                    let analyze_elapsed = analyze_started.elapsed();
                    log::debug!(
                        "key_engine: analysis finished in {}ms",
                        analyze_elapsed.as_millis()
                    );
                    match analyzed {
                        Ok(output) => {
                            analysis_cycles = analysis_cycles.saturating_add(1);
                            let backend_used = output.backend_used.clone();

                            if ab_enabled {
                                let current_result = if backend_selected == "current" {
                                    let (k, s, dn, share) = top_from_windows(&output.windows);
                                    AbEngineResult {
                                        backend: "current".to_string(),
                                        key: k,
                                        scale: s,
                                        display_name: dn,
                                        share,
                                        window_count: output.windows.len(),
                                        latency_ms: analyze_elapsed.as_millis(),
                                        error: None,
                                    }
                                } else if let Some(det) = ab_current.as_ref() {
                                    let started = Instant::now();
                                    match det.analyze(
                                        &samples,
                                        capture.sample_rate_hz(),
                                        ANALYSIS_WINDOW_SECONDS,
                                        ANALYSIS_HOP_SECONDS,
                                    ) {
                                        Ok(out) => {
                                            let (k, s, dn, share) = top_from_windows(&out.windows);
                                            AbEngineResult {
                                                backend: "current".to_string(),
                                                key: k,
                                                scale: s,
                                                display_name: dn,
                                                share,
                                                window_count: out.windows.len(),
                                                latency_ms: started.elapsed().as_millis(),
                                                error: None,
                                            }
                                        }
                                        Err(e) => AbEngineResult {
                                            backend: "current".to_string(),
                                            key: None,
                                            scale: None,
                                            display_name: None,
                                            share: 0.0,
                                            window_count: 0,
                                            latency_ms: started.elapsed().as_millis(),
                                            error: Some(e),
                                        },
                                    }
                                } else {
                                    AbEngineResult {
                                        backend: "current".to_string(),
                                        key: None,
                                        scale: None,
                                        display_name: None,
                                        share: 0.0,
                                        window_count: 0,
                                        latency_ms: 0,
                                        error: Some("ab_disabled_or_unavailable".to_string()),
                                    }
                                };

                                let lib_result = if backend_selected == "libkeyfinder" {
                                    let (k, s, dn, share) = top_from_windows(&output.windows);
                                    AbEngineResult {
                                        backend: "libkeyfinder".to_string(),
                                        key: k,
                                        scale: s,
                                        display_name: dn,
                                        share,
                                        window_count: output.windows.len(),
                                        latency_ms: analyze_elapsed.as_millis(),
                                        error: None,
                                    }
                                } else if let Some(det) = ab_libkeyfinder.as_ref() {
                                    let started = Instant::now();
                                    match det.analyze(
                                        &samples,
                                        capture.sample_rate_hz(),
                                        ANALYSIS_WINDOW_SECONDS,
                                        ANALYSIS_HOP_SECONDS,
                                    ) {
                                        Ok(out) => {
                                            let (k, s, dn, share) = top_from_windows(&out.windows);
                                            AbEngineResult {
                                                backend: "libkeyfinder".to_string(),
                                                key: k,
                                                scale: s,
                                                display_name: dn,
                                                share,
                                                window_count: out.windows.len(),
                                                latency_ms: started.elapsed().as_millis(),
                                                error: None,
                                            }
                                        }
                                        Err(e) => AbEngineResult {
                                            backend: "libkeyfinder".to_string(),
                                            key: None,
                                            scale: None,
                                            display_name: None,
                                            share: 0.0,
                                            window_count: 0,
                                            latency_ms: started.elapsed().as_millis(),
                                            error: Some(e),
                                        },
                                    }
                                } else {
                                    AbEngineResult {
                                        backend: "libkeyfinder".to_string(),
                                        key: None,
                                        scale: None,
                                        display_name: None,
                                        share: 0.0,
                                        window_count: 0,
                                        latency_ms: 0,
                                        error: Some("ab_disabled_or_unavailable".to_string()),
                                    }
                                };

                                let ab_payload = AbComparePayload {
                                    current: current_result,
                                    libkeyfinder: lib_result,
                                };
                                if last_ab_payload.as_ref() != Some(&ab_payload) {
                                    if let Err(err) =
                                        app_for_thread.emit("detected-key-ab-update", &ab_payload)
                                    {
                                        log::warn!("key_engine emit ab failed: {err}");
                                    }
                                    last_ab_payload = Some(ab_payload);
                                }
                            }

                            let winners_all = window_winners_from_results(&output.windows);
                            let winners_recent =
                                recent_window_horizon(&winners_all, AGGREGATION_RECENT_WINDOW_COUNT);
                            let window_keys: Vec<String> = winners_recent
                                .iter()
                                .map(|w| format!("{}:{}", w.key, w.scale))
                                .collect();
                            let mut tonic_votes: BTreeMap<String, usize> = BTreeMap::new();
                            for choice in &window_keys {
                                *tonic_votes.entry(tonic_from_choice(choice)).or_insert(0) += 1;
                            }
                            last_window_predictions = window_keys.clone();
                            last_window_tonic_votes = tonic_votes;
                            if !output.windows.is_empty() {
                                has_valid_analysis = true;
                                zero_window_streak = 0;
                                let raw_first: Vec<String> = output
                                    .windows
                                    .iter()
                                    .take(3)
                                    .map(|w| {
                                        format!(
                                            "{}:{} {} ({:.2})",
                                            w.profile_type, w.key, w.scale, w.strength
                                        )
                                    })
                                    .collect();
                                let recent_winners_preview: Vec<String> = winners_recent
                                    .iter()
                                    .rev()
                                    .take(4)
                                    .rev()
                                    .map(|w| {
                                        format!(
                                            "{}-{}:{} {} ({:.2})",
                                            w.window_start_ms, w.window_end_ms, w.key, w.scale, w.score
                                        )
                                    })
                                    .collect();
                                let horizon = winners_recent.len();
                                let using_all = winners_recent.len() == winners_all.len();
                                log::info!(
                                    "key_engine: analyzer backend={} requestedMode={:?} activeMode={:?} modeReason={:?} windowsRaw={} uniqueWindows={} aggregationHorizon={} aggregationUsesAllWindows={} fallbackReason={:?} previewRawFirst=[{}] previewRecentWinners=[{}]",
                                    backend_used,
                                    snapshot.requested_mode,
                                    snapshot.capture_mode,
                                    snapshot.mode_reason,
                                    output.windows.len(),
                                    winners_all.len(),
                                    horizon,
                                    using_all,
                                    output.fallback_reason,
                                    raw_first.join(", "),
                                    recent_winners_preview.join(", ")
                                );
                                log::info!(
                                    "key_engine: aggregation inputs backend={} requestedMode={:?} activeMode={:?} modeReason={:?} windowWinnersOrdered={:?}",
                                    backend_used,
                                    snapshot.requested_mode,
                                    snapshot.capture_mode,
                                    snapshot.mode_reason,
                                    winners_recent
                                        .iter()
                                        .map(|w| format!(
                                            "{}-{}:{} {}",
                                            w.window_start_ms, w.window_end_ms, w.key, w.scale
                                        ))
                                        .collect::<Vec<_>>()
                                );
                            } else {
                                zero_window_streak = zero_window_streak.saturating_add(1);
                                log::warn!(
                                    "key_engine: analyzer produced zero windows backend={} fallbackReason={:?} buffer={:.1}s requestedMode={:?} activeMode={:?} modeReason={:?} target={:?} streak={}",
                                    backend_used,
                                    output.fallback_reason,
                                    snapshot.buffer_seconds,
                                    snapshot.requested_mode,
                                    snapshot.capture_mode,
                                    snapshot.mode_reason,
                                    snapshot.target_app,
                                    zero_window_streak
                                );
                                if snapshot.capture_mode == CaptureMode::ProcessLoopback
                                    && zero_window_streak >= 3
                                {
                                    capture.force_endpoint_fallback(
                                        "repeated_zero_windows_on_process_loopback",
                                    );
                                    recent_disruption_until =
                                        Instant::now() + Duration::from_millis(DISRUPTION_COOLDOWN_MS);
                                    log::warn!(
                                        "key_engine: switched to endpoint fallback after repeated zero windows"
                                    );
                                    zero_window_streak = 0;
                                }
                            }
                            log::debug!(
                                "key_engine: analyzed windows={} mode={:?} buffer={:.1}s",
                                output.windows.len(),
                                snapshot.capture_mode,
                                snapshot.buffer_seconds
                            );
                            let mut payload = aggregate_results(
                                &output.windows,
                                snapshot.capture_mode,
                                snapshot.target_app.clone().or(media.source_app.clone()),
                                enough_audio,
                                &decision_history,
                            );
                            if backend_used == "numpy_fallback" {
                                payload.confidence = payload.confidence.min(0.74);
                                payload.ready_to_apply = false;
                                payload.reason = Some(
                                    output
                                        .fallback_reason
                                        .clone()
                                        .map(|r| format!("numpy_fallback:{r}"))
                                        .unwrap_or_else(|| "numpy_fallback:essentia_path_unreliable".to_string()),
                                );
                            }
                            if let (Some(k), Some(s)) =
                                (payload.primary_key.clone(), payload.primary_scale.clone())
                            {
                                if decision_history.len() == HISTORY_HORIZON {
                                    let _ = decision_history.pop_front();
                                }
                                decision_history.push_back(format!("{k}:{s}"));
                            }
                            log::info!(
                                "key_engine: aggregation result backend={} tonicVotes={:?} finalPrimary={:?}:{:?} alternatives={:?}",
                                backend_used,
                                last_window_tonic_votes,
                                payload.primary_key,
                                payload.primary_scale,
                                payload
                                    .alternatives
                                    .iter()
                                    .map(|a| format!("{}:{}({:.3})", a.key, a.scale, a.confidence))
                                    .collect::<Vec<_>>()
                            );
                            let contradiction_now = contradiction_burst(&window_keys);
                            if contradiction_now {
                                save_debug_artifacts(
                                    &samples,
                                    capture.sample_rate_hz(),
                                    &output,
                                    &payload,
                                    &decision_history,
                                );
                            }
                            if contradiction_now {
                                log::warn!(
                                    "key_engine: contradiction burst backend={} windowKeys={:?}",
                                    backend_used,
                                    window_keys
                                );
                                if !contradiction_active {
                                    log::warn!(
                                        "key_engine: contradiction burst started backend={} recentWindows={:?}",
                                        backend_used,
                                        window_keys
                                    );
                                }
                                contradiction_active = true;
                                contradiction_clean_streak = 0;
                                contradiction_cooldown_until = Instant::now()
                                    + Duration::from_millis(CONTRADICTION_COOLDOWN_MS);
                                log::warn!(
                                    "key_engine: contradiction cooldown started for {}ms",
                                    CONTRADICTION_COOLDOWN_MS
                                );
                            } else if contradiction_active {
                                contradiction_clean_streak = contradiction_clean_streak.saturating_add(1);
                                if contradiction_clean_streak >= CONTRADICTION_CLEAR_CLEAN_CYCLES {
                                    contradiction_active = false;
                                    contradiction_clean_streak = 0;
                                    log::info!(
                                        "key_engine: contradiction cleared after {} clean cycles",
                                        CONTRADICTION_CLEAR_CLEAN_CYCLES
                                    );
                                }
                            } else if contradiction_clean_streak > 0 {
                                contradiction_clean_streak = 0;
                            }
                            DetectedKeyPayload {
                                source: format!("audio_analysis:{backend_used}"),
                                ..payload
                            }
                        }
                        Err(e) => DetectedKeyPayload {
                            // Analyzer failures should not pretend likely/ready.
                            capture_mode: snapshot.capture_mode,
                            target_app: snapshot.target_app.clone().or(media.source_app.clone()),
                            source: "audio_analysis".to_string(),
                            reason: Some(format!("analysis_error:{e}")),
                            state: if enough_audio {
                                "ambiguous".to_string()
                            } else {
                                "warming_up".to_string()
                            },
                            enough_audio,
                            ..DetectedKeyPayload::warming_up(
                                snapshot.capture_mode,
                                snapshot.target_app.clone().or(media.source_app.clone()),
                                "analysis_error",
                            )
                        },
                    }
                };

                if payload.source == "audio_analysis" {
                    let backend_tag = if analyzer_health.healthy {
                        analyzer_health.backend.as_str()
                    } else {
                        "unavailable"
                    };
                    payload.source = format!("audio_analysis:{backend_tag}");
                }
                let mut payload = with_switch_hysteresis(payload, last_payload.as_ref());
                payload.buffer_seconds = snapshot.buffer_seconds;
                if let (Some(k), Some(s)) =
                    (payload.primary_key.as_deref(), payload.primary_scale.as_deref())
                {
                    let choice = format!("{k}:{s}");
                    if last_primary_key_choice.as_deref() == Some(choice.as_str()) {
                        primary_key_repeat_streak = primary_key_repeat_streak.saturating_add(1);
                    } else {
                        primary_key_repeat_streak = 1;
                        last_primary_key_choice = Some(choice);
                    }
                } else {
                    primary_key_repeat_streak = 0;
                    last_primary_key_choice = None;
                }

                let recent_disruption = Instant::now() < recent_disruption_until;
                let contradiction_cooldown = Instant::now() < contradiction_cooldown_until;
                let analyzer_backend = analyzer_health.backend.clone();
                let analyzer_ready = analyzer_health.healthy;
                let backend_used = payload
                    .source
                    .strip_prefix("audio_analysis:")
                    .unwrap_or("unavailable")
                    .to_string();
                let result_availability = if !has_valid_analysis {
                    "no_result_yet"
                } else if payload.primary_key.is_some() && payload.primary_scale.is_some() {
                    "ready"
                } else {
                    "warming_up"
                };
                if contradiction_cooldown && !contradiction_active {
                    log::debug!(
                        "key_engine: contradiction cooldown active analyzerBackend={} analyzerReady={} resultAvailability={}",
                        analyzer_backend,
                        analyzer_ready,
                        result_availability
                    );
                }
                if last_contradiction_cooldown && !contradiction_cooldown {
                    log::info!("key_engine: contradiction cooldown ended");
                }
                last_contradiction_cooldown = contradiction_cooldown;
                let cm = contradiction_metrics_from_history(&decision_history);
                let (window_dominance, window_distinct_tonics) =
                    window_vote_quality(&last_window_tonic_votes);
                let (relative_pair_detected, relative_pair, relative_pair_margin) =
                    relative_pair_from_payload(&payload);
                let relative_pair_unresolved = relative_pair_detected
                    && payload
                        .reason
                        .as_deref()
                        .map(|r| r.starts_with("relative_pair_ambiguity"))
                        .unwrap_or(false);
                let dominant_margin = if payload.alternatives.is_empty() {
                    payload.confidence
                } else {
                    payload.confidence - payload.alternatives[0].confidence
                };
                let capture_stable = capture_stable_streak >= CAPTURE_STABLE_MIN_CYCLES;
                let session_stable = session_stable_streak >= SESSION_STABLE_MIN_CYCLES;
                let repeated_key = primary_key_repeat_streak >= PRIMARY_KEY_REPEAT_MIN;
                let recent_silence = snapshot.recent_silence;
                let hold_active = last_good_valid_until
                    .map(|t| Instant::now() < t)
                    .unwrap_or(false);
                let mut contradiction_cooldown_block = contradiction_cooldown;
                if recent_silence {
                    if hold_active {
                        if let Some(mut held) = last_good_payload.clone() {
                            held.capture_mode = snapshot.capture_mode;
                            held.target_app = snapshot.target_app.clone().or(media.source_app.clone());
                            held.reason = Some("recent_silence_holding_last_good_detection".to_string());
                            held.state = "paused_hold".to_string();
                            payload = held;
                            log::info!(
                                "key_engine: preserving last good detection during recent silence for grace window ({}ms)",
                                LAST_GOOD_HOLD_MS
                            );
                        }
                    } else {
                        payload.confidence *= 0.55;
                        payload.stability *= 0.60;
                        payload.ready_to_apply = false;
                        if payload.reason.is_none() {
                            payload.reason = Some("recent_capture_silence_detected".to_string());
                        }
                    }
                }
                if payload.state == "likely_key" {
                    let stable_tonics = cm.tonic_entropy <= MAX_TONIC_ENTROPY
                        && cm.dominant_share >= MIN_DOMINANCE_SHARE
                        && cm.competing_tonics <= 2
                        && !cm.major_minor_conflict
                        && !cm.family_mixture;
                    let margin_ok = dominant_margin >= MIN_PRIMARY_MARGIN;
                    let recent_windows_clean =
                        window_dominance >= 0.82 && window_distinct_tonics <= 2;
                    let contradiction_cooldown_override = contradiction_cooldown
                        && cm.dominant_share >= 0.90
                        && cm.tonic_entropy <= 0.55
                        && window_dominance >= 0.84
                        && primary_key_repeat_streak >= (PRIMARY_KEY_REPEAT_MIN + 2);
                    contradiction_cooldown_block =
                        contradiction_cooldown && !contradiction_cooldown_override;
                    let endpoint_conservative_ok = if payload.capture_mode == CaptureMode::EndpointLoopback {
                        cm.dominant_share >= 0.88 && dominant_margin >= 0.38 && window_dominance >= 0.86
                    } else {
                        true
                    };
                    if !capture_stable
                        || !session_stable
                        || !repeated_key
                        || recent_disruption
                        || contradiction_active
                        || contradiction_cooldown_block
                        || recent_silence
                        || cm.contradiction_burst
                        || relative_pair_unresolved
                        || !stable_tonics
                        || !recent_windows_clean
                        || !endpoint_conservative_ok
                        || !margin_ok
                    {
                        payload.state = "ambiguous".to_string();
                        payload.ambiguous = true;
                        payload.ready_to_apply = false;
                        payload.reason = Some(format!(
                            "gating_denied:backend={} captureMode={:?} captureStable={} sessionStable={} repeatedKey={} recentDisruption={} contradictionActive={} contradictionCooldown={} contradictionCooldownOverride={} contradictionBurst={} recentSilence={} relativePairDetected={} relativePair={:?} relativePairMargin={:.3} relativePairUnresolved={} stableTonics={} recentWindowsClean={} endpointConservativeOk={} marginOk={} entropy={:.3} dominantShare={:.3} competingTonics={} distinctTonics={} rapidSwitches={} majorMinorConflict={} familyMixture={} windowDominance={:.3} windowDistinctTonics={} margin={:.3}",
                            backend_used,
                            payload.capture_mode,
                            capture_stable,
                            session_stable,
                            repeated_key,
                            recent_disruption,
                            contradiction_active,
                            contradiction_cooldown_block,
                            contradiction_cooldown_override,
                            cm.contradiction_burst,
                            recent_silence,
                            relative_pair_detected,
                            relative_pair,
                            relative_pair_margin,
                            relative_pair_unresolved,
                            stable_tonics,
                            recent_windows_clean,
                            endpoint_conservative_ok,
                            margin_ok,
                            cm.tonic_entropy,
                            cm.dominant_share,
                            cm.competing_tonics,
                            cm.distinct_tonics,
                            cm.rapid_switches,
                            cm.major_minor_conflict,
                            cm.family_mixture,
                            window_dominance,
                            window_distinct_tonics,
                            dominant_margin
                        ));
                        log::info!(
                            "key_engine: likely_key denied backend={} captureMode={:?} reasons capture_streak={} session_streak={} key_repeat={} disruption={} contradictionActive={} contradictionCooldown={} contradictionCooldownOverride={} contradictionBurst={} recentSilence={} relativePairDetected={} relativePair={:?} relativePairMargin={:.3} relativePairUnresolved={} endpointConservativeOk={} entropy={:.3} dominantShare={:.3} competingTonics={} distinctTonics={} rapidSwitches={} majorMinorConflict={} familyMixture={} windowDominance={:.3} windowDistinctTonics={} margin={:.3} tonicCounts={:?} recent={:?} windowPredictions={:?} windowTonicVotes={:?}",
                            backend_used,
                            payload.capture_mode,
                            capture_stable_streak,
                            session_stable_streak,
                            primary_key_repeat_streak,
                            recent_disruption,
                            contradiction_active,
                            contradiction_cooldown_block,
                            contradiction_cooldown_override,
                            cm.contradiction_burst,
                            recent_silence,
                            relative_pair_detected,
                            relative_pair,
                            relative_pair_margin,
                            relative_pair_unresolved,
                            endpoint_conservative_ok,
                            cm.tonic_entropy,
                            cm.dominant_share,
                            cm.competing_tonics,
                            cm.distinct_tonics,
                            cm.rapid_switches,
                            cm.major_minor_conflict,
                            cm.family_mixture,
                            window_dominance,
                            window_distinct_tonics,
                            dominant_margin,
                            cm.tonic_counts,
                            decision_history,
                            last_window_predictions,
                            last_window_tonic_votes
                        );
                    } else {
                        log::info!(
                            "key_engine: likely_key promoted backend={} captureMode={:?} contradictionCooldown={} contradictionCooldownOverride={} relativePairDetected={} relativePair={:?} relativePairMargin={:.3} capture_streak={} session_streak={} key_repeat={} entropy={:.3} dominantShare={:.3} competingTonics={} distinctTonics={} windowDominance={:.3} windowDistinctTonics={} recentSilence={} margin={:.3} tonicCounts={:?} recent={:?} windowPredictions={:?} windowTonicVotes={:?}",
                            backend_used,
                            payload.capture_mode,
                            contradiction_cooldown_block,
                            contradiction_cooldown_override,
                            relative_pair_detected,
                            relative_pair,
                            relative_pair_margin,
                            capture_stable_streak,
                            session_stable_streak,
                            primary_key_repeat_streak,
                            cm.tonic_entropy,
                            cm.dominant_share,
                            cm.competing_tonics,
                            cm.distinct_tonics,
                            window_dominance,
                            window_distinct_tonics,
                            recent_silence,
                            dominant_margin,
                            cm.tonic_counts,
                            decision_history,
                            last_window_predictions,
                            last_window_tonic_votes
                        );
                    }
                }
                if payload.state == "likely_key" && !payload.ambiguous {
                    likely_streak = likely_streak.saturating_add(1);
                } else {
                    likely_streak = 0;
                }
                payload = apply_ready_streak_gate(
                    payload,
                    likely_streak,
                    &backend_used,
                    cm.tonic_entropy,
                    cm.dominant_share,
                );
                payload = enforce_apply_gate(
                    payload,
                    &backend_used,
                    capture_stable,
                    session_stable,
                    repeated_key,
                    contradiction_active,
                    contradiction_cooldown_block,
                    recent_silence,
                    window_dominance,
                    window_distinct_tonics,
                    &cm,
                    likely_streak,
                );
                if !payload.ready_to_apply {
                    log::debug!(
                        "key_engine: apply blocked analyzerBackend={} analyzerReady={} resultAvailability={} resultBackend={} requestedMode={:?} activeMode={:?} modeReason={:?} contradictionCooldown={} recentSilence={} reason={:?} entropy={:.3} dominantShare={:.3} windowDominance={:.3} streak={}",
                        analyzer_backend,
                        analyzer_ready,
                        result_availability,
                        backend_used,
                        snapshot.requested_mode,
                        payload.capture_mode,
                        snapshot.mode_reason,
                        contradiction_cooldown_block,
                        recent_silence,
                        payload.reason,
                        cm.tonic_entropy,
                        cm.dominant_share,
                        window_dominance,
                        likely_streak
                    );
                }
                let apply_eligible = payload.ready_to_apply;
                if apply_eligible != last_apply_eligible {
                    if apply_eligible {
                        log::info!(
                            "key_engine: apply eligible analyzerBackend={} analyzerReady={} resultAvailability={} resultBackend={} state={} confidence={:.3} stability={:.3}",
                            analyzer_backend,
                            analyzer_ready,
                            result_availability,
                            backend_used,
                            payload.state,
                            payload.confidence,
                            payload.stability
                        );
                    } else {
                        log::info!(
                            "key_engine: apply blocked analyzerBackend={} analyzerReady={} resultAvailability={} resultBackend={} reason={:?}",
                            analyzer_backend,
                            analyzer_ready,
                            result_availability,
                            backend_used,
                            payload.reason
                        );
                    }
                    last_apply_eligible = apply_eligible;
                }
                if payload.state == "likely_key" && is_valid_stable_detection(&payload) {
                    last_good_payload = Some(payload.clone());
                    last_good_valid_until =
                        Some(Instant::now() + Duration::from_millis(LAST_GOOD_HOLD_MS));
                    log::info!(
                        "key_engine: updated last good stable detection key={:?} scale={:?} readyToApply={} holdMs={}",
                        payload.primary_key,
                        payload.primary_scale,
                        payload.ready_to_apply,
                        LAST_GOOD_HOLD_MS
                    );
                }
                if payload.state != "paused_hold"
                    && last_good_valid_until
                        .map(|t| Instant::now() >= t)
                        .unwrap_or(false)
                {
                    last_good_payload = None;
                    last_good_valid_until = None;
                    log::info!("key_engine: last good detection hold expired");
                }
                if last_payload.as_ref() != Some(&payload) {
                    if payload.state != last_engine_state {
                        log::info!(
                            "key_engine: state {} -> {} (confidence {:.2}, stability {:.2}, mode {:?}, target {:?})",
                            if last_engine_state.is_empty() {
                                "<none>"
                            } else {
                                &last_engine_state
                            },
                            payload.state,
                            payload.confidence,
                            payload.stability,
                            payload.capture_mode,
                            payload.target_app
                        );
                        last_engine_state = payload.state.clone();
                    }
                    log::debug!(
                        "key_engine: media_status={} capture_live={} buffer={:.1}s enough_audio={}",
                        media.playback_status,
                        snapshot.has_live_capture,
                        snapshot.buffer_seconds,
                        payload.enough_audio
                    );
                    if let Ok(mut lock) = state.lock() {
                        *lock = payload.clone();
                    }
                    if let Err(err) = app_for_thread.emit("detected-key-update", &payload) {
                        log::warn!("key_engine emit failed: {err}");
                    }
                    last_payload = Some(payload);
                }

                std::thread::sleep(Duration::from_millis(ANALYZE_EVERY_MS));
            }
        })
        .expect("spawn key-engine thread");
}

#[cfg(test)]
mod tests {
    use super::{
        aggregate_results, apply_ready_streak_gate, contradiction_metrics_from_history,
        enforce_apply_gate, with_switch_hysteresis, ContradictionMetrics,
        track_identity,
    };
    use crate::audio_models::CaptureMode;
    use crate::audio_models::WindowAnalysisResult;
    use crate::media_session::MediaSessionPayload;
    use std::collections::VecDeque;

    #[test]
    fn consensus_marks_ambiguous_when_too_close() {
        let windows = vec![
            WindowAnalysisResult {
                profile_type: "bgate".to_string(),
                key: "E".to_string(),
                scale: "minor".to_string(),
                display_name: "E minor".to_string(),
                strength: 0.79,
                first_to_second_relative_strength: Some(0.14),
                window_start_ms: 0,
                window_end_ms: 12_000,
            },
            WindowAnalysisResult {
                profile_type: "krumhansl".to_string(),
                key: "G".to_string(),
                scale: "major".to_string(),
                display_name: "G major".to_string(),
                strength: 0.76,
                first_to_second_relative_strength: Some(0.11),
                window_start_ms: 4_000,
                window_end_ms: 16_000,
            },
        ];
        let history = VecDeque::new();
        let payload = aggregate_results(
            &windows,
            CaptureMode::ProcessLoopback,
            Some("Spotify.exe".to_string()),
            true,
            &history,
        );
        assert!(payload.ambiguous);
        assert!(!payload.ready_to_apply);
    }

    #[test]
    fn consensus_ready_on_strong_agreement() {
        let windows = vec![
            WindowAnalysisResult {
                profile_type: "bgate".to_string(),
                key: "D".to_string(),
                scale: "major".to_string(),
                display_name: "D major".to_string(),
                strength: 0.91,
                first_to_second_relative_strength: Some(0.35),
                window_start_ms: 0,
                window_end_ms: 12_000,
            },
            WindowAnalysisResult {
                profile_type: "krumhansl".to_string(),
                key: "D".to_string(),
                scale: "major".to_string(),
                display_name: "D major".to_string(),
                strength: 0.88,
                first_to_second_relative_strength: Some(0.31),
                window_start_ms: 4_000,
                window_end_ms: 16_000,
            },
            WindowAnalysisResult {
                profile_type: "shaath".to_string(),
                key: "D".to_string(),
                scale: "major".to_string(),
                display_name: "D major".to_string(),
                strength: 0.86,
                first_to_second_relative_strength: Some(0.29),
                window_start_ms: 8_000,
                window_end_ms: 20_000,
            },
        ];
        let history = VecDeque::from(vec![
            "D:major".to_string(),
            "D:major".to_string(),
            "D:major".to_string(),
        ]);
        let payload = aggregate_results(
            &windows,
            CaptureMode::ProcessLoopback,
            Some("Music.UI.exe".to_string()),
            true,
            &history,
        );
        assert!(!payload.ambiguous);
        assert!(payload.ready_to_apply);
        assert_eq!(payload.primary_key.as_deref(), Some("D"));
        assert_eq!(payload.primary_scale.as_deref(), Some("major"));
    }

    #[test]
    fn recency_overrides_early_window_bias() {
        let mut windows = Vec::new();
        // Early window strongly suggests G major.
        for profile in ["bgate", "krumhansl", "shaath"] {
            windows.push(WindowAnalysisResult {
                profile_type: profile.to_string(),
                key: "G".to_string(),
                scale: "major".to_string(),
                display_name: "G major".to_string(),
                strength: 0.93,
                first_to_second_relative_strength: Some(0.38),
                window_start_ms: 0,
                window_end_ms: 12_000,
            });
        }
        // Later windows consistently suggest E minor.
        for (idx, strength) in [0.81f32, 0.84, 0.86, 0.88].iter().enumerate() {
            let start = (idx as u64 + 1) * 4_000;
            let end = start + 12_000;
            for profile in ["bgate", "krumhansl", "shaath"] {
                windows.push(WindowAnalysisResult {
                    profile_type: profile.to_string(),
                    key: "E".to_string(),
                    scale: "minor".to_string(),
                    display_name: "E minor".to_string(),
                    strength: *strength,
                    first_to_second_relative_strength: Some(0.30),
                    window_start_ms: start,
                    window_end_ms: end,
                });
            }
        }
        let history = VecDeque::from(vec![
            "E:minor".to_string(),
            "E:minor".to_string(),
            "E:minor".to_string(),
        ]);
        let payload = aggregate_results(
            &windows,
            CaptureMode::ProcessLoopback,
            Some("Brave".to_string()),
            true,
            &history,
        );
        assert_eq!(payload.primary_key.as_deref(), Some("E"));
        assert_eq!(payload.primary_scale.as_deref(), Some("minor"));
    }

    #[test]
    fn relative_pair_does_not_promote_relative_major_by_simple_votes() {
        let mut windows = Vec::new();
        // Windows 1-2: E minor wins.
        for start in [0u64, 4_000] {
            for profile in ["bgate", "krumhansl", "shaath", "temperley", "edma"] {
                windows.push(WindowAnalysisResult {
                    profile_type: profile.to_string(),
                    key: "E".to_string(),
                    scale: "minor".to_string(),
                    display_name: "E minor".to_string(),
                    strength: 0.63,
                    first_to_second_relative_strength: Some(0.22),
                    window_start_ms: start,
                    window_end_ms: start + 12_000,
                });
            }
        }
        // Windows 3-7: relative major G wins by raw vote count.
        for start in [8_000u64, 12_000, 16_000, 20_000, 24_000] {
            for profile in ["bgate", "krumhansl", "shaath", "temperley", "edma"] {
                windows.push(WindowAnalysisResult {
                    profile_type: profile.to_string(),
                    key: "G".to_string(),
                    scale: "major".to_string(),
                    display_name: "G major".to_string(),
                    strength: 0.72,
                    first_to_second_relative_strength: Some(0.14),
                    window_start_ms: start,
                    window_end_ms: start + 12_000,
                });
            }
        }
        let history = VecDeque::from(vec![
            "E:minor".to_string(),
            "E:minor".to_string(),
            "G:major".to_string(),
            "G:major".to_string(),
        ]);
        let payload = aggregate_results(
            &windows,
            CaptureMode::ProcessLoopback,
            Some("Brave".to_string()),
            true,
            &history,
        );
        assert!(
            payload.ambiguous || payload.primary_scale.as_deref() == Some("minor"),
            "relative pair should resolve to minor or remain ambiguous, not cleanly promote relative major"
        );
        assert!(
            payload
                .reason
                .as_deref()
                .unwrap_or_default()
                .contains("relative_pair_")
                || payload.primary_scale.as_deref() == Some("minor")
        );
    }

    #[test]
    fn track_identity_ignores_position_changes() {
        let base = MediaSessionPayload {
            title: Some("Numb".to_string()),
            artist: Some("Linkin Park".to_string()),
            album: Some("Meteora".to_string()),
            source_app: Some("Brave".to_string()),
            playback_status: "playing".to_string(),
            position_ms: Some(5_000),
            duration_ms: Some(185_000),
        };
        let mut seeked = base.clone();
        seeked.position_ms = Some(97_000);
        assert_eq!(track_identity(&base), track_identity(&seeked));
    }

    #[test]
    fn track_identity_changes_on_title_change() {
        let first = MediaSessionPayload {
            title: Some("Song A".to_string()),
            artist: Some("Artist".to_string()),
            album: Some("Album".to_string()),
            source_app: Some("Brave".to_string()),
            playback_status: "playing".to_string(),
            position_ms: Some(0),
            duration_ms: Some(200_000),
        };
        let second = MediaSessionPayload {
            title: Some("Song B".to_string()),
            ..first.clone()
        };
        assert_ne!(track_identity(&first), track_identity(&second));
    }

    #[test]
    fn hysteresis_marks_key_switch_as_ambiguous_when_margin_small() {
        let last = crate::audio_models::DetectedKeyPayload {
            primary_key: Some("A".to_string()),
            primary_scale: Some("minor".to_string()),
            display_name: Some("A minor".to_string()),
            confidence: 0.78,
            stability: 0.74,
            alternatives: vec![],
            source: "audio_analysis".to_string(),
            capture_mode: CaptureMode::ProcessLoopback,
            target_app: Some("Spotify.exe".to_string()),
            enough_audio: true,
            buffer_seconds: 45.0,
            window_count: 4,
            ambiguous: false,
            reason: None,
            state: "likely_key".to_string(),
            ready_to_apply: true,
        };
        let next = crate::audio_models::DetectedKeyPayload {
            primary_key: Some("C".to_string()),
            primary_scale: Some("major".to_string()),
            display_name: Some("C major".to_string()),
            confidence: 0.80,
            stability: 0.72,
            alternatives: vec![],
            source: "audio_analysis".to_string(),
            capture_mode: CaptureMode::ProcessLoopback,
            target_app: Some("Spotify.exe".to_string()),
            enough_audio: true,
            buffer_seconds: 46.0,
            window_count: 4,
            ambiguous: false,
            reason: None,
            state: "likely_key".to_string(),
            ready_to_apply: true,
        };
        let gated = with_switch_hysteresis(next, Some(&last));
        assert!(gated.ambiguous);
        assert_eq!(gated.reason.as_deref(), Some("candidate_switch_unstable"));
        assert!(!gated.ready_to_apply);
    }

    #[test]
    fn ready_streak_requires_multiple_consistent_cycles() {
        let payload = crate::audio_models::DetectedKeyPayload {
            primary_key: Some("E".to_string()),
            primary_scale: Some("minor".to_string()),
            display_name: Some("E minor".to_string()),
            confidence: 0.83,
            stability: 0.77,
            alternatives: vec![],
            source: "audio_analysis".to_string(),
            capture_mode: CaptureMode::ProcessLoopback,
            target_app: Some("Spotify.exe".to_string()),
            enough_audio: true,
            buffer_seconds: 50.0,
            window_count: 5,
            ambiguous: false,
            reason: None,
            state: "likely_key".to_string(),
            ready_to_apply: true,
        };
        let first = apply_ready_streak_gate(payload.clone(), 1, "essentia", 0.0, 1.0);
        assert!(!first.ready_to_apply);
        assert!(
            first
                .reason
                .as_deref()
                .unwrap_or_default()
                .starts_with("waiting_for_stability_confirmation")
        );
        let second = apply_ready_streak_gate(payload, 6, "essentia", 0.0, 1.0);
        assert!(second.ready_to_apply);
    }

    fn stable_cm() -> ContradictionMetrics {
        ContradictionMetrics {
            tonic_entropy: 0.1,
            dominant_share: 0.95,
            tonic_counts: std::collections::BTreeMap::from([("D".to_string(), 12usize)]),
            competing_tonics: 1,
            distinct_tonics: 1,
            rapid_switches: 0,
            major_minor_conflict: false,
            family_mixture: false,
            contradiction_burst: false,
        }
    }

    #[test]
    fn contradiction_metrics_detect_burst_for_competing_tonics() {
        let history = VecDeque::from(vec![
            "G:major".to_string(),
            "D:major".to_string(),
            "C:major".to_string(),
            "G:major".to_string(),
            "D:major".to_string(),
            "A:minor".to_string(),
        ]);
        let cm = contradiction_metrics_from_history(&history);
        assert!(cm.contradiction_burst);
        assert!(cm.competing_tonics >= 3 || cm.distinct_tonics >= 3);
    }

    #[test]
    fn apply_gate_blocks_on_contradiction_even_if_confidence_high() {
        let payload = crate::audio_models::DetectedKeyPayload {
            primary_key: Some("G".to_string()),
            primary_scale: Some("major".to_string()),
            display_name: Some("G major".to_string()),
            confidence: 0.92,
            stability: 0.90,
            alternatives: vec![crate::audio_models::KeyCandidate {
                key: "D".to_string(),
                scale: "major".to_string(),
                display_name: "D major".to_string(),
                confidence: 0.42,
            }],
            source: "audio_analysis:essentia".to_string(),
            capture_mode: CaptureMode::ProcessLoopback,
            target_app: Some("Spotify.exe".to_string()),
            enough_audio: true,
            buffer_seconds: 60.0,
            window_count: 10,
            ambiguous: false,
            reason: None,
            state: "likely_key".to_string(),
            ready_to_apply: true,
        };
        let mut cm = stable_cm();
        cm.contradiction_burst = true;
        cm.competing_tonics = 3;
        let gated = enforce_apply_gate(
            payload,
            "essentia",
            true,
            true,
            true,
            true,
            true,
            false,
            0.9,
            1,
            &cm,
            8,
        );
        assert!(!gated.ready_to_apply);
        assert!(gated.reason.is_some());
    }

    #[test]
    fn apply_gate_blocks_numpy_fallback_even_when_stable() {
        let payload = crate::audio_models::DetectedKeyPayload {
            primary_key: Some("A".to_string()),
            primary_scale: Some("minor".to_string()),
            display_name: Some("A minor".to_string()),
            confidence: 0.93,
            stability: 0.92,
            alternatives: vec![],
            source: "audio_analysis:numpy_fallback".to_string(),
            capture_mode: CaptureMode::ProcessLoopback,
            target_app: Some("Spotify.exe".to_string()),
            enough_audio: true,
            buffer_seconds: 60.0,
            window_count: 10,
            ambiguous: false,
            reason: None,
            state: "likely_key".to_string(),
            ready_to_apply: true,
        };
        let gated = enforce_apply_gate(
            payload,
            "numpy_fallback",
            true,
            true,
            true,
            false,
            false,
            false,
            0.9,
            1,
            &stable_cm(),
            8,
        );
        assert!(!gated.ready_to_apply);
    }

    #[test]
    fn apply_gate_blocks_when_recent_silence_detected() {
        let payload = crate::audio_models::DetectedKeyPayload {
            primary_key: Some("G".to_string()),
            primary_scale: Some("major".to_string()),
            display_name: Some("G major".to_string()),
            confidence: 0.96,
            stability: 0.95,
            alternatives: vec![],
            source: "audio_analysis:essentia".to_string(),
            capture_mode: CaptureMode::EndpointLoopback,
            target_app: Some("Brave".to_string()),
            enough_audio: true,
            buffer_seconds: 60.0,
            window_count: 12,
            ambiguous: false,
            reason: None,
            state: "likely_key".to_string(),
            ready_to_apply: true,
        };
        let gated = enforce_apply_gate(
            payload,
            "essentia",
            true,
            true,
            true,
            false,
            false,
            true,
            0.95,
            1,
            &stable_cm(),
            9,
        );
        assert!(!gated.ready_to_apply);
        assert!(gated.reason.unwrap_or_default().contains("recentSilence=true"));
    }

    #[test]
    fn apply_gate_allows_paused_hold_when_last_good_was_ready() {
        let payload = crate::audio_models::DetectedKeyPayload {
            primary_key: Some("E".to_string()),
            primary_scale: Some("minor".to_string()),
            display_name: Some("E minor".to_string()),
            confidence: 0.93,
            stability: 0.91,
            alternatives: vec![],
            source: "audio_analysis:essentia".to_string(),
            capture_mode: CaptureMode::EndpointLoopback,
            target_app: Some("Brave".to_string()),
            enough_audio: true,
            buffer_seconds: 60.0,
            window_count: 12,
            ambiguous: false,
            reason: Some("paused_holding_last_good_detection".to_string()),
            state: "paused_hold".to_string(),
            ready_to_apply: true,
        };
        let gated = enforce_apply_gate(
            payload,
            "essentia",
            true,
            true,
            true,
            false,
            false,
            true,
            0.75,
            2,
            &stable_cm(),
            0,
        );
        assert!(gated.ready_to_apply);
        assert_eq!(
            gated.reason.as_deref(),
            Some("paused_hold_last_good_apply_grace")
        );
    }
}
