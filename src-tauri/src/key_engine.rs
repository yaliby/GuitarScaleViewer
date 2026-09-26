use crate::audio_capture::AudioCaptureManager;
use crate::audio_models::{
    CaptureMode, DetectedKeyPayload, KeyCandidate, NoteSetEvidence, WindowAnalysisResult,
};
use crate::key_confidence;
use crate::key_detection::{AnalysisOutput, KeyDetector, LibKeyFinderDetector, SidecarKeyDetector};
use crate::media_session::{self, MediaSessionPayload};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

// The timing constants are `pub` so `tests/key_accuracy_scoreboard.rs` can report against the
// values that ship instead of a copy that goes stale the first time one of them is tuned.
/// How much audio the buffer must hold before the engine will call an answer anything but
/// `warming_up`. Everything the player waits for is downstream of this number.
///
/// Twenty seconds is where the accuracy curve flattens, not a guess: measured over the corpus,
/// note-set accuracy reaches 100% at 20s and 98.6% of clips already hold the answer they will
/// still hold at 60s. The 45 it replaced predated any measurement of what the extra 25 seconds
/// bought, which was nothing. See `docs/KEY_LATENCY.md`.
pub const REQUIRED_AUDIO_SECONDS: f32 = 20.0;
pub const ANALYSIS_WINDOW_SECONDS: usize = 12;
pub const ANALYSIS_HOP_SECONDS: usize = 4;
/// The most audio handed to the analyzer in one pass, and so the point at which the buffer stops
/// growing and starts sliding.
///
/// It is *not* what makes consecutive passes count as different audio, despite what the note here
/// used to say. `AnalysisEvidence::accept` compares `window_end_ms`, which `key_detection` sets to
/// the span's end on the absolute sample grid, so it advances one hop per cycle from the first
/// cycle onward whether the buffer is growing or sliding. Moving this constant does not move the
/// streak.
///
/// This was 44, and 44 was not a measurement of what helps — it was the largest span believed to
/// reach the analyzer at all. `docs/KEY_ACCURACY_BASELINE.md` recorded that libKeyFinder "fills at
/// most 44 hops, about 41 seconds, however much audio it is given", and concluded that nobody
/// could know whether more audio would help because none could be given. The constant carried a
/// note saying it must not grow.
///
/// That ceiling does not exist in the binary this tree builds. Hop count is linear in duration
/// with no knee — 10s->11, 20s->22, 40s->44, 44s->48, 45s->49, 60s->65, 127s->137 — and the
/// document's own decisive test now goes the other way: splicing 30 seconds of one key onto 30 of
/// another returns a blend rather than the first key's verdict. The chromagram path has not been
/// touched since the commit that recorded the claim, so this is a correction to the measurement
/// and not a regression in the library.
///
/// With the question open again, `scripts/key-research/exp_span.py` answers it out of fold —
/// profile and tonic stage refitted inside each fold *at the span being tested*, so neither arm
/// is closer to its own fitting condition than the other. 396 clips, 6-fold by song, 8 partitions:
///
/// ```text
///   last 20s   note-set 39.3% +/-0.4   tonic 28.7% +/-0.7
///   last 30s            60.9% +/-0.8         48.6% +/-1.3
///   last 44s            69.3% +/-0.7         58.2% +/-1.0   <- what shipped
///   last 52s            71.0% +/-0.8         61.7% +/-0.7
///   full ~58s           72.2% +/-0.7         62.8% +/-0.8
/// ```
///
/// End to end through the shipped binary and re-ranker the same move reads +5.9 note-set and
/// +6.1 tonic, paired +48/-9 and +56/-15 over 666 clips; the cross-validated +2.9 and +4.6 above
/// is the honest figure, because that run's profiles had seen these songs.
///
/// Sixty rather than more, for two reasons that are both limits on the evidence rather than
/// tuning. `ROLLING_BUFFER_SECONDS` and the `latest_samples(60)` call already hold exactly this
/// much, so nothing new is captured — a quarter of what the engine already had was being thrown
/// away. And past ~58 seconds there is no measurement supporting a gain: concatenating the two
/// captures of the 59 songs recorded twice gives ~116 seconds of one key and scores 75.2% +/-3.6
/// note-set against 78.0% +/-1.6 for one capture, which is flat-to-worse inside a wide spread.
/// Raising this further needs a corpus of longer captures first.
///
/// Latency is not what the old value was buying: the CLI takes 0.25s on 44 seconds of audio and
/// 0.34s on 60, against a four-second hop.
pub const MAX_ANALYSIS_SPAN_SECONDS: usize = 60;
/// The longest the engine loop sleeps, and so how quickly play, pause and a track change are
/// noticed — each of which is on the path to the first reading, because the ring only starts
/// filling once playback has been seen and a track change clears it.
///
/// This was a fixed three-second period, and it cost twice. A fresh analysis needs a new hop of
/// audio, so every hop was picked up anywhere from 0 to 3 seconds after it was complete; and a
/// press of play was noticed 0 to 3 seconds after it happened, which delayed the start of the ring
/// by the same. The loop now sleeps until the next hop is due (`next_analysis_due_in`) and never
/// longer than this. A media-session poll is a few D-Bus round trips; twice a second is nothing.
const LOOP_POLL_MS: u64 = 500;
/// The capture pump delivers packets of 4096 frames at 48 kHz, about 85ms each. Waking this long
/// after a hop is due means the packet that completes it has arrived.
const CAPTURE_PACKET_SLACK_MS: u64 = 120;
/// The unit `CAPTURE_STABLE_MIN_CYCLES` and `SESSION_STABLE_MIN_CYCLES` were written in: iterations
/// of a loop that ran every three seconds. They are measured as time now, so polling faster does
/// not quietly shrink nine seconds of required stability to one and a half.
const STABLE_CYCLE_MS: u64 = 3_000;
const MIN_CONFIDENCE_READY: f32 = 0.84;
const MIN_STABILITY_READY: f32 = 0.82;
const MIN_CONFIDENCE_LIKELY: f32 = 0.78;
const MIN_STABILITY_LIKELY: f32 = 0.76;
const STALE_CAPTURE_TIMEOUT_MS: u64 = 7_000;
/// How many cycles the whole gate has to keep allowing before the readout stops hedging.
///
/// Two, and the value is only meaningful alongside [`PRIMARY_KEY_REPEAT_MIN`]: the two are the
/// same requirement counted in two places, and `what_the_two_streaks_cost_together` is the first
/// measurement of them together. On 273 real clips they are almost perfectly redundant — every
/// (repeat, streak) pair that costs the same number of cycles scores the same to the clip — so
/// what the player waits for is the *total*, and six cycles is where its value stops:
///
/// ```text
///   cycles   asserts   right notes   wrong notes   median   precision
///       10       58%           46%           11%      48s         79%   <- 7 + 4, was shipped
///        6       66%           52%           14%      32s         79%   <- 4 + 3, ships
///        4       69%           52%           16%      24s         75%
///        1       73%           54%           19%      20s         74%
/// ```
///
/// The last four cycles of the old wait bought **no precision at all** — 79% either way. They
/// bought sixteen seconds of silence and six clips per hundred that never got a confident answer.
/// Below six the trade inverts: precision falls with every cycle removed.
///
/// Three rather than two, with the sixth cycle taken from the repeat instead. The real corpus
/// cannot tell those two splits apart — every six-cycle setting scores the same to the clip — but
/// the synthetic one can: this constant also gates `lock_point` there, where a streak of 2 locks
/// two more clips and **asserts two wrong roots**, and a streak of 3 locks the same clips as 4,
/// four seconds sooner, still with none. See `docs/KEY_LATENCY.md`.
pub const MIN_READY_STREAK: usize = 3;
const KEY_SWITCH_HYSTERESIS_CONF_MARGIN: f32 = 0.08;
pub const CAPTURE_STABLE_MIN_CYCLES: usize = 3;
pub const SESSION_STABLE_MIN_CYCLES: usize = 3;
/// How many times running the analyzer has to name the same key before the gate believes it.
///
/// Four rather than seven, as the other half of the six-cycle total in [`MIN_READY_STREAK`]. The
/// real corpus cannot tell the splits of six apart — (4,3) and (5,2) score identically to the clip
/// — so the split is settled by the synthetic corpus, which only reads the other constant. Nine
/// here buys back four points of assert-accuracy for eight seconds, and that trade was declined
/// once already; the joint sweep says the same four points are available for free by moving from
/// ten cycles to six.
pub const PRIMARY_KEY_REPEAT_MIN: usize = 4;
const DISRUPTION_COOLDOWN_MS: u64 = 9_000;
const ANALYZER_UNAVAILABLE_LOG_THROTTLE_MS: u64 = 12_000;
const LAST_GOOD_HOLD_MS: u64 = 25_000;
pub const HISTORY_HORIZON: usize = 16;
pub const AGGREGATION_RECENT_WINDOW_COUNT: usize = 9;
const MAX_TONIC_ENTROPY: f32 = 0.76;
const MIN_DOMINANCE_SHARE: f32 = 0.84;
const MIN_PRIMARY_MARGIN: f32 = 0.34;
pub const CONTRADICTION_COOLDOWN_MS: u64 = 15_000;
pub const CONTRADICTION_CLEAR_CLEAN_CYCLES: usize = 4;
const COMPETING_TONIC_MIN_SHARE: f32 = 0.15;

static LATEST_DETECTED_KEY: OnceLock<Arc<Mutex<DetectedKeyPayload>>> = OnceLock::new();
static RESET_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static CLOUD_RESOLUTION: OnceLock<Arc<Mutex<CloudResolutionControl>>> = OnceLock::new();
static ANALYZER_RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();
static ENGINE_STOP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static ENGINE_THREAD: OnceLock<Mutex<Option<std::thread::JoinHandle<()>>>> = OnceLock::new();

/// Every window verdict the engine still counts as evidence about the music playing now.
///
/// Public for the accuracy harness: window bookkeeping is the first of the three steps in a
/// cycle (accept → `recent` → [`decide_from_windows`]), and a replay that reimplemented it would
/// be measuring its own bookkeeping rather than the engine's.
#[derive(Default)]
pub struct AnalysisEvidence {
    windows: Vec<WindowAnalysisResult>,
    last_window_end_ms: u64,
    last_analyzed_endpoint: u64,
    revision: u64,
}

impl AnalysisEvidence {
    fn reset(&mut self) {
        self.windows.clear();
        self.last_window_end_ms = 0;
        self.last_analyzed_endpoint = 0;
        // Revisions remain monotonic across track/capture resets.
    }

    /// The windows the consensus is allowed to see this cycle: recent enough to describe what is
    /// playing now rather than what played a minute ago.
    pub fn recent(&self) -> Vec<WindowAnalysisResult> {
        let cutoff = self
            .last_window_end_ms
            .saturating_sub((AGGREGATION_RECENT_WINDOW_COUNT * ANALYSIS_HOP_SECONDS * 1000) as u64);
        self.windows
            .iter()
            .filter(|w| w.window_end_ms > cutoff)
            .cloned()
            .collect()
    }

    /// Fold a cycle's analysis into the evidence. Returns whether any of it was new — a verdict
    /// about audio already accounted for is not a second opinion, and must not count as one.
    pub fn accept(
        &mut self,
        windows: &[WindowAnalysisResult],
        start_ms: u64,
        endpoint: u64,
    ) -> bool {
        self.last_analyzed_endpoint = endpoint;
        let previous_end = self.last_window_end_ms;
        let mut fresh = false;
        for window in windows {
            let mut absolute = window.clone();
            absolute.window_start_ms += start_ms;
            absolute.window_end_ms += start_ms;
            if absolute.window_end_ms <= previous_end {
                continue;
            }
            self.last_window_end_ms = self.last_window_end_ms.max(absolute.window_end_ms);
            self.windows.push(absolute);
            fresh = true;
        }
        if fresh {
            self.revision = self.revision.saturating_add(1);
            let cutoff = self
                .last_window_end_ms
                .saturating_sub((HISTORY_HORIZON * ANALYSIS_HOP_SECONDS * 1000) as u64);
            self.windows.retain(|window| window.window_end_ms > cutoff);
        }
        fresh
    }
}

/// The capture as it stood when the player paused a known track.
///
/// Pausing stops the capture, which the loop used to read as a capture change on the way down and
/// again on the way back up — and a capture change throws away every reading, because the audio
/// that follows may belong to something else. A resume of the same track into the same capture is
/// not that: the song carries on, and so does the evidence about its key.
///
/// Found on a live run of "You've Got a Friend in Me": paused at twenty seconds, resumed half a
/// minute later, and the engine started again from an empty buffer — whose first twelve seconds,
/// that far into the song, sit on G7 to C minor and read as the relative for another twenty. The
/// span cache says the continuous buffer reaches E♭ four seconds after the resume.
struct PausedCapture {
    mode: CaptureMode,
    target: Option<String>,
    track: String,
    /// What was on screen before the pause, shown again after the resume until the next hop has
    /// been read — otherwise those seconds re-send the pause's own payload.
    payload: Option<DetectedKeyPayload>,
}

/// What a change in the capture's mode or target means for the evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CaptureTransition {
    /// The player paused a known track: the capture stopped, the evidence stays.
    Pausing,
    /// The same track resumed into the capture it paused from: carry on.
    Resuming,
    /// Anything else. The audio may now be something different; start over.
    Changed,
}

fn capture_transition(
    paused: Option<&PausedCapture>,
    mode: CaptureMode,
    target: Option<&str>,
    track: Option<&str>,
    paused_now: bool,
) -> CaptureTransition {
    let Some(paused) = paused else {
        return CaptureTransition::Changed;
    };
    if paused_now && mode == CaptureMode::Unavailable {
        CaptureTransition::Pausing
    } else if !paused_now
        && mode == paused.mode
        && target == paused.target.as_deref()
        && track == Some(paused.track.as_str())
    {
        CaptureTransition::Resuming
    } else {
        CaptureTransition::Changed
    }
}

fn should_run_local_capture(has_session: bool, playing: bool, _cloud_hit: bool) -> bool {
    has_session && playing
}

/// How much audio the first analysis needs, which depends on what is doing the analysing.
///
/// The python sidecar scores fixed `ANALYSIS_WINDOW_SECONDS` windows and has nothing to say about
/// a shorter buffer. libkeyfinder reads whatever it is handed, and its early readings are what
/// `key_confidence` was fitted on — so it starts one hop in.
fn first_analysis_seconds(backend: &str) -> usize {
    if backend == "libkeyfinder" {
        FIRST_ANALYSIS_SECONDS
    } else {
        ANALYSIS_WINDOW_SECONDS
    }
}

/// Whether the payload's confidence is `key_confidence`'s calibrated probability: the newest
/// reading carried the evidence and named the key the consensus settled on.
pub fn evidence_is_calibrated(
    results: &[WindowAnalysisResult],
    payload: &DetectedKeyPayload,
) -> bool {
    key_confidence::calibration_inputs(results).is_some_and(|(_, key, scale)| {
        payload.primary_key.as_deref() == Some(key.as_str())
            && payload.primary_scale.as_deref() == Some(scale.as_str())
    })
}

/// How long a stability requirement written in loop cycles lasts in wall time.
fn stable_window(cycles: usize) -> Duration {
    Duration::from_millis(cycles as u64 * STABLE_CYCLE_MS)
}

/// How long until the ring holds audio the engine has not analysed yet.
///
/// The first analysis is due once the ring holds `first_seconds` counted from its grid origin, and every later one a hop past the last endpoint analysed. The loop sleeps exactly this
/// long (never more than `LOOP_POLL_MS`) so that a hop is read the moment it is complete instead of
/// whenever a fixed period happens to come round.
fn next_analysis_due_in(
    accepted: u64,
    origin: u64,
    last_analyzed_endpoint: u64,
    first_seconds: usize,
    rate: u32,
) -> Duration {
    if rate == 0 {
        return Duration::from_millis(LOOP_POLL_MS);
    }
    let rate = rate as u64;
    let first = origin + first_seconds as u64 * rate;
    let due = first.max(last_analyzed_endpoint + ANALYSIS_HOP_SECONDS as u64 * rate);
    let missing = due.saturating_sub(accepted);
    Duration::from_millis(missing * 1000 / rate + CAPTURE_PACKET_SLACK_MS)
}

