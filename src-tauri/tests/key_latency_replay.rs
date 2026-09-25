//! What the player sees, cycle by cycle — the engine replayed from cached analyzer output.
//!
//! Why this exists alongside `key_accuracy_scoreboard.rs`
//! ------------------------------------------------------
//! Every latency number the project has published was a number about the engine's *verdict*: when
//! `ready_to_apply` first came true, and whether it was right. Two things about the product make
//! that the wrong quantity to minimise:
//!
//! * The neck is drawn from the very first reading. `keyFusion.ts` never withholds an answer, so a
//!   player is looking at *some* scale from the first analysis onward, and what they wait for is the
//!   moment that scale is the right one — not the moment a flag flips.
//! * `ready_to_apply` gates nothing on screen. `canAutoApply` in `src/practice/session.ts` is the
//!   only reader and nothing calls it; the readout's confident state is `!ambiguous`, which the
//!   live gate decides *before* `MIN_READY_STREAK` is ever consulted.
//!
//! So this replays each clip the way the engine loop sees it — a growing buffer analysed on the
//! hop grid — through the same per-cycle sequence the loop runs, and writes every emitted payload
//! to JSON. `src/services/neckReplay.research.test.ts` then runs those payloads through the real
//! `fuseKey` / `shouldRevise` and scores the neck. Nothing on either side is reimplemented except
//! the loop's own bookkeeping, which is mirrored below step by step with the line it mirrors.
//!
//! The analyzer is not run here. `scripts/key-research/cache_spans.py` ran the shipped CLI once per
//! clip per second of audio and stored its output; `analysis_from_cli_stdout` turns a cached line
//! into exactly what `LibKeyFinderDetector::analyze` would have returned. That makes a sweep over
//! cadence, first-reading time or any gate constant cost seconds instead of an hour of CLI runs.
//!
//! ```text
//! python3 scripts/key-research/cache_spans.py      # once, ~25 minutes on 16 cores
//! cargo test --test key_latency_replay -- --ignored --nocapture
//! npx vitest run src/services/neckReplay.research.test.ts
//! ```

use std::collections::{BTreeMap, VecDeque};
use std::path::PathBuf;

use app_lib::audio_models::{CaptureMode, DetectedKeyPayload, NoteSetEvidence};
use app_lib::key_detection::{analysis_from_cli_stdout, AnalysisOutput};
use app_lib::key_engine::{
    apply_ready_streak_gate, contradiction_metrics_from_history, decide_from_windows,
    dominant_margin_of, enforce_apply_gate, evidence_is_calibrated, live_gate,
    relative_pair_unresolved_in, window_evidence, with_switch_hysteresis, AnalysisEvidence,
    LiveGateInputs, ANALYSIS_HOP_SECONDS, CONTRADICTION_CLEAR_CLEAN_CYCLES,
    CONTRADICTION_COOLDOWN_MS, FIRST_ANALYSIS_SECONDS, HISTORY_HORIZON, MAX_ANALYSIS_SPAN_SECONDS,
    PRIMARY_KEY_REPEAT_MIN, REQUIRED_AUDIO_SECONDS,
};
use serde::{Deserialize, Serialize};

fn cache_path() -> PathBuf {
    std::env::var("GSV_SPAN_CACHE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp/gsv-span-cache-trim.jsonl"))
}

fn dump_dir() -> PathBuf {
    std::env::var("GSV_NECK_DUMP_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp/gsv-neck-replay"))
}

#[derive(Deserialize)]
struct CacheLine {
    clip_id: String,
    capture: String,
    song: String,
    key: String,
    mode: String,
    span: usize,
    music_seconds: f32,
    out: Option<serde_json::Value>,
}

struct CachedClip {
    clip_id: String,
    capture: String,
    song: String,
    truth: (u8, &'static str),
    music_seconds: f32,
    /// CLI stdout per span in whole seconds, exactly as the shipped binary printed it.
    stdout_by_span: BTreeMap<usize, String>,
}

fn pitch_class(label: &str) -> Option<u8> {
    let mut chars = label.trim().chars();
    let base: i32 = match chars.next()?.to_ascii_uppercase() {
        'C' => 0,
        'D' => 2,
        'E' => 4,
        'F' => 5,
        'G' => 7,
        'A' => 9,
        'B' => 11,
        _ => return None,
    };
    let mut pc = base;
    for c in chars {
        match c {
            '#' | '♯' => pc += 1,
            'b' | '♭' => pc -= 1,
            _ => return None,
        }
    }
    Some(pc.rem_euclid(12) as u8)
}

fn normalize_mode(raw: &str) -> Option<&'static str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "major" => Some("major"),
        "minor" => Some("minor"),
        _ => None,
    }
}

fn load_cache() -> Vec<CachedClip> {
    let path = cache_path();
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "span cache unreadable at {}: {e}\n  build it with: python3 scripts/key-research/cache_spans.py",
            path.display()
        )
    });
    let mut clips: BTreeMap<String, CachedClip> = BTreeMap::new();
    for line in raw.lines().filter(|l| !l.trim().is_empty()) {
        let row: CacheLine = serde_json::from_str(line).expect("parse span cache line");
        let (Some(pc), Some(mode)) = (pitch_class(&row.key), normalize_mode(&row.mode)) else {
            continue;
        };
        let clip = clips
            .entry(row.clip_id.clone())
            .or_insert_with(|| CachedClip {
                clip_id: row.clip_id.clone(),
                capture: row.capture.clone(),
                song: row.song.clone(),
                truth: (pc, mode),
                music_seconds: row.music_seconds,
                stdout_by_span: BTreeMap::new(),
            });
        if let Some(out) = row.out {
            clip.stdout_by_span.insert(row.span, out.to_string());
        }
    }
    assert!(
        !clips.is_empty(),
        "span cache at {} is empty",
        path.display()
    );
    clips.into_values().collect()
}

/// The settings a replay is run under. `shipped()` is what the app does today.
#[derive(Debug, Clone, Copy)]
struct Timing {
    /// The buffer length at which the first analysis runs: `FIRST_ANALYSIS_SECONDS` for the
    /// libkeyfinder backend the cache was built with.
    first_seconds: usize,
    /// How far apart consecutive analyses are, in seconds of audio. `ANALYSIS_HOP_SECONDS`.
    hop_seconds: usize,
    required_audio_seconds: f32,
    repeat_min: usize,
}

impl Timing {
    fn shipped() -> Self {
        Self {
            first_seconds: FIRST_ANALYSIS_SECONDS,
            hop_seconds: ANALYSIS_HOP_SECONDS,
            required_audio_seconds: REQUIRED_AUDIO_SECONDS,
            repeat_min: PRIMARY_KEY_REPEAT_MIN,
        }
    }

    fn label(&self) -> String {
        format!(
            "first{}-hop{}-req{}-rep{}",
            self.first_seconds,
            self.hop_seconds,
            self.required_audio_seconds as usize,
            self.repeat_min
        )
    }

    /// The buffer lengths the loop analyses: the hop grid, from the first reading on.
    ///
    /// `aligned_analysis_samples` ends every analysed buffer on a multiple of the hop since capture
    /// started, so the spans are the multiples of the hop at or past the first reading.
    fn spans(&self, clip_seconds: usize) -> Vec<usize> {
        let last = clip_seconds.min(MAX_ANALYSIS_SPAN_SECONDS);
        (1..=last)
            .filter(|s| s % self.hop_seconds == 0 && *s >= self.first_seconds)
            .collect()
    }
}

/// The engine loop's state between analyses, and the sequence it runs on each fresh one.
///
/// Every step names the part of `spawn_key_engine` it mirrors. Two simplifications, both of which
/// only ever make the replay *more* willing to assert than the live loop: the capture never changes
/// mode or goes silent, and `capture_stable` / `session_stable` are already true at the first
/// analysis — live, both count three-second loop iterations from the moment capture starts, so by
/// the first twelve-second buffer they have long passed their thresholds of three.
struct EngineMirror {
    evidence: AnalysisEvidence,
    decision_history: VecDeque<String>,
    likely_streak: usize,
    primary_key_repeat_streak: usize,
    last_primary_key_choice: Option<String>,
    contradiction_active: bool,
    contradiction_clean_streak: usize,
    contradiction_cooldown_until_ms: u64,
    last_payload: Option<DetectedKeyPayload>,
}