/// The buffer the analyzer is handed: a whole number of hops, ending on the hop grid.
///
/// The grid is counted from `origin`, where the ring last started filling
/// (`AudioCaptureManager::grid_origin`), and not from the lifetime sample count. `endpoint` stays
/// lifetime so evidence keeps one monotonic timeline across resets — but a grid anchored to it sits
/// at an arbitrary phase relative to a song that began after a reset, so the first analysis of every
/// song but the first waited for the next lifetime boundary past twelve seconds of audio: 12 to 16
/// seconds in, 14 on average, for nothing.
fn aligned_analysis_samples(
    mut samples: Vec<f32>,
    endpoint: u64,
    origin: u64,
    rate: u32,
) -> (Vec<f32>, u64, u64) {
    let hop = ANALYSIS_HOP_SECONDS as u64 * rate as u64;
    let origin = origin.min(endpoint);
    let aligned = origin + (endpoint - origin) / hop * hop;
    let tail = (endpoint - aligned) as usize;
    samples.truncate(samples.len().saturating_sub(tail));
    // Keep an integral number of hops, ending on the absolute sample grid.
    let available = samples.len() / hop as usize * hop as usize;
    let count = available.min(MAX_ANALYSIS_SPAN_SECONDS * rate as usize);
    let samples = samples[samples.len().saturating_sub(count)..].to_vec();
    let start_ms = (aligned.saturating_sub(samples.len() as u64)) * 1000 / rate as u64;
    (samples, start_ms, aligned)
}

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
    if control.state == "hit"
        && (control.key.as_deref().and_then(tonic_to_pc).is_none()
            || !matches!(control.mode.as_deref(), Some("major" | "minor")))
    {
        return false;
    }
    if let Ok(mut lock) = cloud_control_cell().lock() {
        *lock = control.clone();
        log::info!(
            "key_engine: cloud resolution updated state={} track={:?} key={:?} mode={:?} error={:?}",
            control.state,
            control.track_identity,
            control.key,
            control.mode,
            control.error
        );
        true
    } else {
        log::warn!("key_engine: cloud resolution update dropped — lock poisoned");
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
        .get_or_init(|| {
            Arc::new(Mutex::new(DetectedKeyPayload::unavailable(
                "engine_not_started",
            )))
        })
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
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
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
        // Endpoint loopback confidence stays as measured; the stricter
        // `endpoint_conservative_ok` gate decides eligibility instead of a
        // blanket multiplier. See `endpoint_confidence_is_measured_evidence_*`.
        payload.reason =
            Some(payload.reason.clone().unwrap_or_else(|| {
                "system loopback fallback may include unrelated audio".to_string()
            }));
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

pub fn is_relative_major_minor(key_a: &str, scale_a: &str, key_b: &str, scale_b: &str) -> bool {
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

/// Below this gap between the profile's top two — when those two are relatives — the root is a coin
/// flip and the readout says so instead of picking a side.
///
/// Calibrated over 396 clips, on the analyzer's own cosine scores. Of the 281 clips whose top two
/// candidates are a relative pair:
///
/// ```text
///   gap            n    leader right   runner-up right
///   0.000-0.002   59          47.5%             22.0%
///   0.002-0.004   72          66.7%             13.9%
///   0.004-0.008  112          85.7%              1.8%
///   0.008-0.015   35          88.6%              0.0%
/// ```
///
/// The first row is the only one that is not a verdict: the leader loses more often than it wins
/// and the runner-up takes a fifth. Every threshold was then scored end to end on what it does to
/// the readout, counting every wrong answer rather than only the relative slips:
///
/// ```text
///   gap < 0.001   withdraws 13/93 wrong roots, hedges 12/180 right ones
///   gap < 0.002   withdraws 20/93,             hedges 19/180
///   gap < 0.003   withdraws 30/93,             hedges 37/180
///   gap < 0.004   withdraws 36/93,             hedges 47/180
/// ```
///
/// 0.002 is where it stops paying for itself: one wrong root withdrawn per right one stepped back,
/// and worse than one-for-one beyond. That trade is worth taking only because the two sides are not
/// equal — a hedged root still draws the correct seven notes and names the alternative, while an
/// asserted wrong root puts every bend outside the key. Only the root marker and the degree ruler
/// step back (`keyFusion.ts`); the neck does not change.
///
/// Also measured and rejected: restricting this to clips the re-ranker left alone, on the theory
/// that a re-ranked answer has already consulted chord evidence. It withdraws 15 wrong roots for
/// 15 right ones — strictly worse than not asking the question.
pub const RELATIVE_PAIR_COIN_FLIP_GAP: f32 = 0.002;

/// The analyzer's relative-pair gap for the windows that are actually voting, as a median.
///
/// A median rather than a mean because a single window landing on an unrelated key reports `None`
/// and would otherwise drag an average; and rather than "any window", because one close call in
/// nine is how the music moves, not a coin flip. `None` when no voting window saw a relative pair
/// on top, which is also what an older CLI with no shortlist reports.
fn winner_relative_pair_gap(
    results: &[WindowAnalysisResult],
    winners: &[WindowWinner],
) -> Option<f32> {
    let mut gaps: Vec<f32> = results
        .iter()
        .filter(|r| {
            winners
                .iter()
                .any(|w| w.window_start_ms == r.window_start_ms)
        })
        .filter_map(|r| r.relative_pair_gap)
        .filter(|gap| gap.is_finite())
        .collect();
    if gaps.is_empty() {
        return None;
    }
    gaps.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    Some(gaps[gaps.len() / 2])
}

/// The other name for the same seven notes: C major <-> A minor.
pub fn relative_of(pc: i32, scale: &str) -> (i32, &'static str) {
    if scale == "minor" {
        ((pc + 3).rem_euclid(12), "major")
    } else {
        ((pc - 3).rem_euclid(12), "minor")
    }
}

/// Share of chroma energy at the minor end's raised seventh below which the tonic is treated as
/// unearned. Chosen from the corpus sweep in `docs/KEY_ACCURACY_BASELINE.md`: at 0.025 every one
/// of the engine's 22 relative slips is caught, and the curve is flat from there to 0.040, so the
/// value is not sitting on a cliff.
const TONIC_EVIDENCE_MIN_SHARE: f32 = 0.025;

/// Is there positive evidence for *which* end of a relative pair is home?
///
/// This deliberately does not try to predict whether the engine is wrong — measured on the
/// 72-clip corpus, nothing in the chroma does: the correlation gap between a key and its relative
/// has a median of 0.564 when the engine is right and 0.527 when it slips, and the best single
/// threshold over it scores below the base rate. Bass magnitude is no better (it picks the true
/// tonic in 1 of the 6 slips), and neither is weighting the bass by where it falls in time.
///
/// What *is* separable is whether the recording contains the one cue that distinguishes a minor
/// key from its relative major at all: the **raised seventh** of the minor end, which arrives with
/// harmonic minor's major V. Loops built from natural-minor chords do not have it, and in those
/// the tonal centre genuinely is not determined by the harmony — a musician reading a lead sheet
/// of Am-F-C-G with no melody could not call it either.
///
/// So the question this answers is "has the root been earned?", and a false answer means the
/// readout says so rather than asserting one end. On the corpus that catches 22 of 22 slips, at
/// the cost of hedging 24 of 48 correct answers.
pub fn tonic_is_supported(chroma: &[f32], key: &str, scale: &str) -> Option<bool> {
    if chroma.len() != 12 || !chroma.iter().all(|v| v.is_finite() && *v >= 0.0) {
        return None;
    }
    let total: f32 = chroma.iter().sum();
    if total <= f32::EPSILON {
        return None;
    }
    let pc = tonic_to_pc(key)?;
    // Whichever side of the pair is the minor one: its raised seventh is the cue.
    let minor_pc = if scale == "minor" {
        pc
    } else {
        relative_of(pc, scale).0
    };
    let raised_seventh = chroma[((minor_pc + 11).rem_euclid(12)) as usize] / total;
    Some(raised_seventh > TONIC_EVIDENCE_MIN_SHARE)
}

const PITCH_NAMES: [&str; 12] = [
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

/// Marks the payload's tonic as unresolved when nothing in the audio earned it, and names the
/// relative reading so the UI can offer it instead of the player hunting for it.
///
/// The seven notes are untouched: they are the same set either way, and on the corpus they are
/// right 97.2% of the time. Only the claim about which one is home is withdrawn.
fn apply_tonic_evidence(
    mut payload: DetectedKeyPayload,
    chroma: Option<&[f32]>,
) -> DetectedKeyPayload {
    let (Some(chroma), Some(key), Some(scale)) = (
        chroma,
        payload.primary_key.clone(),
        payload.primary_scale.clone(),
    ) else {
        return payload;
    };
    if !matches!(scale.as_str(), "major" | "minor") {
        return payload;
    }
    match tonic_is_supported(chroma, &key, &scale) {
        Some(false) => {}
        _ => return payload,
    }

    let Some(pc) = tonic_to_pc(&key) else {
        return payload;
    };
    let (rel_pc, rel_scale) = relative_of(pc, &scale);
    let rel_key = PITCH_NAMES[rel_pc as usize];
    let rel_display = format!("{rel_key} {rel_scale}");

    // The relative goes at the head of the alternatives so the frontend's `relativeHedge()` finds
    // it as the runner-up; anything the consensus already listed keeps its order behind it.
    payload
        .alternatives
        .retain(|c| !(c.key == rel_key && c.scale == rel_scale));
    payload.alternatives.insert(
        0,
        KeyCandidate {
            key: rel_key.to_string(),
            scale: rel_scale.to_string(),
            display_name: rel_display.clone(),
            confidence: payload.confidence.min(1.0),
        },
    );
    payload.ambiguous = true;
    payload.state = "ambiguous".to_string();
    payload.ready_to_apply = false;
    payload.reason = Some(format!(
        "relative_pair_ambiguity:pair={} noLeadingTone=true",
        relative_pair_label(&key, &scale, rel_key, rel_scale)
    ));
    payload
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

pub fn window_vote_quality(window_tonic_votes: &BTreeMap<String, usize>) -> (f32, usize) {
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
pub struct ContradictionMetrics {
    pub tonic_entropy: f32,
    pub dominant_share: f32,
    pub tonic_counts: BTreeMap<String, usize>,
    pub competing_tonics: usize,
    pub distinct_tonics: usize,
    pub rapid_switches: usize,
    pub major_minor_conflict: bool,
    pub family_mixture: bool,
    pub contradiction_burst: bool,
}

/// The window-vote half of the gate's inputs, derived the way the engine loop derives them.
///
/// One call rather than five public pieces, deliberately: reproducing this by hand is exactly what
/// a harness would get subtly wrong, and "the harness mirrors the loop, almost" is how a gate ends
/// up measured and still broken.
#[derive(Debug, Clone)]
pub struct WindowEvidence {
    pub window_keys: Vec<String>,
    pub window_dominance: f32,
    pub window_distinct_tonics: usize,
    pub contradiction_burst: bool,
}

pub fn window_evidence(results: &[WindowAnalysisResult]) -> WindowEvidence {
    let winners_all = window_winners_from_results(results);
    let winners_recent = recent_window_horizon(&winners_all, AGGREGATION_RECENT_WINDOW_COUNT);
    let window_keys: Vec<String> = winners_recent
        .iter()
        .map(|w| format!("{}:{}", w.key, w.scale))
        .collect();
    let mut tonic_votes: BTreeMap<String, usize> = BTreeMap::new();
    for choice in &window_keys {
        *tonic_votes.entry(tonic_from_choice(choice)).or_insert(0) += 1;
    }
    let (window_dominance, window_distinct_tonics) = window_vote_quality(&tonic_votes);
    WindowEvidence {
        contradiction_burst: contradiction_burst(&window_keys),
        window_keys,
        window_dominance,
        window_distinct_tonics,
    }
}

/// The engine's margin over its own runner-up, as the gate reads it.
pub fn dominant_margin_of(payload: &DetectedKeyPayload) -> f32 {
    if payload.alternatives.is_empty() {
        payload.confidence
    } else {
        payload.confidence - payload.alternatives[0].confidence
    }
}

/// Whether the doubt in this payload is specifically an unsettled relative pair.
pub fn relative_pair_unresolved_in(payload: &DetectedKeyPayload) -> bool {
    let (detected, _, _) = relative_pair_from_payload(payload);
    detected
        && payload
            .reason
            .as_deref()
            .map(|r| r.starts_with("relative_pair_ambiguity"))
            .unwrap_or(false)
}

/// Everything the live gate reads that is not in `ContradictionMetrics`.
///
/// This exists so the gate can be *reached*. It used to be forty lines inline in the engine's
/// async loop, which meant no test in the repository touched the decision that determines whether
/// a player is ever shown a confident key — and a defect lived there for a session behind numbers
/// that all looked fine, because every harness stopped at `decide_from_windows` one step earlier.
#[derive(Debug, Clone)]
pub struct LiveGateInputs {
    pub capture_mode: CaptureMode,
    pub capture_stable: bool,
    pub session_stable: bool,
    pub repeated_key: bool,
    pub recent_disruption: bool,
    pub contradiction_active: bool,
    pub contradiction_cooldown: bool,
    pub recent_silence: bool,
    pub relative_pair_unresolved: bool,
    pub primary_key_repeat_streak: usize,
    pub dominant_margin: f32,
    pub window_dominance: f32,
    pub window_distinct_tonics: usize,
    /// The payload's confidence is `key_confidence`'s calibrated probability, which has already
    /// weighed the evidence the repetition-based conditions below were standing in for.
    pub evidence_calibrated: bool,
}

/// Whether the readout may assert the key, and each named condition behind that.
///
/// The parts are public because the reason a gate refused is the only thing that has ever caught a
/// bug here — the `why:` field, not the accuracy numbers.
#[derive(Debug, Clone, PartialEq)]
pub struct LiveGateVerdict {
    pub allowed: bool,
    pub stable_tonics: bool,
    pub margin_ok: bool,
    pub recent_windows_clean: bool,
    pub endpoint_conservative_ok: bool,
    pub contradiction_cooldown_block: bool,
    pub contradiction_cooldown_override: bool,
}

/// The last word on `likely_key`: may the app stop hedging?
pub fn live_gate(inputs: &LiveGateInputs, cm: &ContradictionMetrics) -> LiveGateVerdict {
    let stable_tonics = cm.tonic_entropy <= MAX_TONIC_ENTROPY
        && cm.dominant_share >= MIN_DOMINANCE_SHARE
        && cm.competing_tonics <= 2
        && !cm.major_minor_conflict
        && !cm.family_mixture;
    let margin_ok = inputs.dominant_margin >= MIN_PRIMARY_MARGIN;
    let recent_windows_clean =
        inputs.window_dominance >= 0.82 && inputs.window_distinct_tonics <= 2;
    let contradiction_cooldown_override = inputs.contradiction_cooldown
        && cm.dominant_share >= 0.90
        && cm.tonic_entropy <= 0.55
        && inputs.window_dominance >= 0.84
        && inputs.primary_key_repeat_streak >= (PRIMARY_KEY_REPEAT_MIN + 2);
    let contradiction_cooldown_block =
        inputs.contradiction_cooldown && !contradiction_cooldown_override;
    let endpoint_conservative_ok = if inputs.capture_mode == CaptureMode::EndpointLoopback {
        cm.dominant_share >= 0.88
            && inputs.dominant_margin >= 0.38
            && inputs.window_dominance >= 0.86
    } else {
        true
    };
    // Two kinds of condition, and only one of them survives calibration. The capture being stable,
    // the session unchanged, no silence, no burst of contradicting windows, the root not a coin
    // flip — those are facts about the listening conditions, and a probability fitted on clean
    // recordings knows nothing about them. The rest (the repeat streak, the history's entropy, the
    // vote's margins) are repetition counting as evidence, and `key_confidence` measured that the
    // scores themselves are the better evidence: twelve seconds sooner, fewer wrong diagrams.
    let evidence_ok = inputs.evidence_calibrated
        || (inputs.repeated_key
            && !cm.contradiction_burst
            && stable_tonics
            && recent_windows_clean
            && endpoint_conservative_ok
            && margin_ok);
    let denied = !inputs.capture_stable
        || !inputs.session_stable
        || inputs.recent_disruption
        || inputs.contradiction_active
        || contradiction_cooldown_block
        || inputs.recent_silence
        || inputs.relative_pair_unresolved
        || !evidence_ok;
    LiveGateVerdict {
        allowed: !denied,
        stable_tonics,
        margin_ok,
        recent_windows_clean,
        endpoint_conservative_ok,
        contradiction_cooldown_block,
        contradiction_cooldown_override,
    }
}

pub fn contradiction_metrics_from_history(history: &VecDeque<String>) -> ContradictionMetrics {
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
    // Keyed on the window's whole span, not just where it starts.
    //
    // `profile_disagreement_ratio` below asks one question: for a *single stretch of audio*, do the
    // independent tone profiles name different tonics? That is a NumPy-backend idea — it emits a
    // krumhansl and a temperley result per window, sharing both endpoints.
    //
    // The libkeyfinder backend has one profile and emits one window per pass, always as
    // `window_start_ms: 0` with `window_end_ms` set to however much buffer that pass read. While
    // the buffer is still growing every pass therefore starts at zero, so keying on the start
    // alone dropped every cycle into one bucket — and the engine changing its mind *over time* was
    // scored as two profiles disagreeing *at the same time*. Measured over 273 real clips, that
    // misfire is the largest single reason the readout never stops hedging: 19% of clips, against
    // 8% for the relative-pair hedge and 6% for genuine instability across windows.
    //
    // Both endpoints preserves the NumPy meaning exactly — its two profiles still share a window —
    // and separates passes that read different amounts of audio, which are different observations
    // rather than a contradiction.
    let mut by_window: BTreeMap<(u64, u64), Vec<&WindowAnalysisResult>> = BTreeMap::new();
    for w in results {
        *tonic_counts.entry(w.key.clone()).or_insert(0) += 1;
        *tonic_scales
            .entry(w.key.clone())
            .or_default()
            .entry(w.scale.clone())
            .or_insert(0) += 1;
        by_window
            .entry((w.window_start_ms, w.window_end_ms))
            .or_default()
            .push(w);
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
        let e = by_window.entry(r.window_start_ms).or_insert((
            r.key.as_str(),
            r.scale.as_str(),
            r.strength,
        ));
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

/// One verdict per stretch of audio: which reading the consensus is allowed to vote with.
///
/// Grouping is on the window's *start*, because that is what identifies a stretch of audio for the
/// NumPy backend — it scores one window with several independent tone profiles, and only one of
/// them may vote or a single window would outvote the song. Choosing between them on correlation
/// strength is right: they are genuinely competing descriptions of the same audio.
///
/// **They are not competing when the spans differ, and that is the case that ships.**
/// `key_detection::LibKeyFinderDetector` reports every pass as `window_start_ms: 0` with
/// `window_end_ms` set to however much buffer it read, so while the capture buffer is still
/// growing every cycle lands in this one bucket — and "highest strength wins" then means the pass
/// that read the *least* audio can hold the readout for as long as it stays inside
/// `AnalysisEvidence::recent`'s 36-second horizon. Two passes that start at the same instant and
/// read different amounts are not two opinions to choose between: the longer one contains the
/// shorter one, so it supersedes it rather than competing with it.
///
/// Measured on the capture that prompted this — "You've Got a Friend in Me", E♭ major, captured
/// through the app's own listening path. What libKeyFinder actually returns over the growing
/// buffer, span by span:
///
/// ```text
///   12s   A# major   strength 0.693   <- the highest strength of the whole run
///   16s   D# major            0.601
///   20s   D# major            0.622
///   ...   D# major       0.62..0.66   every pass to 60s, never anything else
/// ```
///
/// The analyzer had E♭ at sixteen seconds and never changed its mind. The readout showed B♭ — the
/// dominant, a different note set — from its first reading at 14s of buffer until 55s, and then
/// switched the instant the early pass aged out of the recency horizon rather than because any new
/// audio said so. Those nine wrong cycles then filled `decision_history`, whose 16-cycle window
/// needs 15/16 agreement for `endpoint_conservative_ok`, so the song ended still showing
/// "hedged, 35%" — 127 seconds of playback, no confident answer, on audio that was never in doubt.
///
/// Strength is not a measure of how much evidence a pass had; it is a correlation fit, and a short
/// buffer that happens to sit on one chord fits a profile beautifully. `docs/KEY_ACCURACY_BASELINE.md`
/// prices the real relationship out of fold: 20s of audio scores 39.3% note-set, 44s scores 69.3%,
/// 60s scores 72.2%. More audio is monotonically better evidence, so among nested spans the
/// longest is simply the best reading available and the rest are its own history.
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
        let entry = by_window
            .entry(r.window_start_ms)
            .or_insert(candidate.clone());
        let supersedes = candidate.window_end_ms > entry.window_end_ms
            || (candidate.window_end_ms == entry.window_end_ms && candidate.score > entry.score);
        if supersedes {
            *entry = candidate;
        }
    }
    by_window.into_values().collect()
}

// Scores are correlation fits, not probabilities. Convert relative support with
// a fixed, mode-neutral temperature, then average profiles within one window.
// Several profiles describing the same audio never count as extra time evidence.
fn candidate_support_for_window(
    results: &[WindowAnalysisResult],
    start_ms: u64,
) -> BTreeMap<(String, String), f32> {
    let mut support = BTreeMap::new();
    let mut profiles = 0;
    for result in results.iter().filter(|r| r.window_start_ms == start_ms) {
        let Some(candidates) = result.candidates.as_ref().filter(|c| !c.is_empty()) else {
            continue;
        };
        let valid: Vec<_> = candidates
            .iter()
            .filter(|c| {
                c.score.is_finite()
                    && (0.0..=1.0).contains(&c.score)
                    && tonic_to_pc(&c.key).is_some()
                    && matches!(c.scale.as_str(), "major" | "minor")
            })
            .collect();
        if valid.is_empty() {
            continue;
        }
        let top = valid.iter().map(|c| c.score).fold(0.0_f32, f32::max);
        let total: f32 = valid.iter().map(|c| ((c.score - top) / 0.04).exp()).sum();
        for candidate in valid {
            *support
                .entry((candidate.key.clone(), candidate.scale.clone()))
                .or_insert(0.0) += ((candidate.score - top) / 0.04).exp() / total;
        }
        profiles += 1;
    }
    if profiles > 0 {
        for value in support.values_mut() {
            *value /= profiles as f32;
        }
    }
    support
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
        for s in samples
            .iter()
            .rev()
            .take((sample_rate_hz as usize * 12).min(samples.len()))
            .rev()
        {
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

/// One analysis cycle's verdict: the consensus over the windows in evidence, then the
/// tonic-evidence gate over that consensus.
///
/// The engine loop calls this rather than composing the two itself, so that the accuracy harness
/// can replay a growing buffer through the decision the app actually makes. The pair has to stay
/// in this order — the gate withdraws a root the consensus was willing to assert, and reversing
/// them would gate a single window instead of the agreed answer.
pub fn decide_from_windows(
    results: &[WindowAnalysisResult],
    capture_mode: CaptureMode,
    target_app: Option<String>,
    enough_audio: bool,
    stability_history: &VecDeque<String>,
    chroma: Option<&[f32]>,
) -> DetectedKeyPayload {
    let payload = aggregate_results(
        results,
        capture_mode,
        target_app,
        enough_audio,
        stability_history,
    );
    let payload = apply_tonic_evidence(payload, chroma);
    withhold_unsettled_early_reading(payload, results)
}

/// Below this much audio a reading reaches the neck only once its notes are settled.
///
/// The engine now analyses from `FIRST_ANALYSIS_SECONDS`, because a clear song is often clear after
/// eight seconds and there is no reason to make the player wait for a clock. But an early reading
/// that has *not* earned `key_confidence::CONFIDENT_NOTE_SET_P` is wrong about the notes nearly
/// half the time, and until now nothing at all was shown before twelve seconds. So those readings
/// stay off the neck exactly as before, and the ones that have earned it arrive four to eight
/// seconds sooner than anything used to. From here on every reading is shown, settled or not —
/// `keyFusion.ts` never withholds an answer, and neither does this past the first window.
pub const UNSETTLED_DISPLAY_MIN_SECONDS: usize = 12;

/// How much audio the libkeyfinder backend analyses first. One hop: the earliest buffer the grid
/// can produce, since the readings before the neck shows anything are evidence too — agreement
/// with them is one of `key_confidence`'s inputs, and it was fitted on readings from four seconds.
pub const FIRST_ANALYSIS_SECONDS: usize = ANALYSIS_HOP_SECONDS;

fn withhold_unsettled_early_reading(
    payload: DetectedKeyPayload,
    results: &[WindowAnalysisResult],
) -> DetectedKeyPayload {
    let Some((inputs, _, _)) = key_confidence::calibration_inputs(results) else {
        return payload;
    };
    if inputs.span_seconds >= UNSETTLED_DISPLAY_MIN_SECONDS as f32
        || payload.confidence >= key_confidence::CONFIDENT_NOTE_SET_P
    {
        return payload;
    }
    DetectedKeyPayload {
        enough_audio: payload.enough_audio,
        window_count: payload.window_count,
        ..DetectedKeyPayload::warming_up(
            payload.capture_mode,
            payload.target_app.clone(),
            &format!("early_reading_unsettled:p={:.2}", payload.confidence),
        )
    }
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
            note_set_evidence: None,
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
            evidence_id: None,
            track_identity: None,
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
        // Blend the recent three windows with the longer nine-window context.
        // Recent evidence can eventually replace an earlier tonal center.
        let recency_weight = recency_weight * if idx + 3 >= winners.len() { 2.0 } else { 1.0 };
        let support = candidate_support_for_window(results, window.window_start_ms);
        if !support.is_empty() {
            for ((key, scale), share) in support {
                let entry = vote_map
                    .entry((key.clone(), scale.clone(), format!("{key} {scale}")))
                    .or_insert((0.0, 0, 0.0));
                entry.0 += share * recency_weight;
                if key == window.key && scale == window.scale {
                    entry.1 += 1;
                    entry.2 += window.rel;
                }
            }
            continue;
        }
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
    let mut relative_pair_label_value = None;
    let mut relative_pair_margin = 0.0;
    if ranked.len() >= 2 {
        let first = &ranked[0];
        let second = &ranked[1];
        if is_relative_major_minor(&first.0, &first.1, &second.0, &second.1) {
            relative_pair_label_value = Some(relative_pair_label(
                &first.0, &first.1, &second.0, &second.1,
            ));
            relative_pair_margin = (first.3 - second.3).abs() / (first.3 + second.3).max(1e-6);
            relative_pair_unresolved = relative_pair_margin <= 0.34;
        }
    }
    // The vote is not allowed to be the last word on this. The test above asks how close the two
    // *names* are in the window vote, and that question resolves itself for the wrong reason: once
    // the windows consolidate on one end of the pair the margin runs to 1.0 and the hedge silently
    // disappears, so a relative slip is presented at full confidence. A field recording of
    // "Dimyon Hofshi" (E minor) showed exactly that — hedged at pairMargin 0.288, flipped to the
    // relative at 0.107, then locked G major at 100% once every window agreed.
    //
    // Window agreement cannot settle a relative pair, because both names describe the same seven
    // notes. Only the analyzer's own margin between them can, so that is what decides here, and it
    // overrides the vote in both directions.
    // When it fires with the pair absent from the vote, the other name has to be *named*: the
    // readout recovers "this is a relative pair" from `alternatives`, not from `reason`, and a
    // consolidated vote leaves `alternatives` empty. Without this the hedge downgrades a correct
    // diagram to "unsure" instead of "notes settled, root open" — and `keyFusion.ts` cannot tell
    // the two ends apart to hold one of them, which is the whole point.
    // Reported separately from the vote ratio above rather than overwriting it: one is a cosine gap
    // between two candidates and the other a normalised share of the window vote. Printing both as
    // `pairMargin` made two unrelated quantities look like one number drifting, which cost a
    // debugging session on a real log.
    let mut coin_flip_gap = None;
    let mut coin_flip_relative = None;
    if let Some((gap, leader)) = winner_relative_pair_gap(results, &winners).zip(ranked.first()) {
        relative_pair_unresolved = gap < RELATIVE_PAIR_COIN_FLIP_GAP;
        if relative_pair_unresolved {
            coin_flip_gap = Some(gap);
            let (relative_pc, relative_scale) =
                relative_of(tonic_to_pc(&leader.0).unwrap_or(0), &leader.1);
            let relative_key = PITCH_NAMES[relative_pc as usize];
            if relative_pair_label_value.is_none() {
                relative_pair_label_value = Some(relative_pair_label(
                    &leader.0,
                    &leader.1,
                    relative_key,
                    relative_scale,
                ));
            }
            coin_flip_relative = Some((relative_key.to_string(), relative_scale.to_string()));
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
    // At the head, so the frontend's `relativeHedge()` finds it as the runner-up — the same
    // placement `apply_tonic_evidence` uses for the same reason.
    if let Some((relative_key, relative_scale)) = coin_flip_relative.as_ref() {
        alternatives.retain(|c| !(&c.key == relative_key && &c.scale == relative_scale));
        alternatives.insert(
            0,
            KeyCandidate {
                key: relative_key.clone(),
                scale: relative_scale.clone(),
                display_name: format!("{relative_key} {relative_scale}"),
                confidence: top_share.min(1.0),
            },
        );
    }

    let history_size = stability_history.len().max(1) as f32;
    let history_match_count = stability_history
        .iter()
        .filter(|h| **h == format!("{top_key}:{top_scale}"))
        .count() as f32;
    let temporal_stability = history_match_count / history_size;
    let window_repeat_ratio = top_count as f32 / winners.len().max(1) as f32;
    let profile_margin = (top_rel_sum / top_count.max(1) as f32).min(1.0);
    let mut stability =
        ((window_repeat_ratio * 0.55) + (temporal_stability * 0.35) + (profile_margin * 0.10))
            .clamp(0.0, 1.0);
    let mut confidence = ((top_share * 0.65) + (separation * 0.35)).clamp(0.0, 1.0);
    // Penalize mixed tonal evidence to keep v1 conservative.
    let disagreement_penalty = disagreement.contradiction_score;
    confidence = (confidence * (1.0 - 0.55 * disagreement_penalty)).clamp(0.0, 1.0);
    stability = (stability * (1.0 - 0.60 * disagreement_penalty)).clamp(0.0, 1.0);
    let candidate_fits: Vec<f32> = results
        .iter()
        .filter(|r| {
            winners
                .iter()
                .any(|w| w.window_start_ms == r.window_start_ms)
        })
        .filter_map(|r| r.candidates.as_ref())
        .filter_map(|c| c.iter().find(|c| c.key == top_key && c.scale == top_scale))
        .map(|c| c.score)
        .collect();
    // Relative separation alone can make even noise look decisive. Require
    // absolute tonal fit as well; this is an evidence gate, not accuracy calibration.
    let weak_fit = !candidate_fits.is_empty()
        && candidate_fits.iter().sum::<f32>() / (candidate_fits.len() as f32) < 0.65;
    if weak_fit {
        confidence = confidence.min(0.69);
    }
    let ambiguous = !enough_audio
        || weak_fit
        || confidence < 0.70
        || stability < 0.68
        || separation < 0.20
        || relative_pair_unresolved
        || disagreement.distinct_tonics >= 3
        || disagreement.tonic_entropy > 0.98
        || disagreement.profile_disagreement_ratio > 0.38
        || disagreement.scale_conflict_ratio > 0.30
        || disagreement.family_mixture;
    let relative_pair_reason = relative_pair_unresolved.then(|| {
        let pair = relative_pair_label_value.unwrap_or_else(|| "unknown".into());
        match coin_flip_gap {
            // The analyzer could not separate the two names. `pairGap` is its own cosine margin,
            // measured against `RELATIVE_PAIR_COIN_FLIP_GAP` — not a share of the window vote, and
            // it is what decided this, whatever the windows happen to be doing.
            Some(gap) => format!("relative_pair_ambiguity:pair={pair} pairGap={gap:.4}"),
            None => {
                format!("relative_pair_ambiguity:pair={pair} pairMargin={relative_pair_margin:.3}")
            }
        }
    });
    let state = if !enough_audio {
        "warming_up"
    } else if ambiguous {
        "ambiguous"
    } else {
        "likely_key"
    };
    let reason = if !enough_audio {
        Some("warming_up".to_string())
    } else if weak_fit {
        Some("weak_absolute_tonal_fit".to_string())
    } else if disagreement.distinct_tonics >= 3 {
        Some("contradiction_detected_multiple_tonics".to_string())
    } else if disagreement.scale_conflict_ratio > 0.35 {
        Some("contradiction_detected_major_minor_conflict".to_string())
    } else if disagreement.profile_disagreement_ratio > 0.38 {
        Some("contradiction_detected_profile_disagreement".to_string())
    } else if disagreement.family_mixture {
        Some("contradiction_detected_mixed_tonic_family".to_string())
    } else if let Some(pair_reason) = relative_pair_reason.clone() {
        Some(pair_reason)
    } else if separation < 0.20 {
        Some("top_candidate_too_close_to_alternative".to_string())
    } else if stability < 0.68 {
        Some("unstable_across_windows".to_string())
    } else if confidence < 0.70 {
        Some("low_confidence".to_string())
    } else {
        None
    };

    // Evidence, not repetition, decides whether the notes are settled — whenever the analyzer sent
    // the evidence and the consensus is talking about the key the newest reading named. Everything
    // above is then context for the log: none of it is a better predictor of a right diagram than
    // `key_confidence`, and several of its terms (the buffer gate above all) are the clock standing
    // in for evidence that is now measured directly. See `key_confidence` for the numbers.
    //
    // The root is a separate question with its own calibrated gate, so a relative-pair coin flip
    // still keeps the readout hedged — the neck shows `tonic_open`, notes settled and root open.
    let note_set_evidence = key_confidence::calibration_inputs(results)
        .filter(|(_, key, scale)| *key == top_key && *scale == top_scale)
        .map(|(inputs, _, _)| NoteSetEvidence {
            confidence: key_confidence::note_set_probability(&inputs),
            note_set_run: inputs.run as u32,
            key_run: key_confidence::key_run(results) as u32,
        });
    let (confidence, ambiguous, state, reason) = match note_set_evidence.map(|e| e.confidence) {
        Some(p) => {
            let notes_settled = p >= key_confidence::CONFIDENT_NOTE_SET_P;
            let settled = notes_settled && !relative_pair_unresolved;
            let reason = if !notes_settled {
                Some(format!("note_set_unconfirmed:p={p:.2}"))
            } else {
                relative_pair_reason
            };
            (
                p,
                !settled,
                if settled { "likely_key" } else { "ambiguous" },
                reason,
            )
        }
        None => (confidence, ambiguous, state, reason),
    };

    apply_capture_degrade(DetectedKeyPayload {
        primary_key: Some(top_key),
        primary_scale: Some(top_scale),
        display_name: Some(top_display),
        confidence,
        note_set_evidence,
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
        evidence_id: None,
        track_identity: None,
        ready_to_apply: false,
    })
}

pub fn with_switch_hysteresis(
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
    // A previous near-perfect score must not permanently lock the key. High
    // stability includes repeated fresh temporal evidence and window agreement.
    let sustained = next.enough_audio
        && next.window_count >= 7
        && next.stability >= 0.90
        && next.confidence >= MIN_CONFIDENCE_READY;
    if !sustained && next.confidence < (last.confidence + KEY_SWITCH_HYSTERESIS_CONF_MARGIN) {
        next.ambiguous = true;
        next.ready_to_apply = false;
        next.state = "ambiguous".to_string();
        next.reason = Some("candidate_switch_unstable".to_string());
    }
    next
}

pub fn apply_ready_streak_gate(
    mut payload: DetectedKeyPayload,
    streak: usize,
    backend_used: &str,
    tonic_entropy: f32,
    dominant_share: f32,
) -> DetectedKeyPayload {
    if payload.source == "cloud_verified" {
        return payload;
    }
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
        let strong_enough =
            strong_enough && payload.confidence >= min_conf && payload.stability >= min_stab;
        let diverse_tonics =
            tonic_entropy > MAX_TONIC_ENTROPY || dominant_share < MIN_DOMINANCE_SHARE;
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
            payload.reason = Some("suggestion_only_uncalibrated_analyzer".to_string());
        }
    }
    payload
}

// The gate weighs every independent signal the engine tracks; bundling them into a
// struct would only move the same list one level out.
#[allow(clippy::too_many_arguments)]
pub fn enforce_apply_gate(
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
    // A validated database record has no local capture/streak requirement.
    if payload.source == "cloud_verified"
        && payload.primary_key.is_some()
        && matches!(payload.primary_scale.as_deref(), Some("major" | "minor"))
    {
        payload.ready_to_apply = !payload.ambiguous;
        payload.reason = Some("cloud_verified_key".to_string());
        return payload;
    }
    let endpoint_conservative_ok = if payload.capture_mode == CaptureMode::EndpointLoopback {
        // Keep the measured evidence score and apply the stricter endpoint gate
        // explicitly. A separate 0.85 multiplier made this gate unreachable.
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
        && matches!(backend_used, "essentia" | "libkeyfinder")
        && payload.confidence >= MIN_CONFIDENCE_READY
        && payload.stability >= MIN_STABILITY_READY;
    let stable_live_evidence = payload.state == "likely_key"
        && payload.enough_audio
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
        && stable_horizon;
    let apply_allowed = hold_apply_allowed
        || (matches!(backend_used, "essentia" | "libkeyfinder") && stable_live_evidence);
    // Live Jam may follow a clearly labelled estimate. Keep the stricter practice
    // auto-apply contract, while sharing all silence/ambiguity/horizon safeguards.
    if backend_used == "numpy_fallback" && stable_live_evidence {
        payload.ready_to_apply = false;
        payload.reason = Some("stable_numpy_estimate".to_string());
        return payload;
    }
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
    let (Some(pk), Some(ps)) = (
        payload.primary_key.as_deref(),
        payload.primary_scale.as_deref(),
    ) else {
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

/// Directories that may contain a bundled `sidecars/` tree.
///
/// A packaged build is launched with an arbitrary cwd (a desktop launcher, `cd /tmp && app`),
/// so cwd-relative lookup alone loses the analyzer. The executable's own location is the only
/// anchor that survives packaging, and the extra hops cover where each bundler drops resources.
fn analyzer_search_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let mut push = |p: PathBuf| {
        if !roots.contains(&p) {
            roots.push(p);
        }
    };

    if let Ok(cwd) = std::env::current_dir() {
        push(cwd.join("src-tauri"));
        push(cwd);
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            push(exe_dir.to_path_buf());
            // macOS app bundle: Contents/MacOS/<bin> -> Contents/Resources
            push(exe_dir.join("../Resources"));
            // Linux .deb/.rpm: /usr/bin/<bin> -> /usr/lib/<bin>
            if let Some(stem) = exe.file_stem() {
                push(exe_dir.join("../lib").join(stem));
            }
            push(exe_dir.join("../lib").join("fretboard-studio"));
            push(exe_dir.join("../lib").join("guitar-scale-viewer"));
            // Dev build: target/debug/<bin> -> src-tauri
            push(exe_dir.join("../.."));
        }
    }

    roots
}

fn analyzer_file_candidates(file_name: &str) -> Vec<PathBuf> {
    analyzer_search_roots()
        .into_iter()
        .map(|root| root.join("sidecars").join("key_analyzer").join(file_name))
        .collect()
}

fn analyzer_executable_candidates() -> Vec<PathBuf> {
    analyzer_file_candidates(if cfg!(windows) {
        "key_analyzer.exe"
    } else {
        "key_analyzer"
    })
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

    // Look in the bundled resource directory first (that is where the packaged
    // PyInstaller build lands), then fall back to the cross-platform search
    // roots so dev builds and Linux/macOS installs resolve too.
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let resource_dir = ANALYZER_RESOURCE_DIR
        .get()
        .cloned()
        .unwrap_or_else(|| cwd.clone());
    let analyzer_exe_name = if cfg!(windows) {
        "key_analyzer.exe"
    } else {
        "key_analyzer"
    };
    let mut exe_candidates = vec![
        resource_dir.join("analyzer").join(analyzer_exe_name),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("sidecars/key_analyzer/dist/key_analyzer")
            .join(analyzer_exe_name),
    ];
    exe_candidates.extend(analyzer_executable_candidates());
    if let Some(exe) = find_existing_path(&exe_candidates) {
        return Box::new(SidecarKeyDetector::from_executable(exe));
    }

    let py_candidates = analyzer_file_candidates("key_analyzer.py");
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
            return Some(Box::new(LibKeyFinderDetector::from_executable(
                PathBuf::from(cli),
            )));
        }
    }
    // libkeyfinder is the default backend, so find a locally built CLI without making the
    // user export KEY_ANALYZER_LIBKEYFINDER_CLI by hand (see sidecars/libkeyfinder_cli/build.sh).
    if let Some(cli) = find_existing_path(&libkeyfinder_cli_candidates()) {
        log::info!(
            "key_engine: using libkeyfinder analyzer discovered at {}",
            cli.display()
        );
        return Some(Box::new(LibKeyFinderDetector::from_executable(cli)));
    }
    None
}

fn libkeyfinder_cli_candidates() -> Vec<PathBuf> {
    let exe_name = if cfg!(windows) {
        "gsv-libkeyfinder-cli.exe"
    } else {
        "gsv-libkeyfinder-cli"
    };
    let mut out = Vec::new();
    for root in analyzer_search_roots() {
        let cli_dir = root.join("sidecars").join("libkeyfinder_cli");
        out.push(cli_dir.join("build").join(exe_name));
        out.push(cli_dir.join(exe_name));
        out.push(root.join("bin").join(exe_name));
    }
    out
}

/// The analyzer the app runs with when nothing asks for another one.
///
/// It is `libkeyfinder` because that is the backend the accuracy work was measured on and the
/// one `dev.sh`, `dev.ps1` and the README all call the default. Defaulting to the python sidecar
/// instead meant a launch without the env var reported `analyzer_unavailable` on a machine where
/// the native CLI was built and working — a shipped default disagreeing with its own docs.
/// Missing CLI is still handled: `build_detector` falls back to the sidecar and says so.
fn selected_backend() -> String {
    std::env::var("KEY_ANALYZER_BACKEND")
        .ok()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "libkeyfinder".to_string())
}

fn build_detector() -> Box<dyn KeyDetector> {
    let analyzer_backend = selected_backend();
    if analyzer_backend == "libkeyfinder" {
        if let Some(det) = build_libkeyfinder_detector() {
            return det;
        }
        log::warn!(
            "key_engine: KEY_ANALYZER_BACKEND=libkeyfinder but no CLI was found (set \
             KEY_ANALYZER_LIBKEYFINDER_CLI or run sidecars/libkeyfinder_cli/build.sh); \
             falling back to the python analyzer"
        );
    }
    build_current_detector()
}

fn top_from_windows(
    windows: &[WindowAnalysisResult],
) -> (Option<String>, Option<String>, Option<String>, f32) {
    if windows.is_empty() {
        return (None, None, None, 0.0);
    }
    let mut votes: HashMap<(String, String), f32> = HashMap::new();
    for w in windows {
        let k = w.key.clone();
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
    capture_stable_since: &mut Option<Instant>,
    session_stable_since: &mut Option<Instant>,
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
    *capture_stable_since = None;
    *session_stable_since = None;
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
    if let Ok(resource_dir) = app.path().resource_dir() {
        let _ = ANALYZER_RESOURCE_DIR.set(resource_dir);
    }
    let state = state_cell();
    let app_for_thread = app.clone();
    let handle = std::thread::Builder::new()
        .name("key-engine".to_string())
        .spawn(move || {
            log::info!("key_engine: thread started; waiting for media session + cloud control");
            let detector = build_detector();
            let ab_enabled = std::env::var("KEY_ANALYZER_AB")
                .ok()
                .map(|v| v.trim() == "1" || v.trim().eq_ignore_ascii_case("true"))
                .unwrap_or(false);
            let backend_selected = selected_backend();
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
            // Whether `last_payload`'s confidence came from `key_confidence`. Carried across loop
            // passes because the gate re-reads the last payload on passes with no new audio.
            let mut payload_calibrated = false;
            let mut evidence = AnalysisEvidence::default();
            let mut cloud_seeded_track: Option<String> = None;
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
            let mut capture_stable_since: Option<Instant> = None;
            let mut session_stable_since: Option<Instant> = None;
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
            let mut paused_capture: Option<PausedCapture> = None;
            let mut resumed_payload: Option<DetectedKeyPayload> = None;

            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("key-engine runtime");

            while !ENGINE_STOP.load(std::sync::atomic::Ordering::Relaxed) {
                let reset_now = RESET_SEQUENCE.load(std::sync::atomic::Ordering::Relaxed);
                if reset_now != reset_cursor {
                    reset_cursor = reset_now;
                    evidence.reset();
                    cloud_seeded_track = None;
                    paused_capture = None;
                    resumed_payload = None;
                    hard_reset_engine_state(
                        &mut capture,
                        &mut decision_history,
                        &mut likely_streak,
                        &mut last_buffer_bucket,
                        &mut capture_stable_since,
                        &mut session_stable_since,
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
                if ENGINE_STOP.load(std::sync::atomic::Ordering::Relaxed) { break; }
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
                        evidence.reset();
                    cloud_seeded_track = None;
                    paused_capture = None;
                    resumed_payload = None;
                    hard_reset_engine_state(
                            &mut capture,
                            &mut decision_history,
                            &mut likely_streak,
                            &mut last_buffer_bucket,
                            &mut capture_stable_since,
                            &mut session_stable_since,
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
                    evidence.reset();
                    cloud_seeded_track = None;
                    paused_capture = None;
                    resumed_payload = None;
                    hard_reset_engine_state(
                        &mut capture,
                        &mut decision_history,
                        &mut likely_streak,
                        &mut last_buffer_bucket,
                        &mut capture_stable_since,
                        &mut session_stable_since,
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
                    session_stable_since.get_or_insert_with(Instant::now);
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
                    // Keep what was heard only when the track is known, so a resume can be checked
                    // against it; without an identity nothing says the same song is coming back.
                    match current_track_identity.as_ref() {
                        Some(track) => {
                            // Not on the cycle the track changed: the capture state still
                            // belongs to the previous song.
                            if paused_capture.is_none() && !track_changed {
                                if let Some(mode) =
                                    last_capture_mode.filter(|m| *m != CaptureMode::Unavailable)
                                {
                                    paused_capture = Some(PausedCapture {
                                        mode,
                                        target: last_capture_target.clone(),
                                        track: track.clone(),
                                        payload: last_payload.clone(),
                                    });
                                }
                            }
                            capture.pause_capture("playback_paused_or_stopped");
                        }
                        None => capture.stop_capture("playback_paused_or_stopped"),
                    }
                } else if should_run_local_capture(has_session, is_playing, cloud_hit) {
                    capture.ensure_capture_running_for_target(media.source_app.clone());
                    capture.poll_capture_samples();
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
                let transition = if capture_changed {
                    capture_transition(
                        paused_capture.as_ref(),
                        snapshot.capture_mode,
                        snapshot.target_app.as_deref(),
                        current_track_identity.as_deref(),
                        is_paused_or_stopped,
                    )
                } else {
                    CaptureTransition::Changed
                };
                if capture_changed && transition != CaptureTransition::Changed {
                    if transition == CaptureTransition::Resuming {
                        resumed_payload = paused_capture.take().and_then(|p| p.payload);
                    }
                    log::info!(
                        "key_engine: capture {:?}/{:?} -> {:?}/{:?} is a {} of the same track; keeping {} readings over {:.1}s of audio",
                        last_capture_mode,
                        last_capture_target,
                        snapshot.capture_mode,
                        snapshot.target_app,
                        if transition == CaptureTransition::Pausing { "pause" } else { "resume" },
                        evidence.windows.len(),
                        snapshot.buffer_seconds
                    );
                    last_capture_mode = Some(snapshot.capture_mode);
                    last_capture_target = snapshot.target_app.clone();
                } else if capture_changed {
                    paused_capture = None;
                    resumed_payload = None;
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
                    capture_stable_since = snapshot.has_live_capture.then(Instant::now);
                    recent_disruption_until = if has_valid_analysis {
                        Instant::now() + Duration::from_millis(DISRUPTION_COOLDOWN_MS)
                    } else {
                        Instant::now()
                    };
                    evidence.reset();
                    decision_history.clear();
                    likely_streak = 0;
                    primary_key_repeat_streak = 0;
                    last_primary_key_choice = None;
                    contradiction_active = false;
                    contradiction_clean_streak = 0;
                    contradiction_cooldown_until = Instant::now();
                } else if snapshot.has_live_capture {
                    capture_stable_since.get_or_insert_with(Instant::now);
                }

                let (samples, sample_start_ms, aligned_endpoint) = aligned_analysis_samples(
                    capture.latest_samples(60),
                    capture.accepted_samples(),
                    capture.grid_origin(),
                    capture.sample_rate_hz(),
                );
                let mut fresh_analysis = false;
                let mut payload = if !has_session {
                    likely_streak = 0;
                    if media.playback_status == "media_session_unavailable" {
                        DetectedKeyPayload::unavailable("media_session_unavailable")
                    } else {
                        DetectedKeyPayload::unavailable("no_active_session")
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
                        evidence.reset();
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
                            // On entering the hold, not on every loop pass through it.
                            if last_payload.as_ref().map(|p| p.state.as_str()) != Some("paused_hold") {
                                log::info!(
                                    "key_engine: preserving last good detection during pause for grace window ({}ms)",
                                    LAST_GOOD_HOLD_MS
                                );
                            }
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
                } else if samples.len()
                    < first_analysis_seconds(&analyzer_health.backend) * capture.sample_rate_hz() as usize
                {
                    // Avoid blaming the analyzer when we simply don't have a full analysis window yet.
                    likely_streak = 0;
                    apply_capture_degrade(DetectedKeyPayload::warming_up(
                        snapshot.capture_mode,
                        snapshot.target_app.clone().or(media.source_app.clone()),
                        "collecting_audio_for_first_window",
                    ))
                } else if aligned_endpoint <= evidence.last_analyzed_endpoint {
                    // Straight after a resume the last payload is the pause's own; the reading from
                    // before the pause still describes this audio until the next hop is read.
                    resumed_payload
                        .clone()
                        .or_else(|| last_payload.clone())
                        .unwrap_or_else(|| DetectedKeyPayload::warming_up(
                            snapshot.capture_mode, media.source_app.clone(), "waiting_for_fresh_audio"))
                } else {
                    if !analyzer_running {
                        analyzer_running = true;
                        log::info!(
                            "key_engine: analyzer started backend={} track={:?}",
                            analyzer_health.backend,
                            current_track_identity
                        );
                    }
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
                        Ok(mut output) => {
                            fresh_analysis = evidence.accept(&output.windows, sample_start_ms, aligned_endpoint);
                            resumed_payload = None;
                            if fresh_analysis {
                                output.windows = evidence.recent();
                            }
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
                            // The consensus, then the tonic-evidence gate that withdraws a root
                            // the audio never earned. The gate runs on the agreed answer rather
                            // than on a single window, so a chord that happens to carry a leading
                            // tone cannot settle the whole song by itself.
                            let mut payload = decide_from_windows(
                                &output.windows,
                                snapshot.capture_mode,
                                snapshot.target_app.clone().or(media.source_app.clone()),
                                enough_audio,
                                &decision_history,
                                output.chroma.as_deref(),
                            );
                            payload_calibrated = evidence_is_calibrated(&output.windows, &payload);
                            if backend_used == "numpy_fallback" {
                                // Preserve the measured consensus score for Live Jam's
                                // estimate gate. This is evidence, not calibrated accuracy.
                                // Practice auto-apply remains blocked for this backend.
                                payload.ready_to_apply = false;
                                payload.reason = Some(
                                    output
                                        .fallback_reason
                                        .clone()
                                        .map(|r| format!("numpy_fallback:{r}"))
                                        .unwrap_or_else(|| "numpy_fallback:essentia_path_unreliable".to_string()),
                                );
                            }
                            if let (true, Some(k), Some(s)) =
                                (fresh_analysis, payload.primary_key.clone(), payload.primary_scale.clone())
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

                if is_playing && cloud_hit && cloud_seeded_track != current_track_identity {
                    cloud_seeded_track = current_track_identity.clone();
                    evidence.revision = evidence.revision.saturating_add(1);
                    let key = cloud_control.key.clone().unwrap_or_default();
                    let mode = cloud_control.mode.clone().unwrap_or_default().to_ascii_lowercase();
                    let display_name = format!("{key} {mode}");
                    payload = DetectedKeyPayload {
                        primary_key: Some(key),
                        primary_scale: Some(mode),
                        display_name: Some(display_name),
                        confidence: 0.95,
                        note_set_evidence: None,
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
                        evidence_id: None,
                        track_identity: None,
                        ready_to_apply: true,
                    };
                }
                payload.evidence_id = Some(evidence.revision);
                payload.track_identity = current_track_identity.clone();
                if payload.source == "audio_analysis" {
                    let backend_tag = if analyzer_health.healthy {
                        analyzer_health.backend.as_str()
                    } else {
                        "unavailable"
                    };
                    payload.source = format!("audio_analysis:{backend_tag}");
                }
                let mut payload = if payload.source == "cloud_verified" { payload }
                    else { with_switch_hysteresis(payload, last_payload.as_ref()) };
                payload.buffer_seconds = snapshot.buffer_seconds;
                if let (true, Some(k), Some(s)) =
                    (fresh_analysis, payload.primary_key.as_deref(), payload.primary_scale.as_deref())
                {
                    let choice = format!("{k}:{s}");
                    if last_primary_key_choice.as_deref() == Some(choice.as_str()) {
                        primary_key_repeat_streak = primary_key_repeat_streak.saturating_add(1);
                    } else {
                        primary_key_repeat_streak = 1;
                        last_primary_key_choice = Some(choice);
                    }
                } else if payload.primary_key.is_none() {
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
                // Through the same helpers the replay harness uses, so the two cannot drift.
                let relative_pair_unresolved = relative_pair_unresolved_in(&payload);
                let dominant_margin = dominant_margin_of(&payload);
                let capture_stable_s = capture_stable_since.map_or(0.0, |t| t.elapsed().as_secs_f32());
                let session_stable_s = session_stable_since.map_or(0.0, |t| t.elapsed().as_secs_f32());
                let capture_stable = capture_stable_since
                    .is_some_and(|t| t.elapsed() >= stable_window(CAPTURE_STABLE_MIN_CYCLES));
                let session_stable = session_stable_since
                    .is_some_and(|t| t.elapsed() >= stable_window(SESSION_STABLE_MIN_CYCLES));
                let repeated_key = primary_key_repeat_streak >= PRIMARY_KEY_REPEAT_MIN;
                let recent_silence = snapshot.recent_silence;
                let hold_active = last_good_valid_until
                    .map(|t| Instant::now() < t)
                    .unwrap_or(false);
                let mut contradiction_cooldown_block = contradiction_cooldown;
                if recent_silence && payload.source != "cloud_verified" {
                    if hold_active {
                        if let Some(mut held) = last_good_payload.clone() {
                            held.capture_mode = snapshot.capture_mode;
                            held.target_app = snapshot.target_app.clone().or(media.source_app.clone());
                            held.reason = Some("recent_silence_holding_last_good_detection".to_string());
                            held.state = "paused_hold".to_string();
                            payload = held;
                            if last_payload.as_ref().map(|p| p.state.as_str()) != Some("paused_hold") {
                                log::info!(
                                    "key_engine: preserving last good detection during recent silence for grace window ({}ms)",
                                    LAST_GOOD_HOLD_MS
                                );
                            }
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
                if payload.state == "likely_key" && payload.source != "cloud_verified" {
                    let gate = live_gate(
                        &LiveGateInputs {
                            capture_mode: payload.capture_mode,
                            capture_stable,
                            session_stable,
                            repeated_key,
                            recent_disruption,
                            contradiction_active,
                            contradiction_cooldown,
                            recent_silence,
                            relative_pair_unresolved,
                            primary_key_repeat_streak,
                            dominant_margin,
                            window_dominance,
                            window_distinct_tonics,
                            evidence_calibrated: payload_calibrated,
                        },
                        &cm,
                    );
                    let LiveGateVerdict {
                        stable_tonics,
                        margin_ok,
                        recent_windows_clean,
                        endpoint_conservative_ok,
                        contradiction_cooldown_override,
                        ..
                    } = gate;
                    contradiction_cooldown_block = gate.contradiction_cooldown_block;
                    if !gate.allowed {
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
                        // Once per analysis, not once per loop pass: the loop polls several times a
                        // second now, and the verdict only changes when there is new audio.
                        if fresh_analysis {
                            log::info!(
                                "key_engine: likely_key denied backend={} captureMode={:?} reasons captureStableS={:.1} sessionStableS={:.1} key_repeat={} disruption={} contradictionActive={} contradictionCooldown={} contradictionCooldownOverride={} contradictionBurst={} recentSilence={} relativePairDetected={} relativePair={:?} relativePairMargin={:.3} relativePairUnresolved={} endpointConservativeOk={} entropy={:.3} dominantShare={:.3} competingTonics={} distinctTonics={} rapidSwitches={} majorMinorConflict={} familyMixture={} windowDominance={:.3} windowDistinctTonics={} margin={:.3} tonicCounts={:?} recent={:?} windowPredictions={:?} windowTonicVotes={:?}",
                                backend_used,
                                payload.capture_mode,
                                capture_stable_s,
                                session_stable_s,
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
                        }
                    } else {
                        // Once per analysis, not once per loop pass: the loop polls several times a
                        // second now, and the verdict only changes when there is new audio.
                        if fresh_analysis {
                            log::info!(
                                "key_engine: likely_key promoted backend={} captureMode={:?} contradictionCooldown={} contradictionCooldownOverride={} relativePairDetected={} relativePair={:?} relativePairMargin={:.3} captureStableS={:.1} sessionStableS={:.1} key_repeat={} entropy={:.3} dominantShare={:.3} competingTonics={} distinctTonics={} windowDominance={:.3} windowDistinctTonics={} recentSilence={} margin={:.3} tonicCounts={:?} recent={:?} windowPredictions={:?} windowTonicVotes={:?}",
                                backend_used,
                                payload.capture_mode,
                                contradiction_cooldown_block,
                                contradiction_cooldown_override,
                                relative_pair_detected,
                                relative_pair,
                                relative_pair_margin,
                                capture_stable_s,
                                session_stable_s,
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
                }
                if fresh_analysis && payload.state == "likely_key" && !payload.ambiguous {
                    likely_streak = likely_streak.saturating_add(1);
                } else if payload.state != "likely_key" || payload.ambiguous {
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
                if (fresh_analysis || payload.source == "cloud_verified") && payload.state == "likely_key" && is_valid_stable_detection(&payload) {
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

                // Until the next hop is due while there is live audio to analyse, and never longer
                // than the poll period, which is what notices play, pause and a new track.
                let sleep = if is_playing && snapshot.has_live_capture {
                    next_analysis_due_in(
                        capture.accepted_samples(),
                        capture.grid_origin(),
                        evidence.last_analyzed_endpoint,
                        first_analysis_seconds(&analyzer_health.backend),
                        capture.sample_rate_hz(),
                    )
                    .min(Duration::from_millis(LOOP_POLL_MS))
                } else {
                    Duration::from_millis(LOOP_POLL_MS)
                };
                std::thread::park_timeout(sleep);
            }
            capture.stop_capture("engine_shutdown");
        })
        .expect("spawn key-engine thread");
    let _ = ENGINE_THREAD.set(Mutex::new(Some(handle)));
}

pub fn shutdown_key_engine() {
    ENGINE_STOP.store(true, std::sync::atomic::Ordering::Relaxed);
    if let Some(thread) = ENGINE_THREAD.get() {
        if let Ok(mut guard) = thread.lock() {
            if let Some(handle) = guard.take() {
                handle.thread().unpark();
                if !join_engine_before_deadline(handle, Duration::from_secs(20)) {
                    log::warn!(
                        "key_engine: shutdown deadline exceeded; continuing application exit"
                    );
                }
            }
        }
    }
}

fn join_engine_before_deadline(handle: std::thread::JoinHandle<()>, deadline: Duration) -> bool {
    let started = Instant::now();
    while !handle.is_finished() {
        if started.elapsed() >= deadline {
            // A stuck synchronous OS call must not hold the application open.
            // Normal media and analyzer operations have shorter deadlines and
            // reach the orderly capture/sidecar cleanup path above.
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    handle.join().is_ok()
}

#[cfg(test)]
mod tonic_evidence_tests {
    use super::*;

    /// A chroma with the given pitch classes lit. Everything else sits at a small floor, the way
    /// real spectral leakage does, so "has a leading tone" cannot be satisfied by literal silence.
    fn chroma_with(strong: &[i32], strength: f32) -> Vec<f32> {
        let mut chroma = vec![1.0_f32; 12];
        for pc in strong {
            chroma[pc.rem_euclid(12) as usize] = strength;
        }
        chroma
    }

    #[test]
    fn a_raised_seventh_earns_the_tonic() {
        // A minor with a G# in it: that G# only comes from the E major chord of harmonic minor,
        // and it is the one thing C major cannot supply.
        let chroma = chroma_with(&[9, 0, 4, 8], 20.0); // A, C, E, G#
        assert_eq!(tonic_is_supported(&chroma, "A", "minor"), Some(true));
    }

    #[test]
    fn a_natural_minor_loop_does_not_earn_it() {
        // A minor with a G natural and no G#: the same seven notes as C major, with nothing in
        // the audio to say which one is home.
        let chroma = chroma_with(&[9, 0, 4, 7], 20.0); // A, C, E, G
        assert_eq!(tonic_is_supported(&chroma, "A", "minor"), Some(false));
    }

    #[test]
    fn the_cue_is_read_from_the_minor_end_whichever_side_was_named() {
        // The question is about the pair, not about the name the engine happened to use, so
        // C major and A minor must get the same verdict from the same audio.
        let earned = chroma_with(&[9, 0, 4, 8], 20.0);
        assert_eq!(
            tonic_is_supported(&earned, "C", "major"),
            tonic_is_supported(&earned, "A", "minor")
        );
        let unearned = chroma_with(&[9, 0, 4, 7], 20.0);
        assert_eq!(
            tonic_is_supported(&unearned, "C", "major"),
            tonic_is_supported(&unearned, "A", "minor")
        );
    }

    #[test]
    fn nonsense_input_yields_no_verdict_rather_than_a_guess() {
        assert_eq!(tonic_is_supported(&[1.0; 11], "A", "minor"), None);
        assert_eq!(tonic_is_supported(&[0.0; 12], "A", "minor"), None);
        assert_eq!(tonic_is_supported(&[f32::NAN; 12], "A", "minor"), None);
        assert_eq!(tonic_is_supported(&[1.0; 12], "H", "minor"), None);
    }

    #[test]
    fn relative_pairs_resolve_both_directions() {
        assert_eq!(relative_of(0, "major"), (9, "minor")); // C major -> A minor
        assert_eq!(relative_of(9, "minor"), (0, "major")); // A minor -> C major
        assert_eq!(relative_of(2, "major"), (11, "minor")); // D major -> B minor
    }

    /// One libkeyfinder pass over a buffer `span_ms` long, dated the way the detector dates it.
    fn whole_buffer_pass(key: &str, scale: &str, span_ms: u64) -> WindowAnalysisResult {
        whole_buffer_pass_at(key, scale, span_ms, 0.63)
    }

    fn whole_buffer_pass_at(
        key: &str,
        scale: &str,
        span_ms: u64,
        strength: f32,
    ) -> WindowAnalysisResult {
        serde_json::from_value(serde_json::json!({
            "profileType": "libkeyfinder",
            "key": key,
            "scale": scale,
            "displayName": format!("{key} {scale}"),
            "strength": strength,
            "firstToSecondRelativeStrength": 0.25,
            "windowStartMs": 0,
            "windowEndMs": span_ms,
        }))
        .unwrap()
    }

    /// A shorter pass cannot outrank the pass that contains it, however well it correlated.
    ///
    /// Replays the capture in `window_winners_from_results`'s note: twelve seconds of "You've Got
    /// a Friend in Me" fit A♯ major at strength 0.693, and every pass from sixteen seconds on read
    /// E♭ major at 0.60–0.66. Grouping on the start alone and keeping the highest strength meant
    /// the readout showed the dominant — a different note set — from 14 seconds of buffer to 55,
    /// while the analyzer had been right since sixteen.
    #[test]
    fn the_pass_that_heard_more_audio_wins_the_window() {
        let growing = [
            whole_buffer_pass_at("A#", "major", 12_000, 0.693),
            whole_buffer_pass_at("D#", "major", 16_000, 0.601),
            whole_buffer_pass_at("D#", "major", 20_000, 0.622),
            whole_buffer_pass_at("D#", "major", 24_000, 0.628),
        ];
        let winners = window_winners_from_results(&growing);
        assert_eq!(
            winners.len(),
            1,
            "nested spans are one stretch of audio, not four"
        );
        assert_eq!(
            (winners[0].key.as_str(), winners[0].window_end_ms),
            ("D#", 24_000),
            "the reading that heard twenty-four seconds supersedes the one that heard twelve"
        );

        // And the whole way through the consensus, which is what the player reads.
        let payload = decide_from_windows(
            &growing,
            CaptureMode::EndpointLoopback,
            None,
            true,
            &VecDeque::new(),
            None,
        );
        assert_eq!(payload.primary_key.as_deref(), Some("D#"));
    }

    /// The NumPy backend's case, which the grouping exists for: several profiles, one window.
    ///
    /// Same start *and* same end means these really are competing descriptions of one stretch of
    /// audio, and there strength is the right way to choose. Superseding must not reach them.
    #[test]
    fn profiles_scoring_the_same_window_are_still_settled_by_strength() {
        let one_window: Vec<WindowAnalysisResult> =
            [("krumhansl", "A", 0.51), ("temperley", "F#", 0.74)]
                .iter()
                .map(|(profile, key, strength)| {
                    serde_json::from_value(serde_json::json!({
                        "profileType": profile,
                        "key": key,
                        "scale": "minor",
                        "displayName": format!("{key} minor"),
                        "strength": strength,
                        "firstToSecondRelativeStrength": 0.25,
                        "windowStartMs": 8_000,
                        "windowEndMs": 20_000,
                    }))
                    .unwrap()
                })
                .collect();
        let winners = window_winners_from_results(&one_window);
        assert_eq!(winners.len(), 1);
        assert_eq!(
            winners[0].key.as_str(),
            "F#",
            "two profiles over identical spans are a real contest, decided by fit"
        );
    }

    /// A pass over more audio is a new observation, not a second opinion on the same audio.
    ///
    /// `profile_disagreement_ratio` exists for the NumPy backend, which analyses one window with
    /// two independent tone profiles and can genuinely have them disagree. libKeyFinder has one
    /// profile and reports every pass as starting at zero, so keying the grouping on the start
    /// alone collapsed a whole growing buffer into a single "window" — and an engine that changed
    /// its mind between cycles was scored as two profiles contradicting each other at one instant.
    ///
    /// It was the largest single reason the readout never stopped hedging on real music (19% of
    /// 273 clips), and nothing tested it, because every test fed the consensus one cycle at a time.
    #[test]
    fn a_changed_mind_over_time_is_not_two_profiles_disagreeing() {
        // What libkeyfinder produces over a growing buffer: same start, growing end, and at some
        // point a different answer.
        let growing = [
            whole_buffer_pass("A#", "major", 20_000),
            whole_buffer_pass("A#", "major", 24_000),
            whole_buffer_pass("D#", "major", 28_000),
            whole_buffer_pass("D#", "major", 32_000),
        ];
        let metrics = window_disagreement_metrics(&growing);
        assert_eq!(
            metrics.profile_disagreement_ratio, 0.0,
            "four passes over four different amounts of audio are four observations"
        );

        // What the NumPy backend produces, and what the metric is actually for: one window, two
        // profiles, two answers. That must still read as disagreement.
        let two_profiles: Vec<WindowAnalysisResult> = ["krumhansl", "temperley"]
            .iter()
            .zip(["A#", "D#"])
            .map(|(profile, key)| {
                serde_json::from_value(serde_json::json!({
                    "profileType": profile,
                    "key": key,
                    "scale": "major",
                    "displayName": format!("{key} major"),
                    "strength": 0.63,
                    "firstToSecondRelativeStrength": 0.25,
                    "windowStartMs": 0,
                    "windowEndMs": 12_000,
                }))
                .unwrap()
            })
            .collect();
        assert_eq!(
            window_disagreement_metrics(&two_profiles).profile_disagreement_ratio,
            1.0,
            "one window, two profiles, two tonics — the case the metric was written for"
        );
    }

    #[test]
    fn a_pass_over_more_audio_is_new_evidence() {
        let mut evidence = AnalysisEvidence::default();
        assert!(evidence.accept(&[whole_buffer_pass("A", "minor", 12_000)], 0, 12));
        assert!(
            evidence.accept(&[whole_buffer_pass("A", "minor", 16_000)], 0, 16),
            "four seconds of audio the analyzer had not heard before is a new observation"
        );
    }

    #[test]
    fn the_same_span_judged_twice_is_not_a_second_opinion() {
        let mut evidence = AnalysisEvidence::default();
        assert!(evidence.accept(&[whole_buffer_pass("A", "minor", 12_000)], 0, 12));
        assert!(
            !evidence.accept(&[whole_buffer_pass("A", "minor", 12_000)], 0, 12),
            "re-running the analyzer on audio already counted must not corroborate itself"
        );
    }

    /// Replays what a capture does in its first half-minute: the same answer, re-derived from a
    /// buffer that keeps growing. Returns the last reading and how many of the eight cycles
    /// brought evidence the engine had not already counted.
    ///
    /// That count is the whole story of the streak. `likely_streak` only advances on a cycle that
    /// was both fresh and settled, so a run of confident readings built from audio already judged
    /// moves the player no closer to an answer.
    fn replay_a_growing_buffer(span_of: impl Fn(u64) -> u64) -> (DetectedKeyPayload, usize) {
        let mut evidence = AnalysisEvidence::default();
        let mut history: VecDeque<String> = VecDeque::new();
        let mut fresh_cycles = 0usize;
        let mut latest = None;
        for heard_ms in (12_000u64..=44_000).step_by(4_000) {
            let fresh = evidence.accept(
                &[whole_buffer_pass("A", "minor", span_of(heard_ms))],
                0,
                heard_ms / 1000,
            );
            let payload = decide_from_windows(
                &evidence.recent(),
                CaptureMode::ProcessLoopback,
                None,
                true,
                &history,
                None,
            );
            if fresh {
                fresh_cycles += 1;
                if let (Some(key), Some(scale)) = (&payload.primary_key, &payload.primary_scale) {
                    history.push_back(format!("{key}:{scale}"));
                }
            }
            latest = Some(payload);
        }
        (
            latest.expect("the replay ran at least one cycle"),
            fresh_cycles,
        )
    }

    #[test]
    fn a_verdict_that_holds_as_the_buffer_grows_can_reach_the_streak() {
        let (settled, fresh_cycles) = replay_a_growing_buffer(|heard_ms| heard_ms);
        assert!(!settled.ambiguous, "a held reading is settled: {settled:?}");
        assert_eq!(settled.state, "likely_key");
        assert!(
            fresh_cycles >= MIN_READY_STREAK,
            "thirty-two seconds of new audio has to be worth at least {MIN_READY_STREAK} \
             observations, or no song can ever satisfy the streak; got {fresh_cycles}"
        );
    }

    #[test]
    fn a_pass_that_misreports_its_span_never_advances_the_streak() {
        // What the libkeyfinder detector used to do: claim twelve seconds however much audio it
        // was handed. The reading still looks confident — and that is the trap, because every
        // pass after the first is audio already counted, so the streak the readout waits on
        // stalls at one until the buffer is long enough to start sliding.
        let (reading, fresh_cycles) = replay_a_growing_buffer(|_| 12_000);
        assert!(!reading.ambiguous, "the reading itself still looks settled");
        assert_eq!(
            fresh_cycles, 1,
            "a detector that re-dates every pass as the same window has corroborated nothing"
        );
    }

    /// Every window agreeing on one end of a relative pair, which is what a long listen produces.
    fn consolidated_relative_pair(gap: Option<f32>) -> Vec<WindowAnalysisResult> {
        (0..8)
            .map(|i| WindowAnalysisResult {
                profile_type: "libkeyfinder".to_string(),
                key: "G".to_string(),
                scale: "major".to_string(),
                display_name: "G major".to_string(),
                strength: 0.95,
                first_to_second_relative_strength: Some(0.25),
                candidates: None,
                relative_pair_gap: gap,
                tuning_cents: None,
                note_set_margin: None,
                top_score: None,
                window_start_ms: i * 4_000,
                window_end_ms: i * 4_000 + 12_000,
            })
            .collect()
    }

    /// The defect a field recording of "Dimyon Hofshi" (E minor) exposed: the readout hedged the
    /// pair while the windows disagreed, then locked G major at 100% once they all agreed. Vote
    /// agreement is the one thing that cannot settle a relative pair — both names are the same
    /// seven notes — so consolidation must not be mistaken for evidence about the root.
    #[test]
    fn a_consolidated_vote_does_not_settle_a_relative_pair() {
        let history = VecDeque::from(vec!["G:major".to_string(); 8]);
        let out = aggregate_results(
            &consolidated_relative_pair(Some(RELATIVE_PAIR_COIN_FLIP_GAP / 2.0)),
            CaptureMode::EndpointLoopback,
            None,
            true,
            &history,
        );
        assert!(
            out.ambiguous,
            "eight windows agreeing on G major says nothing about G vs E minor"
        );
        let reason = out.reason.unwrap();
        assert!(reason.contains("relative_pair_ambiguity"), "{reason}");
        // The notes are still drawn at full strength; only the root steps back.
        assert_eq!(out.primary_key.as_deref(), Some("G"));
        assert!(
            reason.contains("E minor"),
            "the other reading must be named: {reason}"
        );

        // The part that has to be in `alternatives` and not only in `reason`. A consolidated vote
        // has one entry, so without this the list is empty, `keyFusion.ts::relativeHedge` finds no
        // relative, and the readout falls back to "unsure" — downgrading a correct diagram and
        // leaving nothing for the neck to anchor to. Shipped once without it; the log of a real
        // run said `engine_ambiguous_but_shown` where it should have said `tonic_open`.
        let offered = out
            .alternatives
            .first()
            .expect("the other name must be offered");
        assert_eq!(
            (offered.key.as_str(), offered.scale.as_str()),
            ("E", "minor"),
            "the relative belongs at the head of the alternatives"
        );
    }

    /// The other half, and the reason the threshold is a measured number rather than "always
    /// hedge a relative pair": above the coin-flip gap the analyzer's leader is right 83% of the
    /// time and withdrawing it would be a worse readout, not a humbler one.
    #[test]
    fn a_separable_relative_pair_is_still_asserted() {
        let history = VecDeque::from(vec!["G:major".to_string(); 8]);
        let out = aggregate_results(
            &consolidated_relative_pair(Some(0.006)),
            CaptureMode::EndpointLoopback,
            None,
            true,
            &history,
        );
        assert!(
            !out.ambiguous,
            "a separated pair is a verdict: {:?}",
            out.reason
        );
        assert_eq!(out.state, "likely_key");
    }

    /// An older CLI sends no shortlist and therefore no gap. That must leave the vote-based test
    /// exactly as it was rather than hedging everything or nothing.
    #[test]
    fn no_shortlist_falls_back_to_the_vote() {
        let history = VecDeque::from(vec!["G:major".to_string(); 8]);
        let out = aggregate_results(
            &consolidated_relative_pair(None),
            CaptureMode::EndpointLoopback,
            None,
            true,
            &history,
        );
        assert!(
            !out.ambiguous,
            "unchanged legacy behaviour: {:?}",
            out.reason
        );
    }

    fn payload(key: &str, scale: &str) -> DetectedKeyPayload {
        let mut p = DetectedKeyPayload::unavailable("test");
        p.primary_key = Some(key.to_string());
        p.primary_scale = Some(scale.to_string());
        p.display_name = Some(format!("{key} {scale}"));
        p.confidence = 0.9;
        p.ambiguous = false;
        p.state = "likely_key".to_string();
        p.ready_to_apply = true;
        p
    }

    #[test]
    fn an_unearned_tonic_is_withdrawn_and_the_relative_is_offered() {
        let chroma = chroma_with(&[9, 0, 4, 7], 20.0); // natural minor: no leading tone
        let out = apply_tonic_evidence(payload("C", "major"), Some(&chroma));
        assert!(out.ambiguous, "an unearned root must not be asserted");
        assert_eq!(out.state, "ambiguous");
        // The notes stay exactly where they were: they are right either way.
        assert_eq!(out.primary_key.as_deref(), Some("C"));
        assert_eq!(out.primary_scale.as_deref(), Some("major"));
        // ...and the other reading is named, so the player never has to work it out.
        let first = out.alternatives.first().expect("relative offered");
        assert_eq!((first.key.as_str(), first.scale.as_str()), ("A", "minor"));
        assert!(out.reason.unwrap().contains("relative_pair_ambiguity"));
    }

    #[test]
    fn an_earned_tonic_is_left_alone() {
        let chroma = chroma_with(&[9, 0, 4, 8], 20.0); // leading tone present
        let out = apply_tonic_evidence(payload("A", "minor"), Some(&chroma));
        assert!(!out.ambiguous);
        assert!(out.alternatives.is_empty());
    }

    #[test]
    fn a_backend_without_a_chroma_changes_nothing() {
        // The python sidecar reports candidates instead of a chroma; it must pass through
        // untouched rather than have its tonic silently withdrawn.
        let before = payload("A", "minor");
        let after = apply_tonic_evidence(before.clone(), None);
        assert_eq!(before, after);
    }

    #[test]
    fn the_relative_is_not_listed_twice() {
        let chroma = chroma_with(&[9, 0, 4, 7], 20.0);
        let mut p = payload("C", "major");
        p.alternatives.push(KeyCandidate {
            key: "A".to_string(),
            scale: "minor".to_string(),
            display_name: "A minor".to_string(),
            confidence: 0.4,
        });
        let out = apply_tonic_evidence(p, Some(&chroma));
        let relatives = out
            .alternatives
            .iter()
            .filter(|c| c.key == "A" && c.scale == "minor")
            .count();
        assert_eq!(relatives, 1);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn actual_relative_modulation_reaches_final_gate_in_both_capture_modes() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/generic_candidate_windows.json"
        ))
        .unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        for reverse in [false, true] {
            let (old, new) = if reverse {
                (("A", "minor"), ("C", "major"))
            } else {
                (("C", "major"), ("A", "minor"))
            };
            for mode in [CaptureMode::ProcessLoopback, CaptureMode::EndpointLoopback] {
                let mut evidence = super::AnalysisEvidence::default();
                let mut history = VecDeque::new();
                let mut previous = None;
                let mut previous_choice = String::new();
                let mut repeats = 0;
                let mut likely = 0;
                let mut cooldown_until = 0;
                for step in 0..60 {
                    let expected = if step < 20 { old } else { new };
                    let case = cases
                        .iter()
                        .find(|c| {
                            c["key"].as_str() == Some(expected.0)
                                && c["scale"].as_str() == Some(expected.1)
                        })
                        .unwrap();
                    let windows: Vec<crate::audio_models::WindowAnalysisResult> =
                        serde_json::from_value(case["windows"].clone()).unwrap();
                    assert!(evidence.accept(&windows, step * 4000, step * 4000 + 12000));
                    let mut result =
                        aggregate_results(&evidence.windows, mode, None, true, &history);
                    let choice = format!(
                        "{}:{}",
                        result.primary_key.as_deref().unwrap(),
                        result.primary_scale.as_deref().unwrap()
                    );
                    if history.len() == super::HISTORY_HORIZON {
                        history.pop_front();
                    }
                    history.push_back(choice.clone());
                    repeats = if choice == previous_choice {
                        repeats + 1
                    } else {
                        1
                    };
                    previous_choice = choice;
                    let metrics = contradiction_metrics_from_history(&history);
                    let contradiction = metrics.contradiction_burst;
                    if contradiction {
                        cooldown_until = step + 4;
                    }
                    result = with_switch_hysteresis(result, previous.as_ref());
                    likely = if !result.ambiguous
                        && repeats >= super::PRIMARY_KEY_REPEAT_MIN
                        && !contradiction
                        && step >= cooldown_until
                    {
                        likely + 1
                    } else {
                        0
                    };
                    result.source = "audio_analysis:numpy_fallback".into();
                    result = apply_ready_streak_gate(
                        result,
                        likely,
                        "numpy_fallback",
                        metrics.tonic_entropy,
                        metrics.dominant_share,
                    );
                    let winners = super::window_winners_from_results(&evidence.windows);
                    let mut tonics = std::collections::BTreeMap::new();
                    for winner in super::recent_window_horizon(
                        &winners,
                        super::AGGREGATION_RECENT_WINDOW_COUNT,
                    ) {
                        *tonics.entry(winner.key).or_insert(0usize) += 1;
                    }
                    let (dominance, distinct) = super::window_vote_quality(&tonics);
                    result = enforce_apply_gate(
                        result,
                        "numpy_fallback",
                        true,
                        true,
                        repeats >= super::PRIMARY_KEY_REPEAT_MIN,
                        contradiction,
                        step < cooldown_until,
                        false,
                        dominance,
                        distinct,
                        &metrics,
                        likely,
                    );
                    if step == 19 || step == 59 {
                        assert_eq!(result.primary_key.as_deref(), Some(expected.0));
                        assert_eq!(result.primary_scale.as_deref(), Some(expected.1));
                        assert_eq!(
                            result.reason.as_deref(),
                            Some("stable_numpy_estimate"),
                            "{expected:?} {mode:?} step{step}: {result:?}"
                        );
                    }
                    previous = Some(result);
                }
            }
        }
    }
    #[test]
    fn track_identity_normalizes_unicode_like_frontend() {
        assert_eq!(
            super::normalize_track_field(Some("  BJÖRK  DEJA  VU ")),
            "björk deja vu"
        );
    }

    #[test]
    fn endpoint_confidence_is_measured_evidence_with_an_explicit_stricter_gate() {
        for (confidence, eligible) in [(0.92, true), (0.87, false), (0.55, false)] {
            let mut result = crate::audio_models::DetectedKeyPayload::unavailable("test");
            result.primary_key = Some("D".into());
            result.primary_scale = Some("major".into());
            result.state = "likely_key".into();
            result.source = "audio_analysis:numpy_fallback".into();
            result.confidence = confidence;
            result.stability = 0.95;
            result.ambiguous = false;
            result.enough_audio = true;
            result.capture_mode = CaptureMode::EndpointLoopback;
            result = super::apply_capture_degrade(result);
            assert_eq!(result.confidence, confidence);
            result = enforce_apply_gate(
                result,
                "numpy_fallback",
                true,
                true,
                true,
                false,
                false,
                false,
                0.95,
                1,
                &stable_cm(),
                8,
            );
            assert_eq!(
                result.reason.as_deref() == Some("stable_numpy_estimate"),
                eligible
            );
            assert!(!result.ready_to_apply);
        }
    }
    #[test]
    fn actual_python_candidates_can_reach_live_estimate_gate_for_all_keys() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/generic_candidate_windows.json"
        ))
        .unwrap();
        let mut endpoint_eligible = 0;
        for case in fixture["cases"].as_array().unwrap() {
            let key = case["key"].as_str().unwrap();
            let scale = case["scale"].as_str().unwrap();
            let template: Vec<crate::audio_models::WindowAnalysisResult> =
                serde_json::from_value(case["windows"].clone()).unwrap();
            assert!(template
                .iter()
                .all(|w| w.candidates.as_ref().unwrap().len() == 24));
            for mode in [CaptureMode::ProcessLoopback, CaptureMode::EndpointLoopback] {
                let mut evidence = super::AnalysisEvidence::default();
                let mut history = VecDeque::new();
                let mut result = crate::audio_models::DetectedKeyPayload::unavailable("test");
                for step in 0..20 {
                    assert!(evidence.accept(&template, step * 4000, step * 4000 + 12000));
                    result = aggregate_results(&evidence.windows, mode, None, true, &history);
                    if history.len() == super::HISTORY_HORIZON {
                        history.pop_front();
                    }
                    history.push_back(format!(
                        "{}:{}",
                        result.primary_key.as_deref().unwrap(),
                        result.primary_scale.as_deref().unwrap()
                    ));
                }
                let metrics = contradiction_metrics_from_history(&history);
                result.source = "audio_analysis:numpy_fallback".into();
                result = apply_ready_streak_gate(
                    result,
                    8,
                    "numpy_fallback",
                    metrics.tonic_entropy,
                    metrics.dominant_share,
                );
                result = enforce_apply_gate(
                    result,
                    "numpy_fallback",
                    true,
                    true,
                    true,
                    false,
                    false,
                    false,
                    1.0,
                    1,
                    &metrics,
                    8,
                );
                assert_eq!(result.primary_key.as_deref(), Some(key));
                assert_eq!(result.primary_scale.as_deref(), Some(scale));
                assert!(
                    !result.ambiguous,
                    "{key} {scale} {mode:?}: {:?} {} {}",
                    result.reason, result.confidence, result.stability
                );
                assert_eq!(
                    result.reason.as_deref(),
                    Some("stable_numpy_estimate"),
                    "{key} {scale} {mode:?}: {result:?}"
                );
                if mode == CaptureMode::EndpointLoopback {
                    endpoint_eligible += 1;
                }
                assert!(
                    !result.ready_to_apply,
                    "numpy must remain suggestion-only for Practice"
                );
            }
        }
        assert_eq!(endpoint_eligible, 24);
        eprintln!("actual DSP native gate: 24/24 process keys eligible, 24/24 endpoint keys eligible under stricter endpoint gates");
    }
    #[test]
    fn weak_absolute_fit_cannot_become_certain_from_candidate_separation() {
        for scale in ["major", "minor"] {
            let windows: Vec<_> = (0..9)
                .map(|i| scored_window("D", scale, "A", scale, 0.55, 0.25, i * 4000))
                .collect();
            let result = aggregate_results(
                &windows,
                CaptureMode::ProcessLoopback,
                None,
                true,
                &VecDeque::from(vec![format!("D:{scale}"); 16]),
            );
            assert!(result.ambiguous);
            assert!(result.confidence < 0.7);
            assert!(!result.ready_to_apply);
        }
    }
    #[test]
    fn evidence_deduplicates_rescans_and_accepts_fresh_absolute_endpoints() {
        let mut evidence = super::AnalysisEvidence::default();
        let windows = vec![scored_window("D", "major", "B", "minor", 0.94, 0.64, 0)];
        assert!(evidence.accept(&windows, 48_000, 60_000));
        let revision = evidence.revision;
        let before = aggregate_results(
            &evidence.windows,
            CaptureMode::ProcessLoopback,
            None,
            true,
            &VecDeque::new(),
        );
        for _ in 0..10 {
            assert!(!evidence.accept(&windows, 48_000, 60_000));
        }
        assert_eq!(evidence.revision, revision);
        assert_eq!(evidence.windows.len(), 1);
        let after = aggregate_results(
            &evidence.windows,
            CaptureMode::ProcessLoopback,
            None,
            true,
            &VecDeque::new(),
        );
        assert_eq!(before.confidence, after.confidence);
        assert_eq!(before.stability, after.stability);
        // Identical relative offsets refer to NEW audio after the rolling buffer fills.
        assert!(evidence.accept(&windows, 52_000, 64_000));
        assert_eq!(evidence.revision, revision + 1);
        assert_eq!(evidence.windows.len(), 2);
        evidence.reset();
        assert_eq!(evidence.revision, revision + 1);
        assert!(evidence.accept(&windows, 64_000, 76_000));
        assert_eq!(evidence.revision, revision + 2);
    }

    #[test]
    fn capture_endpoint_advances_after_ring_fills_and_across_reset() {
        let mut capture = crate::audio_capture::AudioCaptureManager::new();
        let rate = capture.sample_rate_hz();
        capture.ingest_mono_samples(rate, &vec![0.2; rate as usize * 64]);
        let seconds = capture.available_buffer_seconds();
        let endpoint = capture.accepted_samples();
        capture.ingest_mono_samples(rate, &vec![0.2; rate as usize * 4]);
        assert_eq!(capture.available_buffer_seconds(), seconds);
        assert_eq!(capture.accepted_samples(), endpoint + rate as u64 * 4);
        let (samples, start, end) = super::aligned_analysis_samples(
            capture.latest_samples(60),
            capture.accepted_samples(),
            capture.grid_origin(),
            rate,
        );
        assert_eq!(end, 68 * rate as u64);
        // The whole of what the ring holds, not a 44-second slice of it: `ROLLING_BUFFER_SECONDS`
        // and `MAX_ANALYSIS_SPAN_SECONDS` are both 60, so nothing captured is discarded.
        assert_eq!(start, 8_000);
        assert_eq!(samples.len(), 60 * rate as usize);
        capture.reset();
        capture.ingest_mono_samples(rate, &vec![0.2; rate as usize * 12]);
        assert_eq!(capture.accepted_samples(), 80 * rate as u64);
    }

    #[test]
    fn partial_hops_do_not_create_new_analysis_endpoints() {
        // Eighty seconds held, so the span cap is what decides the window rather than how much
        // audio happens to exist. The point is that a partial hop at the end moves neither
        // endpoint: a re-scan of the same audio must not read as new evidence.
        for seconds in [80, 81, 82, 83] {
            let (_, start, end) =
                super::aligned_analysis_samples(vec![0.2; 80 * 100], seconds * 100, 0, 100);
            assert_eq!(end, 8000);
            assert_eq!(start, 20000);
        }
    }

    #[test]
    fn a_song_that_starts_off_the_lifetime_grid_is_analysed_at_twelve_seconds() {
        // 66 seconds of one song, then a track change: the ring is cleared at a lifetime count
        // that is not a multiple of the hop. Twelve seconds into the new song the analyzer must
        // be handed exactly those twelve seconds. Aligned to the lifetime count instead, the
        // endpoint fell back to 76s — ten seconds of this song, under the first window — and the
        // first reading waited for 80s, four seconds late.
        let mut capture = crate::audio_capture::AudioCaptureManager::new();
        let rate = capture.sample_rate_hz();
        capture.ingest_mono_samples(rate, &vec![0.2; rate as usize * 66]);
        capture.reset();
        assert_eq!(capture.grid_origin(), 66 * rate as u64);
        capture.ingest_mono_samples(rate, &vec![0.2; rate as usize * 12]);
        let (samples, _, end) = super::aligned_analysis_samples(
            capture.latest_samples(60),
            capture.accepted_samples(),
            capture.grid_origin(),
            rate,
        );
        assert_eq!(end, 78 * rate as u64);
        assert_eq!(samples.len(), 12 * rate as usize);
        // One hop later the next endpoint is due, on the song's own grid.
        capture.ingest_mono_samples(rate, &vec![0.2; rate as usize * 4]);
        let (samples, _, end) = super::aligned_analysis_samples(
            capture.latest_samples(60),
            capture.accepted_samples(),
            capture.grid_origin(),
            rate,
        );
        assert_eq!(end, 82 * rate as u64);
        assert_eq!(samples.len(), 16 * rate as usize);
    }

    #[test]
    fn the_loop_sleeps_until_the_next_hop_is_due() {
        let rate = 100u32;
        let slack = std::time::Duration::from_millis(super::CAPTURE_PACKET_SLACK_MS);
        // Nothing analysed yet, ring started at 5s, 9s of it held: the first window is 3s away.
        assert_eq!(
            super::next_analysis_due_in(1400, 500, 0, 12, rate),
            std::time::Duration::from_secs(3) + slack
        );
        // Last analysed at 17s on that grid: the next hop completes at 21s.
        assert_eq!(
            super::next_analysis_due_in(1850, 500, 1700, 12, rate),
            std::time::Duration::from_millis(2500) + slack
        );
        // Already due: wake only for the packet slack.
        assert_eq!(
            super::next_analysis_due_in(2200, 500, 1700, 12, rate),
            slack
        );
    }

    #[test]
    fn stability_requirements_keep_their_nine_seconds_at_any_poll_rate() {
        assert_eq!(
            super::stable_window(super::CAPTURE_STABLE_MIN_CYCLES),
            std::time::Duration::from_secs(9)
        );
        assert_eq!(
            super::stable_window(super::SESSION_STABLE_MIN_CYCLES),
            std::time::Duration::from_secs(9)
        );
    }

    #[test]
    fn cloud_hit_keeps_local_capture_enabled_while_playing() {
        for cloud_hit in [false, true] {
            assert!(super::should_run_local_capture(true, true, cloud_hit));
            assert!(!super::should_run_local_capture(true, false, cloud_hit));
            assert!(!super::should_run_local_capture(false, true, cloud_hit));
        }
    }

    #[test]
    fn accumulating_candidates_follow_sustained_modulation_in_both_modes() {
        let roots = [
            "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
        ];
        for (index, key) in roots.iter().enumerate() {
            for scale in ["major", "minor"] {
                let next_key = roots[(index + 2) % 12];
                let mut evidence = super::AnalysisEvidence::default();
                let mut history = VecDeque::new();
                let mut result = crate::audio_models::DetectedKeyPayload::unavailable("test");
                for step in 0..40 {
                    let tonic = if step < 16 { *key } else { next_key };
                    let runner = if step < 16 { next_key } else { *key };
                    let window =
                        scored_window(tonic, scale, runner, scale, 0.94, 0.63, step * 4000);
                    assert!(evidence.accept(&[window], 0, step * 4000 + 12000));
                    result = aggregate_results(
                        &evidence.windows,
                        CaptureMode::ProcessLoopback,
                        None,
                        true,
                        &history,
                    );
                    if history.len() == super::HISTORY_HORIZON {
                        history.pop_front();
                    }
                    history.push_back(format!(
                        "{}:{}",
                        result.primary_key.as_deref().unwrap(),
                        scale
                    ));
                    if step == 15 {
                        assert_eq!(result.primary_key.as_deref(), Some(*key));
                        assert!(!result.ambiguous);
                    }
                }
                assert_eq!(result.primary_key.as_deref(), Some(next_key));
                assert!(!result.ambiguous, "{next_key} {scale}: {:?}", result.reason);
                assert!(result.confidence >= super::MIN_CONFIDENCE_READY);
            }
        }
    }
    fn scored_window(
        key: &str,
        scale: &str,
        runner: &str,
        runner_scale: &str,
        top: f32,
        second: f32,
        start: u64,
    ) -> crate::audio_models::WindowAnalysisResult {
        serde_json::from_value(serde_json::json!({"profileType":"test", "key":key,"scale":scale,
            "displayName":format!("{key} {scale}"),"strength":top,"firstToSecondRelativeStrength":(top-second)/top,
            "windowStartMs":start,"windowEndMs":start+12000,
            "candidates":[{"key":key,"scale":scale,"score":top},{"key":runner,"scale":runner_scale,"score":second}]})).unwrap()
    }

    #[test]
    fn close_candidates_remain_ambiguous_for_every_root_and_mode() {
        for key in [
            "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
        ] {
            for (scale, runner_scale) in [("major", "minor"), ("minor", "major")] {
                let windows: Vec<_> = (0..9)
                    .map(|i| scored_window(key, scale, key, runner_scale, 0.9, 0.89, i * 4000))
                    .collect();
                let history = VecDeque::from(vec![format!("{key}:{scale}"); 8]);
                let payload =
                    aggregate_results(&windows, CaptureMode::ProcessLoopback, None, true, &history);
                assert!(payload.ambiguous, "close candidates {key} {scale}");
                assert!(payload.confidence < 0.7);
            }
        }
    }

    #[test]
    fn relative_pair_ranking_is_symmetric_when_modes_exchange() {
        let evaluate = |early_key: &str, early_scale: &str, late_key: &str, late_scale: &str| {
            let windows: Vec<_> = (0..7).map(|i| {
                let (key,scale,strength) = if i < 2 {(early_key,early_scale,0.63)} else {(late_key,late_scale,0.72)};
                serde_json::from_value(serde_json::json!({"profileType":"test","key":key,"scale":scale,"displayName":format!("{key} {scale}"),"strength":strength,"firstToSecondRelativeStrength":0.22,"windowStartMs":i*4000,"windowEndMs":i*4000+12000})).unwrap()
            }).collect();
            aggregate_results(
                &windows,
                CaptureMode::ProcessLoopback,
                None,
                true,
                &VecDeque::from(vec![format!("{late_key}:{late_scale}"); 8]),
            )
        };
        let major = evaluate("A", "minor", "C", "major");
        let minor = evaluate("C", "major", "A", "minor");
        assert_eq!(major.primary_scale.as_deref(), Some("major"));
        assert_eq!(minor.primary_scale.as_deref(), Some("minor"));
        assert!((major.confidence - minor.confidence).abs() < 0.0001);
        assert_eq!(major.ambiguous, minor.ambiguous);
    }

    #[test]
    fn sustained_modulation_can_replace_a_high_confidence_previous_key() {
        let mut last = crate::audio_models::DetectedKeyPayload::unavailable("test");
        last.primary_key = Some("C".into());
        last.primary_scale = Some("major".into());
        last.confidence = 0.99;
        last.ambiguous = false;
        let mut next = last.clone();
        next.primary_key = Some("D".into());
        next.confidence = 0.98;
        next.stability = 0.98;
        next.window_count = 9;
        next.enough_audio = true;
        assert!(!with_switch_hysteresis(next, Some(&last)).ambiguous);
    }
    use super::{
        aggregate_results, analyzer_executable_candidates, analyzer_file_candidates,
        analyzer_search_roots, apply_ready_streak_gate, contradiction_metrics_from_history,
        enforce_apply_gate, libkeyfinder_cli_candidates, track_identity, with_switch_hysteresis,
        ContradictionMetrics,
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
                candidates: None,
                relative_pair_gap: None,
                tuning_cents: None,
                note_set_margin: None,
                top_score: None,
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
                candidates: None,
                relative_pair_gap: None,
                tuning_cents: None,
                note_set_margin: None,
                top_score: None,
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
                candidates: None,
                relative_pair_gap: None,
                tuning_cents: None,
                note_set_margin: None,
                top_score: None,
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
                candidates: None,
                relative_pair_gap: None,
                tuning_cents: None,
                note_set_margin: None,
                top_score: None,
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
                candidates: None,
                relative_pair_gap: None,
                tuning_cents: None,
                note_set_margin: None,
                top_score: None,
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
                candidates: None,
                relative_pair_gap: None,
                tuning_cents: None,
                note_set_margin: None,
                top_score: None,
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
                    candidates: None,
                    relative_pair_gap: None,
                    tuning_cents: None,
                    note_set_margin: None,
                    top_score: None,
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
    fn relative_pair_transition_remains_ambiguous_until_history_settles() {
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
                    candidates: None,
                    relative_pair_gap: None,
                    tuning_cents: None,
                    note_set_margin: None,
                    top_score: None,
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
                    candidates: None,
                    relative_pair_gap: None,
                    tuning_cents: None,
                    note_set_margin: None,
                    top_score: None,
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
        assert_eq!(payload.primary_scale.as_deref(), Some("major"));
        assert!(payload.ambiguous);
        assert!(!payload.ready_to_apply);
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
            track_url: None,
            artwork_url: None,
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
            track_url: None,
            artwork_url: None,
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
            note_set_evidence: None,
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
            evidence_id: None,
            track_identity: None,
            ready_to_apply: true,
        };
        let next = crate::audio_models::DetectedKeyPayload {
            primary_key: Some("C".to_string()),
            primary_scale: Some("major".to_string()),
            display_name: Some("C major".to_string()),
            confidence: 0.80,
            note_set_evidence: None,
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
            evidence_id: None,
            track_identity: None,
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
            note_set_evidence: None,
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
            evidence_id: None,
            track_identity: None,
            ready_to_apply: true,
        };
        let first = apply_ready_streak_gate(payload.clone(), 1, "essentia", 0.0, 1.0);
        assert!(!first.ready_to_apply);
        assert!(first
            .reason
            .as_deref()
            .unwrap_or_default()
            .starts_with("waiting_for_stability_confirmation"));
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
            note_set_evidence: None,
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
            evidence_id: None,
            track_identity: None,
            ready_to_apply: true,
        };
        let mut cm = stable_cm();
        cm.contradiction_burst = true;
        cm.competing_tonics = 3;
        let gated = enforce_apply_gate(
            payload, "essentia", true, true, true, true, true, false, 0.9, 1, &cm, 8,
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
            note_set_evidence: None,
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
            evidence_id: None,
            track_identity: None,
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
        assert_eq!(gated.reason.as_deref(), Some("stable_numpy_estimate"));
    }

    #[test]
    fn apply_gate_accepts_verified_cloud_without_local_capture() {
        let mut payload = crate::audio_models::DetectedKeyPayload::unavailable("test");
        payload.primary_key = Some("Bb".into());
        payload.primary_scale = Some("major".into());
        payload.source = "cloud_verified".into();
        payload.state = "likely_key".into();
        payload.ambiguous = false;
        payload.ready_to_apply = true;
        let gated = enforce_apply_gate(
            payload,
            "unavailable",
            false,
            false,
            false,
            false,
            false,
            true,
            0.0,
            0,
            &stable_cm(),
            0,
        );
        assert!(gated.ready_to_apply);
        assert_eq!(gated.primary_key.as_deref(), Some("Bb"));
    }

    #[test]
    fn live_numpy_estimates_keep_all_evidence_safeguards() {
        let mut payload = crate::audio_models::DetectedKeyPayload::unavailable("test");
        payload.primary_key = Some("D".into());
        payload.primary_scale = Some("major".into());
        payload.source = "audio_analysis:numpy_fallback".into();
        payload.state = "likely_key".into();
        payload.capture_mode = CaptureMode::ProcessLoopback;
        payload.confidence = 0.95;
        payload.stability = 0.95;
        payload.enough_audio = true;
        payload.ambiguous = false;
        // Each case changes one piece of otherwise stable evidence.
        for case in 0..9 {
            let mut next = payload.clone();
            if case == 0 {
                next.ambiguous = true;
            }
            if case == 1 {
                next.enough_audio = false;
            }
            if case == 2 {
                next.confidence = 0.7;
            }
            if case == 3 {
                next.state = "paused_hold".into();
            }
            let gated = enforce_apply_gate(
                next,
                "numpy_fallback",
                case != 4,
                true,
                true,
                case == 5,
                case == 6,
                case == 7,
                0.95,
                1,
                &stable_cm(),
                if case == 8 { 0 } else { 8 },
            );
            assert_ne!(
                gated.reason.as_deref(),
                Some("stable_numpy_estimate"),
                "case {case}"
            );
            assert!(!gated.ready_to_apply);
        }
    }

    #[test]
    fn cloud_hit_requires_valid_key_and_major_or_minor() {
        let control = super::CloudResolutionControl {
            track_identity: Some("track".into()),
            state: "hit".into(),
            key: Some("Bb".into()),
            mode: Some("dorian".into()),
            error: None,
        };
        assert!(!super::set_cloud_resolution(control));
    }

    #[test]
    fn final_apply_gate_requires_enough_audio_for_supported_backends() {
        for backend in ["essentia", "libkeyfinder"] {
            let mut payload = crate::audio_models::DetectedKeyPayload::unavailable("test");
            payload.primary_key = Some("D".into());
            payload.primary_scale = Some("major".into());
            payload.source = format!("audio_analysis:{backend}");
            payload.state = "likely_key".into();
            payload.capture_mode = CaptureMode::ProcessLoopback;
            payload.confidence = 0.95;
            payload.stability = 0.95;
            payload.ambiguous = false;
            let gated = enforce_apply_gate(
                payload.clone(),
                backend,
                true,
                true,
                true,
                false,
                false,
                false,
                0.95,
                1,
                &stable_cm(),
                8,
            );
            assert!(!gated.ready_to_apply, "not enough audio on {backend}");
            payload.enough_audio = true;
            let gated = enforce_apply_gate(
                payload,
                backend,
                true,
                true,
                true,
                false,
                false,
                false,
                0.95,
                1,
                &stable_cm(),
                8,
            );
            assert!(gated.ready_to_apply, "stable supported backend {backend}");
        }
    }

    #[test]
    fn apply_gate_blocks_when_recent_silence_detected() {
        let payload = crate::audio_models::DetectedKeyPayload {
            primary_key: Some("G".to_string()),
            primary_scale: Some("major".to_string()),
            display_name: Some("G major".to_string()),
            confidence: 0.96,
            note_set_evidence: None,
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
            evidence_id: None,
            track_identity: None,
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
        assert!(gated
            .reason
            .unwrap_or_default()
            .contains("recentSilence=true"));
    }

    #[test]
    fn apply_gate_allows_paused_hold_when_last_good_was_ready() {
        let payload = crate::audio_models::DetectedKeyPayload {
            primary_key: Some("E".to_string()),
            primary_scale: Some("minor".to_string()),
            display_name: Some("E minor".to_string()),
            confidence: 0.93,
            note_set_evidence: None,
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
            evidence_id: None,
            track_identity: None,
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

    #[test]
    fn analyzer_search_roots_do_not_depend_on_cwd_alone() {
        let roots = analyzer_search_roots();
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .expect("test binary has a parent directory");
        assert!(
            roots.contains(&exe_dir),
            "the executable's own directory must be searched so a packaged app started from \
             an arbitrary cwd still finds the sidecar; got {roots:?}"
        );
    }

    #[test]
    fn analyzer_candidates_cover_both_the_script_and_the_frozen_binary() {
        let script = analyzer_file_candidates("key_analyzer.py");
        assert!(!script.is_empty());
        assert!(script
            .iter()
            .all(|p| p.ends_with("sidecars/key_analyzer/key_analyzer.py")));

        let binaries = analyzer_executable_candidates();
        assert_eq!(binaries.len(), script.len());
        let expected_name = if cfg!(windows) {
            "key_analyzer.exe"
        } else {
            "key_analyzer"
        };
        assert!(binaries
            .iter()
            .all(|p| p.file_name().map(|n| n == expected_name).unwrap_or(false)));
    }

    #[test]
    fn libkeyfinder_candidates_include_the_documented_build_output() {
        let exe_name = if cfg!(windows) {
            "gsv-libkeyfinder-cli.exe"
        } else {
            "gsv-libkeyfinder-cli"
        };
        let candidates = libkeyfinder_cli_candidates();
        assert!(
            candidates
                .iter()
                .any(|p| p.ends_with(format!("sidecars/libkeyfinder_cli/build/{exe_name}"))),
            "build.sh writes the CLI to sidecars/libkeyfinder_cli/build/; got {candidates:?}"
        );
    }

    #[test]
    fn shutdown_does_not_wait_indefinitely_for_a_stalled_native_thread() {
        use std::time::{Duration, Instant};
        let handle = std::thread::spawn(|| std::thread::sleep(Duration::from_millis(200)));
        let started = Instant::now();
        assert!(!super::join_engine_before_deadline(
            handle,
            Duration::from_millis(20)
        ));
        assert!(started.elapsed() < Duration::from_millis(150));
    }
}

#[cfg(test)]
mod pause_tests {
    use super::{capture_transition, CaptureTransition, PausedCapture};
    use crate::audio_models::CaptureMode;

    fn paused() -> PausedCapture {
        PausedCapture {
            mode: CaptureMode::EndpointLoopback,
            target: Some("Brave".to_string()),
            track: "randy newman - you've got a friend in me".to_string(),
            payload: None,
        }
    }

    #[test]
    fn a_pause_and_the_resume_of_the_same_track_keep_the_evidence() {
        let p = paused();
        let track = Some(p.track.as_str());
        assert_eq!(
            capture_transition(
                Some(&p),
                CaptureMode::Unavailable,
                Some("Brave"),
                track,
                true
            ),
            CaptureTransition::Pausing
        );
        assert_eq!(
            capture_transition(
                Some(&p),
                CaptureMode::EndpointLoopback,
                Some("Brave"),
                track,
                false
            ),
            CaptureTransition::Resuming
        );
    }

    #[test]
    fn anything_that_might_be_other_audio_starts_over() {
        let p = paused();
        let track = Some(p.track.as_str());
        // Nothing was paused: every change is a change, exactly as before.
        assert_eq!(
            capture_transition(
                None,
                CaptureMode::EndpointLoopback,
                Some("Brave"),
                track,
                false
            ),
            CaptureTransition::Changed
        );
        // Another song, another player, no identity, or a different kind of capture.
        assert_eq!(
            capture_transition(
                Some(&p),
                CaptureMode::EndpointLoopback,
                Some("Brave"),
                Some("sting - shape of my heart"),
                false
            ),
            CaptureTransition::Changed
        );
        assert_eq!(
            capture_transition(
                Some(&p),
                CaptureMode::EndpointLoopback,
                Some("Spotify"),
                track,
                false
            ),
            CaptureTransition::Changed
        );
        assert_eq!(
            capture_transition(
                Some(&p),
                CaptureMode::EndpointLoopback,
                Some("Brave"),
                None,
                false
            ),
            CaptureTransition::Changed
        );
        assert_eq!(
            capture_transition(
                Some(&p),
                CaptureMode::ProcessLoopback,
                Some("Brave"),
                track,
                false
            ),
            CaptureTransition::Changed
        );
    }
}