impl EngineMirror {
    fn new() -> Self {
        Self {
            evidence: AnalysisEvidence::default(),
            decision_history: VecDeque::new(),
            likely_streak: 0,
            primary_key_repeat_streak: 0,
            last_primary_key_choice: None,
            contradiction_active: false,
            contradiction_clean_streak: 0,
            contradiction_cooldown_until_ms: 0,
            last_payload: None,
        }
    }

    fn step(
        &mut self,
        output: AnalysisOutput,
        span_seconds: usize,
        now_ms: u64,
        timing: &Timing,
        capture_mode: CaptureMode,
    ) -> DetectedKeyPayload {
        // `evidence.accept(&output.windows, sample_start_ms, aligned_endpoint)`; a growing buffer
        // starts at the capture's first sample, so its absolute start is zero.
        let endpoint = span_seconds as u64 * 44_100;
        let fresh = self.evidence.accept(&output.windows, 0, endpoint);
        // `if fresh_analysis { output.windows = evidence.recent(); }`
        let windows = if fresh {
            self.evidence.recent()
        } else {
            output.windows.clone()
        };
        // `winners_recent` / `last_window_tonic_votes`, via the shared helper.
        let ev = window_evidence(&windows);
        // `enough_audio = capture.enough_audio(REQUIRED_AUDIO_SECONDS)`
        let enough_audio = span_seconds as f32 >= timing.required_audio_seconds;
        let payload = decide_from_windows(
            &windows,
            capture_mode,
            None,
            enough_audio,
            &self.decision_history,
            output.chroma.as_deref(),
        );
        // `decision_history.push_back(format!("{k}:{s}"))`, fresh cycles only.
        if let (true, Some(k), Some(s)) = (fresh, &payload.primary_key, &payload.primary_scale) {
            if self.decision_history.len() == HISTORY_HORIZON {
                self.decision_history.pop_front();
            }
            self.decision_history.push_back(format!("{k}:{s}"));
        }
        // The contradiction machine: `contradiction_now = contradiction_burst(&window_keys)`.
        if ev.contradiction_burst {
            self.contradiction_active = true;
            self.contradiction_clean_streak = 0;
            self.contradiction_cooldown_until_ms = now_ms + CONTRADICTION_COOLDOWN_MS;
        } else if self.contradiction_active {
            self.contradiction_clean_streak += 1;
            if self.contradiction_clean_streak >= CONTRADICTION_CLEAR_CLEAN_CYCLES {
                self.contradiction_active = false;
                self.contradiction_clean_streak = 0;
            }
        } else if self.contradiction_clean_streak > 0 {
            self.contradiction_clean_streak = 0;
        }
        let payload = DetectedKeyPayload {
            source: format!("audio_analysis:{}", output.backend_used),
            ..payload
        };
        // `with_switch_hysteresis(payload, last_payload.as_ref())`
        let mut payload = with_switch_hysteresis(payload, self.last_payload.as_ref());
        payload.buffer_seconds = span_seconds as f32;
        // `primary_key_repeat_streak`
        if let (true, Some(k), Some(s)) = (
            fresh,
            payload.primary_key.as_deref(),
            payload.primary_scale.as_deref(),
        ) {
            let choice = format!("{k}:{s}");
            if self.last_primary_key_choice.as_deref() == Some(choice.as_str()) {
                self.primary_key_repeat_streak += 1;
            } else {
                self.primary_key_repeat_streak = 1;
                self.last_primary_key_choice = Some(choice);
            }
        } else if payload.primary_key.is_none() {
            self.primary_key_repeat_streak = 0;
            self.last_primary_key_choice = None;
        }
        let contradiction_cooldown = now_ms < self.contradiction_cooldown_until_ms;
        let cm = contradiction_metrics_from_history(&self.decision_history);
        let repeated_key = self.primary_key_repeat_streak >= timing.repeat_min;
        let mut contradiction_cooldown_block = contradiction_cooldown;
        // `if payload.state == "likely_key" && payload.source != "cloud_verified" { live_gate(..) }`
        if payload.state == "likely_key" {
            let gate = live_gate(
                &LiveGateInputs {
                    capture_mode,
                    capture_stable: true,
                    session_stable: true,
                    repeated_key,
                    recent_disruption: false,
                    contradiction_active: self.contradiction_active,
                    contradiction_cooldown,
                    recent_silence: false,
                    relative_pair_unresolved: relative_pair_unresolved_in(&payload),
                    primary_key_repeat_streak: self.primary_key_repeat_streak,
                    dominant_margin: dominant_margin_of(&payload),
                    window_dominance: ev.window_dominance,
                    window_distinct_tonics: ev.window_distinct_tonics,
                    evidence_calibrated: evidence_is_calibrated(&windows, &payload),
                },
                &cm,
            );
            contradiction_cooldown_block = gate.contradiction_cooldown_block;
            if !gate.allowed {
                payload.state = "ambiguous".to_string();
                payload.ambiguous = true;
                payload.ready_to_apply = false;
                payload.reason = Some(format!(
                    "gating_denied:repeat={} stableTonics={} recentWindowsClean={} endpointOk={} marginOk={} cooldownBlock={}",
                    self.primary_key_repeat_streak,
                    gate.stable_tonics,
                    gate.recent_windows_clean,
                    gate.endpoint_conservative_ok,
                    gate.margin_ok,
                    gate.contradiction_cooldown_block
                ));
            }
        }
        // `likely_streak`
        if fresh && payload.state == "likely_key" && !payload.ambiguous {
            self.likely_streak += 1;
        } else if payload.state != "likely_key" || payload.ambiguous {
            self.likely_streak = 0;
        }
        let backend = output.backend_used.clone();
        payload = apply_ready_streak_gate(
            payload,
            self.likely_streak,
            &backend,
            cm.tonic_entropy,
            cm.dominant_share,
        );
        payload = enforce_apply_gate(
            payload,
            &backend,
            true,
            true,
            repeated_key,
            self.contradiction_active,
            contradiction_cooldown_block,
            false,
            ev.window_dominance,
            ev.window_distinct_tonics,
            &cm,
            self.likely_streak,
        );
        self.last_payload = Some(payload.clone());
        payload
    }
}

/// The fields of a payload the frontend reads, in the frontend's own names.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CycleDump {
    /// Seconds of audio in the buffer when this analysis ran.
    span: usize,
    primary_key: Option<String>,
    primary_scale: Option<String>,
    display_name: Option<String>,
    confidence: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    note_set_evidence: Option<NoteSetEvidence>,
    ambiguous: bool,
    alternatives: Vec<AlternativeDump>,
    state: String,
    reason: Option<String>,
    ready_to_apply: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AlternativeDump {
    key: String,
    scale: String,
    display_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipDump {
    clip_id: String,
    capture: String,
    song: String,
    truth_pc: u8,
    truth_mode: &'static str,
    music_seconds: f32,
    cycles: Vec<CycleDump>,
}

fn replay_clip(clip: &CachedClip, timing: &Timing, capture_mode: CaptureMode) -> Vec<CycleDump> {
    let mut engine = EngineMirror::new();
    let mut cycles = Vec::new();
    for span in timing.spans(clip.music_seconds.floor() as usize) {
        let Some(stdout) = clip.stdout_by_span.get(&span) else {
            continue;
        };
        let output = analysis_from_cli_stdout(stdout, span as u64 * 1000)
            .unwrap_or_else(|e| panic!("{} at {span}s: {e}", clip.clip_id));
        let payload = engine.step(output, span, span as u64 * 1000, timing, capture_mode);
        cycles.push(CycleDump {
            span,
            primary_key: payload.primary_key.clone(),
            primary_scale: payload.primary_scale.clone(),
            display_name: payload.display_name.clone(),
            confidence: payload.confidence,
            note_set_evidence: payload.note_set_evidence,
            ambiguous: payload.ambiguous,
            alternatives: payload
                .alternatives
                .iter()
                .map(|a| AlternativeDump {
                    key: a.key.clone(),
                    scale: a.scale.clone(),
                    display_name: a.display_name.clone(),
                })
                .collect(),
            state: payload.state.clone(),
            reason: payload.reason.clone(),
            ready_to_apply: payload.ready_to_apply,
        });
    }
    cycles
}

fn dump(clips: &[CachedClip], timing: &Timing, capture_mode: CaptureMode) -> PathBuf {
    let dumps: Vec<ClipDump> = clips
        .iter()
        .map(|clip| ClipDump {
            clip_id: clip.clip_id.clone(),
            capture: clip.capture.clone(),
            song: clip.song.clone(),
            truth_pc: clip.truth.0,
            truth_mode: clip.truth.1,
            music_seconds: clip.music_seconds,
            cycles: replay_clip(clip, timing, capture_mode),
        })
        .collect();
    let dir = dump_dir();
    std::fs::create_dir_all(&dir).expect("create dump dir");
    let path = dir.join(format!("{}-{:?}.json", timing.label(), capture_mode));
    std::fs::write(&path, serde_json::to_string(&dumps).expect("encode dump")).expect("write dump");
    path
}

/// The seven pitch classes a key draws.
fn note_set(pc: u8, mode: &str) -> [u8; 7] {
    let steps: [u8; 7] = if mode == "major" {
        [0, 2, 4, 5, 7, 9, 11]
    } else {
        [0, 2, 3, 5, 7, 8, 10]
    };
    let mut out = steps.map(|s| (pc + s) % 12);
    out.sort_unstable();
    out
}

/// The engine's own verdict per span, before any policy — what the analyzer says after hearing
/// this much, which bounds how early any policy downstream of it can be right.
fn analyzer_curve(clips: &[CachedClip], spans: &[usize]) {
    println!(
        "\n-- the analyzer alone, by seconds of audio heard ({} clips) --",
        clips.len()
    );
    println!("{:>6}{:>10}{:>10}{:>8}", "heard", "notes", "exact", "n");
    for &span in spans {
        let (mut notes, mut exact, mut n) = (0usize, 0usize, 0usize);
        for clip in clips {
            let Some(stdout) = clip.stdout_by_span.get(&span) else {
                continue;
            };
            let Ok(output) = analysis_from_cli_stdout(stdout, span as u64 * 1000) else {
                continue;
            };
            n += 1;
            let got = output
                .windows
                .first()
                .and_then(|w| pitch_class(&w.key).zip(normalize_mode(&w.scale)));
            if let Some((pc, mode)) = got {
                exact += usize::from((pc, mode) == clip.truth);
                notes += usize::from(note_set(pc, mode) == note_set(clip.truth.0, clip.truth.1));
            }
        }
        if n > 0 {
            println!(
                "{:>5}s{:>9.1}%{:>9.1}%{:>8}",
                span,
                100.0 * notes as f64 / n as f64,
                100.0 * exact as f64 / n as f64,
                n
            );
        }
    }
}

#[test]
#[ignore = "needs the span cache from scripts/key-research/cache_spans.py; run with --ignored --nocapture"]
fn neck_replay_dump() {
    let clips = load_cache();
    println!(
        "\n=== engine replay from the span cache: {} clips ===",
        clips.len()
    );
    analyzer_curve(&clips, &[4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 36, 40]);

    let mut timings = vec![Timing::shipped()];
    // Extra arms, each named on the command line so a sweep does not need a code edit:
    //   GSV_REPLAY_ARMS="first8-hop2-req20-rep4,first12-hop1-req20-rep4"
    if let Ok(arms) = std::env::var("GSV_REPLAY_ARMS") {
        for arm in arms.split(',').filter(|a| !a.trim().is_empty()) {
            let mut t = Timing::shipped();
            for part in arm.trim().split('-') {
                let (name, value) = part.split_at(
                    part.find(|c: char| c.is_ascii_digit())
                        .unwrap_or(part.len()),
                );
                let value: usize = value
                    .parse()
                    .unwrap_or_else(|_| panic!("bad arm part {part}"));
                match name {
                    "first" => t.first_seconds = value,
                    "hop" => t.hop_seconds = value,
                    "req" => t.required_audio_seconds = value as f32,
                    "rep" => t.repeat_min = value,
                    _ => panic!("unknown arm part {part}"),
                }
            }
            timings.push(t);
        }
    }
    for timing in &timings {
        for mode in [CaptureMode::EndpointLoopback, CaptureMode::ProcessLoopback] {
            let path = dump(&clips, timing, mode);
            println!("  {} {:?} -> {}", timing.label(), mode, path.display());
        }
    }
}
