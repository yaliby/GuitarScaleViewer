//! The scoreboard: how often is the shipped key engine right, and in which of the two ways?
//!
//! Why two numbers
//! ---------------
//! "Accuracy" has been one number in this project, and that number hides the thing that matters
//! most to a player. When the engine answers G major for a song in E minor, the fretboard lights
//! the *same seven notes* — the player can solo over it and never notice. When it answers E minor
//! for a song in A minor, the notes are wrong and every bend lands outside the key.
//!
//! Those two failures are not the same defect and must not share a score. So:
//!
//! * **note-set accuracy** — is the pitch-class set on the neck the right one? A relative
//!   major/minor slip counts as *correct* here, because the diagram is correct.
//! * **tonic accuracy** — are the root and the mode right? A relative slip counts as *wrong*.
//!
//! `tonic` is bounded above by `note-set`. The gap between them was the target of work item M2,
//! the bass-chroma tonic discriminator — and this harness is what showed that no version of M2
//! beats a coin flip, because in a loop with no leading tone the tonal centre is not in the audio
//! at all. See `docs/KEY_ACCURACY_BASELINE.md` for the numbers that closed that question.
//!
//! What the harness measures now is the gate that replaced it: the app does not guess which end
//! of a relative pair is home, it reports whether the root was earned. The property it enforces
//! is that a root the engine got wrong is never asserted.
//!
//! There are two measurements here. `key_engine_accuracy_scoreboard` asks whether the engine
//! hears a key; `key_engine_time_to_answer_curve` asks *when*, by replaying a growing capture
//! buffer through the real decision path. See `docs/KEY_LATENCY.md`.
//!
//! **They disagree about how much audio the engine gets, deliberately — and that has bitten
//! once.** The replay applies `MAX_ANALYSIS_SPAN_SECONDS`; this test hands the CLI the whole clip,
//! because what it benchmarks is the analyzer rather than the buffer policy. While the cap was 44
//! and corpus clips were ~58 seconds, that meant the published 71.4% / 65.9% was a number the
//! shipped app could not reach — it was being scored on a quarter more audio than it ever
//! received, and the gap went unnoticed for a session. It is closed now only because the cap (60)
//! exceeds what a corpus clip holds. Lower the cap below the clip length and this test quietly
//! goes back to flattering the product. See "The ceiling that was not there" in
//! `docs/KEY_ACCURACY_BASELINE.md`.
//!
//! Running it
//! ----------
//! ```text
//! python3 tests/fixtures/generate_corpus.py          # once; writes the gitignored corpus/
//! cargo test --test key_accuracy_scoreboard -- --ignored --nocapture
//! ```
//!
//! Against your own music instead of synthetic clips — this is the number that actually
//! predicts real-world behaviour:
//! ```text
//! GSV_REAL_CORPUS=/path/to/audio cargo test --test key_accuracy_scoreboard -- --ignored --nocapture
//! ```
//! where that directory holds the audio plus a `keys.csv` of `filename,key,mode` lines.
//!
//! It is `#[ignore]`d because it needs the built libkeyfinder CLI and a generated corpus, and a
//! test that silently returns early when those are missing reports `ok` for checking nothing.

use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use app_lib::audio_models::CaptureMode;
use app_lib::key_detection::{KeyDetector, LibKeyFinderDetector};
use app_lib::key_engine::{
    contradiction_metrics_from_history, decide_from_windows, dominant_margin_of, evidence_is_calibrated, live_gate,
    relative_pair_unresolved_in, window_evidence, AnalysisEvidence, LiveGateInputs,
    ANALYSIS_HOP_SECONDS, ANALYSIS_WINDOW_SECONDS, CAPTURE_STABLE_MIN_CYCLES,
    CONTRADICTION_CLEAR_CLEAN_CYCLES, CONTRADICTION_COOLDOWN_MS, HISTORY_HORIZON,
    MAX_ANALYSIS_SPAN_SECONDS, MIN_READY_STREAK, PRIMARY_KEY_REPEAT_MIN, REQUIRED_AUDIO_SECONDS,
    SESSION_STABLE_MIN_CYCLES,
};
use app_lib::key_reranker;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CorpusClip {
    id: String,
    path: String,
    #[serde(default)]
    template: String,
    expected_key: String,
    expected_mode: String,
    /// Non-stationary clips only: the key of the middle section, and when it plays. A readout
    /// that locks this has been fooled by a passage the song leaves.
    #[serde(default)]
    decoy_key: Option<String>,
    #[serde(default)]
    decoy_mode: Option<String>,
    #[serde(default)]
    decoy_from_seconds: f32,
    #[serde(default)]
    decoy_to_seconds: f32,
}

#[derive(Debug, Deserialize)]
struct Corpus {
    clips: Vec<CorpusClip>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliAnswer {
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    scale: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    chroma: Option<Vec<f32>>,
    /// The profile's shortlist, which the chord re-ranker reorders. Scoring the CLI's own `key`
    /// instead of the re-ranked one measured a pipeline the app does not have.
    #[serde(default)]
    candidates: Vec<CliCandidate>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliCandidate {
    key: String,
    scale: String,
    score: f32,
    #[serde(default)]
    chord_features: Vec<f32>,
}

/// What the app would actually put on screen for this clip, once the tonic-evidence gate has had
/// its say. `None` when the CLI reported no chroma (an older build).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Claim {
    /// The readout asserts this root.
    TonicAsserted,
    /// The readout shows the notes and says the root is open.
    TonicOpen,
}

/// Spelling is not the question here: Gb and F# are one key, and the engine is free to name it
/// either way. Everything is compared as a pitch class.
fn pitch_class(label: &str) -> Option<u8> {
    let mut chars = label.trim().chars();
    let letter = chars.next()?.to_ascii_uppercase();
    let base: i32 = match letter {
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
            'b' | 'B' | '♭' => pc -= 1,
            _ => return None,
        }
    }
    Some(pc.rem_euclid(12) as u8)
}

fn normalize_mode(raw: &str) -> Option<&'static str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "major" | "maj" | "ionian" => Some("major"),
        "minor" | "min" | "aeolian" => Some("minor"),
        _ => None,
    }
}

/// The seven pitch classes a major or minor key draws on the neck.
fn note_set(tonic_pc: u8, mode: &str) -> [u8; 7] {
    let steps: [u8; 7] = if mode == "major" {
        [0, 2, 4, 5, 7, 9, 11]
    } else {
        [0, 2, 3, 5, 7, 8, 10]
    };
    let mut out = [0u8; 7];
    for (i, step) in steps.iter().enumerate() {
        out[i] = (tonic_pc + step) % 12;
    }
    out.sort_unstable();
    out
}

/// How a prediction missed, in the terms a player would describe it.
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Outcome {
    /// Root and mode both right.
    Exact,
    /// Same seven notes, wrong tonal centre — the neck is usable, the root marker is not.
    RelativeSlip,
    /// A different set of notes. The diagram is wrong.
    WrongNotes,
    /// The engine returned nothing readable.
    NoAnswer,
}

fn classify(expected: (u8, &str), got: Option<(u8, &str)>) -> Outcome {
    let Some((got_pc, got_mode)) = got else {
        return Outcome::NoAnswer;
    };
    if got_pc == expected.0 && got_mode == expected.1 {
        return Outcome::Exact;
    }
    if note_set(got_pc, got_mode) == note_set(expected.0, expected.1) {
        return Outcome::RelativeSlip;
    }
    Outcome::WrongNotes
}

fn cli_path() -> PathBuf {
    if let Ok(explicit) = std::env::var("GSV_LIBKEYFINDER_CLI") {
        return PathBuf::from(explicit);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("sidecars/libkeyfinder_cli/build/gsv-libkeyfinder-cli")
}

fn analyze(cli: &Path, wav: &Path) -> Option<((u8, &'static str), Option<Claim>)> {
    let out = Command::new(cli)
        .arg(wav)
        .output()
        .unwrap_or_else(|e| panic!("run {}: {e}", cli.display()));
    let stdout = String::from_utf8_lossy(&out.stdout);
    let answer: CliAnswer = serde_json::from_str(stdout.trim()).ok()?;
    if answer.error.is_some() {
        return None;
    }
    // The shipped verdict, not the analyzer's: `key_detection::analyze` hands the shortlist to the
    // chord re-ranker before anything downstream sees a key, so a scoreboard that reads the CLI's
    // own `key` scores a pipeline that is not in the product. It declines on an older CLI that
    // sends no shortlist, and then this is the analyzer's answer again.
    let shortlist: Vec<key_reranker::ShortlistEntry> = answer
        .candidates
        .iter()
        .map(|c| key_reranker::ShortlistEntry {
            key: c.key.trim().to_string(),
            scale: c.scale.trim().to_ascii_lowercase(),
            score: c.score,
            chord_features: c.chord_features.clone(),
        })
        .collect();
    let reranked = key_reranker::rerank(&shortlist).map(|position| &shortlist[position]);
    let key = reranked
        .map(|entry| entry.key.as_str())
        .or(answer.key.as_deref())?;
    let pc = pitch_class(key)?;
    let mode = normalize_mode(
        reranked
            .map(|entry| entry.scale.as_str())
            .or(answer.scale.as_deref())?,
    )?;
    // The shipped gates, not copies of them: both of these functions are the ones the engine runs.
    //
    // There are two, and they withdraw a root for unrelated reasons. `tonic_is_supported` asks the
    // chroma whether the named root is evidenced at all; the relative-pair gap asks whether the
    // analyzer could separate the two names of one note set. On real recordings the first catches
    // nothing and the second is what actually fires, which is only visible because they are scored
    // together here.
    let coin_flip = shortlist
        .first()
        .zip(shortlist.get(1))
        .filter(|(first, second)| {
            app_lib::key_engine::is_relative_major_minor(
                &first.key,
                &first.scale,
                &second.key,
                &second.scale,
            )
        })
        .map(|(first, second)| {
            first.score - second.score < app_lib::key_engine::RELATIVE_PAIR_COIN_FLIP_GAP
        })
        .unwrap_or(false);
    let claim = if coin_flip {
        Some(Claim::TonicOpen)
    } else {
        answer
            .chroma
            .as_deref()
            .and_then(|chroma| app_lib::key_engine::tonic_is_supported(chroma, key, mode))
            .map(|supported| {
                if supported {
                    Claim::TonicAsserted
                } else {
                    Claim::TonicOpen
                }
            })
    };
    Some(((pc, mode), claim))
}

#[derive(Default)]
struct Tally {
    exact: usize,
    relative_slip: usize,
    wrong_notes: usize,
    no_answer: usize,
}

impl Tally {
    fn total(&self) -> usize {
        self.exact + self.relative_slip + self.wrong_notes + self.no_answer
    }
    /// The neck draws the right seven notes — a relative slip still qualifies.
    fn note_set_pct(&self) -> f64 {
        pct(self.exact + self.relative_slip, self.total())
    }
    /// Root and mode both right.
    fn tonic_pct(&self) -> f64 {
        pct(self.exact, self.total())
    }
    fn record(&mut self, outcome: &Outcome) {
        match outcome {
            Outcome::Exact => self.exact += 1,
            Outcome::RelativeSlip => self.relative_slip += 1,
            Outcome::WrongNotes => self.wrong_notes += 1,
            Outcome::NoAnswer => self.no_answer += 1,
        }
    }
}

fn pct(n: usize, d: usize) -> f64 {
    if d == 0 {
        return 0.0;
    }
    (n as f64) * 100.0 / (d as f64)
}

/// `filename,key,mode` per line, `#` for comments. The header row is optional.
fn read_real_corpus(dir: &Path) -> Vec<CorpusClip> {
    let csv = dir.join("keys.csv");
    let raw = std::fs::read_to_string(&csv).unwrap_or_else(|e| {
        panic!(
            "GSV_REAL_CORPUS is set but {} is unreadable: {e}",
            csv.display()
        )
    });
    let mut clips = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let cols: Vec<&str> = line.splitn(3, ',').map(|c| c.trim()).collect();
        if cols.len() < 3 {
            continue;
        }
        if normalize_mode(cols[2]).is_none() || pitch_class(cols[1]).is_none() {
            // The header row lands here, as does any row whose key cannot be read.
            continue;
        }
        clips.push(CorpusClip {
            id: cols[0].to_string(),
            path: cols[0].to_string(),
            template: "real".to_string(),
            expected_key: cols[1].to_string(),
            expected_mode: cols[2].to_string(),
            decoy_key: None,
            decoy_mode: None,
            decoy_from_seconds: 0.0,
            decoy_to_seconds: 0.0,
        });
    }
    clips
}

/// The corpus under test: the generated synthetic one, or real recordings when `GSV_REAL_CORPUS`
/// names a directory holding audio and a `keys.csv`.
fn load_corpus() -> (PathBuf, Vec<CorpusClip>, &'static str) {
    let real_dir = std::env::var("GSV_REAL_CORPUS").ok().map(PathBuf::from);
    let (root, clips, label) = match &real_dir {
        Some(dir) => {
            assert!(
                dir.is_dir(),
                "GSV_REAL_CORPUS is not a directory: {}",
                dir.display()
            );
            (dir.clone(), read_real_corpus(dir), "real audio")
        }
        None => {
            let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
            let manifest = base.join("corpus/corpus_manifest.json");
            assert!(
                manifest.exists(),
                "corpus not generated at {}\n  generate it with: python3 tests/fixtures/generate_corpus.py",
                manifest.display()
            );
            let raw = std::fs::read_to_string(&manifest).expect("read corpus manifest");
            let corpus: Corpus = serde_json::from_str(&raw).expect("parse corpus manifest");
            (base, corpus.clips, "synthetic")
        }
    };
    assert!(!clips.is_empty(), "corpus is empty");
    (root, clips, label)
}

/// Clips that change key partway through, when the generator has produced them. Only meaningful
/// for the synthetic corpus: a directory of real recordings has no labelled middle section.
fn load_nonstationary_corpus() -> Option<(PathBuf, Vec<CorpusClip>)> {
    if std::env::var("GSV_REAL_CORPUS").is_ok() {
        return None;
    }
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let manifest = base.join("corpus/corpus_nonstationary_manifest.json");
    let raw = std::fs::read_to_string(&manifest).ok()?;
    let corpus: Corpus = serde_json::from_str(&raw).expect("parse non-stationary manifest");
    if corpus.clips.is_empty() {
        return None;
    }
    Some((base, corpus.clips))
}

fn require_cli() -> PathBuf {
    let cli = cli_path();
    assert!(
        cli.exists(),
        "libkeyfinder CLI not built at {}\n  build it with: ./sidecars/libkeyfinder_cli/build.sh",
        cli.display()
    );
    cli
}

#[test]
#[ignore = "needs the built libkeyfinder CLI and a generated corpus; run with --ignored --nocapture"]
fn key_engine_accuracy_scoreboard() {
    let cli = require_cli();
    let (root, clips, label) = load_corpus();

    // How the tonic-evidence gate behaves: of the roots the engine got wrong, how many does the
    // app refuse to assert — and what does that caution cost on the ones it got right?
    let mut slips_caught = 0usize;
    let mut slips_asserted = 0usize;
    let mut right_hedged = 0usize;
    let mut right_asserted = 0usize;
    let mut gate_unavailable = 0usize;

    let mut overall = Tally::default();
    let mut by_template: BTreeMap<String, Tally> = BTreeMap::new();
    let mut by_mode: BTreeMap<String, Tally> = BTreeMap::new();
    let mut misses: Vec<(String, String, String, Outcome)> = Vec::new();

    for clip in &clips {
        let wav = root.join(&clip.path);
        assert!(
            wav.exists(),
            "clip {} missing at {}",
            clip.id,
            wav.display()
        );

        let expected_pc = pitch_class(&clip.expected_key).unwrap_or_else(|| {
            panic!(
                "clip {} has an unreadable key {:?}",
                clip.id, clip.expected_key
            )
        });
        let expected_mode = normalize_mode(&clip.expected_mode).unwrap_or_else(|| {
            panic!(
                "clip {} has an unreadable mode {:?}",
                clip.id, clip.expected_mode
            )
        });

        let analysis = analyze(&cli, &wav);
        let got = analysis.map(|(key, _)| key);
        let claim = analysis.and_then(|(_, claim)| claim);
        let outcome = classify((expected_pc, expected_mode), got);

        match (claim, &outcome) {
            (None, _) => gate_unavailable += 1,
            (Some(Claim::TonicOpen), Outcome::RelativeSlip) => slips_caught += 1,
            (Some(Claim::TonicAsserted), Outcome::RelativeSlip) => slips_asserted += 1,
            (Some(Claim::TonicOpen), Outcome::Exact) => right_hedged += 1,
            (Some(Claim::TonicAsserted), Outcome::Exact) => right_asserted += 1,
            _ => {}
        }

        overall.record(&outcome);
        by_template
            .entry(clip.template.clone())
            .or_default()
            .record(&outcome);
        by_mode
            .entry(expected_mode.to_string())
            .or_default()
            .record(&outcome);

        if outcome != Outcome::Exact {
            let got_label = got
                .map(|(pc, m)| {
                    format!(
                        "{} {m}",
                        ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
                            [pc as usize]
                    )
                })
                .unwrap_or_else(|| "—".to_string());
            misses.push((
                clip.id.clone(),
                format!("{} {}", clip.expected_key, expected_mode),
                got_label,
                outcome,
            ));
        }
    }

    println!(
        "\n=== key engine accuracy: {} clips ({label}) ===",
        overall.total()
    );
    println!("{:<14} {:>5}  {:>9}  {:>7}", "", "n", "note-set", "tonic");
    let row = |name: &str, t: &Tally| {
        println!(
            "{:<14} {:>5}  {:>8.1}%  {:>6.1}%",
            name,
            t.total(),
            t.note_set_pct(),
            t.tonic_pct()
        );
    };
    row("overall", &overall);
    for (name, tally) in &by_mode {
        row(name, tally);
    }
    for (name, tally) in &by_template {
        row(name, tally);
    }

    println!(
        "\nbreakdown: {} exact, {} relative slips (right notes, wrong root), {} wrong notes, {} no answer",
        overall.exact, overall.relative_slip, overall.wrong_notes, overall.no_answer
    );

    if gate_unavailable < overall.total() {
        let slips = slips_caught + slips_asserted;
        let rights = right_hedged + right_asserted;
        println!("\ntonic-evidence gate — what the player is actually told:");
        println!(
            "  wrong roots never asserted   {slips_caught}/{slips}  ({:.1}%)",
            pct(slips_caught, slips)
        );
        println!(
            "  right roots asserted         {right_asserted}/{rights}  ({:.1}%)",
            pct(right_asserted, rights)
        );
        println!(
            "  right roots hedged anyway    {right_hedged}/{rights}  ({:.1}%) — the cost of the caution",
            pct(right_hedged, rights)
        );
        // The property the gate exists for — a wrong root asserted confidently is the one failure
        // the player cannot recover from without touching the screen — is **not currently held**,
        // and this assertion no longer claims it is.
        //
        // Measured 2026-09-20 on 60 real recordings: the gate withheld 0 of 4 wrong roots and
        // asserted all 39 correct ones. Not one real clip came near `TONIC_EVIDENCE_MIN_SHARE`
        // (minimum observed share 0.0362 against a 0.025 threshold), because drums, distortion and
        // reverb put energy in all twelve chroma bins. Nor is it a calibration error: the cue
        // separates nothing there (earned roots median 0.062, slipped roots 0.057). So the old
        // `slips_asserted == 0` was a property of synthetic audio, never of the shipped app.
        //
        // What is left is a regression guard on the synthetic corpus. Raise the floor if a real
        // fix lands; do not lower it to make a change pass.
        let worst_allowed = if label == "synthetic" { 12 } else { slips };
        assert!(
            slips_asserted <= worst_allowed,
            "the app asserted {slips_asserted} root(s) it got wrong (measured floor {worst_allowed}); \
             see docs/KEY_ACCURACY_BASELINE.md on why this is not zero"
        );
    }

    if !misses.is_empty() {
        println!("\nevery clip that was not exact:");
        misses.sort_by(|a, b| a.3.cmp(&b.3).then(a.0.cmp(&b.0)));
        for (id, expected, got, outcome) in &misses {
            println!(
                "  {:<28} want {:<10} got {:<10} {:?}",
                id, expected, got, outcome
            );
        }
    }

    // This harness measures; it does not gate. The one thing it does assert is that the engine
    // answered at all — a corpus of silence would otherwise print a tidy 0% and look like data.
    assert!(
        overall.no_answer < overall.total(),
        "the engine returned no readable answer for any clip — the CLI or the corpus is broken, \
         not the accuracy"
    );
}

// ================================================================================================
// How long does the player wait, and what does the wait buy?
// ================================================================================================
//
// The scoreboard above hands the analyzer a whole clip, which answers "can the engine hear this?"
// and not "when?". A guitarist standing in front of the app has already pressed play; every second
// before the neck settles is a second of guessing. The shipped constants say that costs about
// seventy: `REQUIRED_AUDIO_SECONDS` of buffer, then `MIN_READY_STREAK` agreeing analyses.
//
// Nobody had measured what those seconds buy. This replays a growing capture buffer through the
// real decision path — `AnalysisEvidence::accept`, `AnalysisEvidence::recent`,
// `decide_from_windows` — and reports accuracy as a function of how long the engine has listened,
// so the constants can be read off a curve instead of chosen.
//
// It also A/Bs the one structural question the replay exposes. On the libkeyfinder backend a pass
// is a single verdict over the whole buffer, labelled as if it were one 12-second window. The
// consensus layer was written for a stream of independent windows, and never gets one. `Pass`
// below is that comparison.

/// How much audio goes into one analyzer pass, and what the pass claims it listened to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Pass {
    /// What ships: the whole buffer, capped at `MAX_ANALYSIS_SPAN_SECONDS`, in one call — and
    /// reported as the window `0..12s` however much audio actually went in.
    WholeBuffer,
    /// The same verdict, labelled with the span it was actually drawn from.
    WholeBufferDatedHonestly,
    /// One `ANALYSIS_WINDOW_SECONDS` window per hop — what the consensus layer expects.
    NewestWindow,
}

impl Pass {
    fn label(self) -> &'static str {
        match self {
            Pass::WholeBuffer => "whole buffer, mislabelled (shipped)",
            Pass::WholeBufferDatedHonestly => "whole buffer, honest span",
            Pass::NewestWindow => "12s windows",
        }
    }
}

/// One analysis cycle of a replayed capture: what the app would hold after this much audio.
#[derive(Debug, Clone)]
struct Cycle {
    heard_seconds: usize,
    got: Option<(u8, &'static str)>,
    /// The consensus called it and nothing contested it. The buffer gate is deliberately *not*
    /// applied here — see `replay` — so one replay can be scored against any candidate gate.
    settled: bool,
    /// Whether this cycle brought new evidence. The engine only counts a streak when it did.
    fresh: bool,
    /// Whether the engine loop's own gate would let the readout assert this — `live_gate`, the
    /// forty lines that used to sit inline in the async loop and that no test could reach.
    /// `settled` above is only the consensus's opinion; this is the one the player feels.
    gate_allowed: bool,
    /// The first condition that refused, in the order the gate tests them. `None` when it allowed.
    /// The `why:` field is the only thing that has ever caught a bug in this gate.
    gate_block: Option<&'static str>,
    /// Whether the buffer still agrees with its own newest [`TAIL_SECONDS`]. `None` until the
    /// buffer is long enough for that to be a different stretch of music.
    tail_agrees: Option<bool>,
}

/// Mono `f32` at the file's own sample rate, which is what the detector takes.
fn read_mono_f32(path: &Path) -> (Vec<f32>, u32) {
    let mut reader = hound::WavReader::open(path)
        .unwrap_or_else(|e| panic!("open {} as wav: {e}", path.display()));
    let spec = reader.spec();
    let interleaved: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().map(|s| s.unwrap_or(0.0)).collect(),
        hound::SampleFormat::Int => {
            let full_scale = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.unwrap_or(0) as f32 / full_scale)
                .collect()
        }
    };
    let channels = spec.channels.max(1) as usize;
    if channels == 1 {
        return (interleaved, spec.sample_rate);
    }
    let mono = interleaved
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect();
    (mono, spec.sample_rate)
}

/// The chroma the tonic-evidence gate should see for a set of windows: their sum, which is what a
/// single pass over the same span would have produced. Summing rather than taking the newest keeps
/// the A/B about windowed *consensus* instead of quietly also testing a thinner gate input.
fn summed_chroma(
    windows: &[app_lib::audio_models::WindowAnalysisResult],
    by_window_end: &BTreeMap<u64, Vec<f32>>,
) -> Option<Vec<f32>> {
    let mut total: Option<Vec<f32>> = None;
    for window in windows {
        let Some(chroma) = by_window_end.get(&window.window_end_ms) else {
            continue;
        };
        match total.as_mut() {
            None => total = Some(chroma.clone()),
            Some(sum) if sum.len() == chroma.len() => {
                for (slot, value) in sum.iter_mut().zip(chroma) {
                    *slot += value;
                }
            }
            Some(_) => {}
        }
    }
    total
}

/// Replay a clip as if it were arriving live, one analysis cycle per hop.
///
/// `enough_audio` is passed as `true` throughout on purpose. In `aggregate_results` the buffer gate
/// only ever *adds* doubt (`ambiguous = !enough_audio || ...`), so a replay that leaves it open
/// records what the audio itself supports, and `lock_point` can then apply any candidate gate to
/// the same recording. Replaying once per candidate would multiply analyzer runs by the size of
/// the sweep and measure nothing extra.
///
/// `history_from_seconds` is the one thing that cannot be applied afterwards, because the vote is
/// an input to the verdict rather than a filter on it: a reading that enters `history` changes
/// `dominant_share` for every cycle that follows. 0 is what ships — every fresh cycle votes,
/// including the ones the engine itself labels `warming_up`.
fn replay(
    detector: &LibKeyFinderDetector,
    samples: &[f32],
    rate: u32,
    pass: Pass,
    max_seconds: usize,
    history_from_seconds: usize,
) -> Vec<Cycle> {
    let inputs = analyze_cycles(detector, samples, rate, pass, max_seconds);
    decide_cycles(&inputs, pass, HISTORY_HORIZON, history_from_seconds, CaptureMode::ProcessLoopback, PRIMARY_KEY_REPEAT_MIN)
}

/// One cycle's analyzer output, kept so that a sweep over consensus settings costs nothing.
///
/// The CLI's verdict does not depend on the history it is later voted into, so re-running the
/// analyzer once per arm of a sweep buys an identical answer at full price — and the analyzer is
/// all of the cost. Splitting the replay here turned a five-value sweep over the real corpus from
/// eighty minutes into sixteen.
struct CycleInput {
    heard_seconds: usize,
    windows: Vec<app_lib::audio_models::WindowAnalysisResult>,
    start_ms: u64,
    endpoint: u64,
    chroma: Option<Vec<f32>>,
    /// The same analyzer over only the newest [`TAIL_SECONDS`] of the same buffer, when the buffer
    /// is long enough for that to be a different question. `None` while it is not.
    ///
    /// This is the cheapest second opinion the engine can have. Every pass over a growing buffer
    /// is a nested span of every other, so they cannot contradict each other — which is why the
    /// consensus collapsed to a single winner and the window vote stopped carrying information.
    /// A trailing window is not nested: it is a different stretch of music, and asking whether the
    /// whole buffer still agrees with its own recent past is one extra classification of a
    /// chromagram the CLI has already computed.
    tail: Option<(u8, &'static str)>,
}

/// How much of the newest audio the second opinion reads.
///
/// Thirty, from `exp_recent_agreement.py` over 396 clips out of fold. The separation grows with
/// the tail while the share of clips it can speak about shrinks, and 30s is where the disagreeing
/// group is worst — right only 46.0% of the time against 67.8% for the agreeing group, which is
/// the whole point of the signal.
const TAIL_SECONDS: usize = 30;

/// The expensive half: one analyzer pass per hop.
fn analyze_cycles(
    detector: &LibKeyFinderDetector,
    samples: &[f32],
    rate: u32,
    pass: Pass,
    max_seconds: usize,
) -> Vec<CycleInput> {
    let mut inputs = Vec::new();
    let clip_seconds = samples.len() / rate as usize;
    let last_cycle = max_seconds.min(clip_seconds);
    let mut heard = ANALYSIS_WINDOW_SECONDS;
    while heard <= last_cycle {
        let span = match pass {
            Pass::WholeBuffer | Pass::WholeBufferDatedHonestly => {
                heard.min(MAX_ANALYSIS_SPAN_SECONDS)
            }
            Pass::NewestWindow => ANALYSIS_WINDOW_SECONDS,
        };
        let start_seconds = heard - span;
        let slice = &samples[start_seconds * rate as usize..heard * rate as usize];
        let mut output = detector
            .analyze(slice, rate, ANALYSIS_WINDOW_SECONDS, ANALYSIS_HOP_SECONDS)
            .unwrap_or_else(|e| panic!("analyze {start_seconds}s..{heard}s: {e}"));
        if pass == Pass::WholeBufferDatedHonestly {
            // The one change under test: say how much audio the verdict came from. The detector
            // hardcodes a 12-second span, so every pass over a buffer that has not started
            // sliding yet looks to `accept` like the pass before it.
            for window in &mut output.windows {
                window.window_end_ms = span as u64 * 1000;
            }
        }
        // The second opinion, when there is enough buffer for it to be about different audio.
        // A tail as long as the span would be the same pass at full price.
        let tail = (span > TAIL_SECONDS)
            .then(|| {
                let from = heard - TAIL_SECONDS;
                detector
                    .analyze(
                        &samples[from * rate as usize..heard * rate as usize],
                        rate,
                        ANALYSIS_WINDOW_SECONDS,
                        ANALYSIS_HOP_SECONDS,
                    )
                    .ok()
                    .and_then(|out| {
                        let window = out.windows.first()?;
                        pitch_class(&window.key).zip(normalize_mode(&window.scale))
                    })
            })
            .flatten();
        inputs.push(CycleInput {
            heard_seconds: heard,
            windows: output.windows,
            start_ms: start_seconds as u64 * 1000,
            endpoint: heard as u64 * rate as u64,
            chroma: output.chroma,
            tail,
        });
        heard += ANALYSIS_HOP_SECONDS;
    }
    inputs
}

/// Every clip's cycles, analysed once, across the machine's cores.
///
/// The analyzer runs are the only expensive part of any sweep in this file — everything after
/// them is arithmetic over `CycleInput`, and one pass over a 273-clip corpus is thirteen CLI
/// invocations per clip. Serially that is twenty minutes for numbers that then take a second to
/// compute, which is enough friction to make a sweep something you do once and squint at rather
/// than re-run after every change. `LibKeyFinderDetector::analyze` takes `&self` and keeps no
/// per-call state beyond its scratch wav, which is named per call.
fn analyse_corpus(
    detector: &LibKeyFinderDetector,
    root: &Path,
    clips: &[CorpusClip],
    pass: Pass,
    max_seconds: usize,
) -> Vec<((u8, &'static str), Vec<CycleInput>)> {
    let next = AtomicUsize::new(0);
    let done: Mutex<Vec<(usize, (u8, &'static str), Vec<CycleInput>)>> = Mutex::new(Vec::new());
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(clips.len().max(1));
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, Ordering::Relaxed);
                let Some(clip) = clips.get(index) else { break };
                let expected = (
                    pitch_class(&clip.expected_key).expect("key"),
                    normalize_mode(&clip.expected_mode).expect("mode"),
                );
                let (samples, rate) = read_mono_f32(&root.join(&clip.path));
                let cycles = analyze_cycles(detector, &samples, rate, pass, max_seconds);
                done.lock().expect("collect").push((index, expected, cycles));
            });
        }
    });
    let mut rows = done.into_inner().expect("collect");
    rows.sort_by_key(|(index, _, _)| *index);
    rows.into_iter()
        .map(|(_, expected, cycles)| (expected, cycles))
        .collect()
}

/// The cheap half: the evidence buffer and the consensus, under a given vote policy.
///
/// `history_horizon` is how many past cycles get a vote. It is `HISTORY_HORIZON` in the engine, and
/// the reason it is a parameter here is that it sets how long a *correction* takes to take hold:
/// `aggregate_results` scores `temporal_stability` as the share of the window agreeing with the
/// current answer, so after the engine changes its mind the old readings keep voting against it
/// for the whole horizon.
fn decide_cycles(
    inputs: &[CycleInput],
    pass: Pass,
    history_horizon: usize,
    history_from_seconds: usize,
    capture_mode: CaptureMode,
    repeat_min: usize,
) -> Vec<Cycle> {
    let mut evidence = AnalysisEvidence::default();
    let mut history: VecDeque<String> = VecDeque::new();
    let mut chroma_by_window_end: BTreeMap<u64, Vec<f32>> = BTreeMap::new();
    let mut cycles = Vec::new();

    // The engine loop's own state, mirrored. A clean replay is never disrupted and never goes
    // silent, so `capture_stable` and `session_stable` simply come true after their streaks; the
    // rest are real state machines and are run as such.
    let cooldown_cycles = (CONTRADICTION_COOLDOWN_MS as usize)
        .div_ceil(ANALYSIS_HOP_SECONDS * 1000)
        .max(1);
    let mut capture_stable_streak = 0usize;
    let mut session_stable_streak = 0usize;
    let mut primary_key_repeat_streak = 0usize;
    let mut last_primary_key_choice: Option<String> = None;
    let mut contradiction_active = false;
    let mut contradiction_clean_streak = 0usize;
    let mut cooldown_left = 0usize;

    for input in inputs {
        if let Some(chroma) = input.chroma.as_ref() {
            for window in &input.windows {
                chroma_by_window_end.insert(window.window_end_ms + input.start_ms, chroma.clone());
            }
        }
        let fresh = evidence.accept(&input.windows, input.start_ms, input.endpoint);
        // Exactly what the loop hands the consensus: the recent evidence when this cycle added
        // to it, and the bare pass when it did not.
        let windows = if fresh {
            evidence.recent()
        } else {
            input.windows.clone()
        };
        let chroma = match pass {
            Pass::WholeBuffer | Pass::WholeBufferDatedHonestly => input.chroma.clone(),
            Pass::NewestWindow => summed_chroma(&windows, &chroma_by_window_end),
        };

        let payload = decide_from_windows(
            &windows,
            CaptureMode::ProcessLoopback,
            None,
            true,
            &history,
            chroma.as_deref(),
        );
        if fresh && input.heard_seconds >= history_from_seconds {
            if let (Some(key), Some(scale)) = (&payload.primary_key, &payload.primary_scale) {
                while history.len() >= history_horizon.max(1) {
                    history.pop_front();
                }
                history.push_back(format!("{key}:{scale}"));
            }
        }

        // --- the engine loop, from the vote to the gate ---
        let ev = window_evidence(&windows);
        if ev.contradiction_burst {
            contradiction_active = true;
            contradiction_clean_streak = 0;
            cooldown_left = cooldown_cycles;
        } else if contradiction_active {
            contradiction_clean_streak += 1;
            if contradiction_clean_streak >= CONTRADICTION_CLEAR_CLEAN_CYCLES {
                contradiction_active = false;
                contradiction_clean_streak = 0;
            }
        } else {
            contradiction_clean_streak = 0;
        }
        if fresh {
            match (payload.primary_key.as_deref(), payload.primary_scale.as_deref()) {
                (Some(k), Some(s)) => {
                    let choice = format!("{k}:{s}");
                    if last_primary_key_choice.as_deref() == Some(choice.as_str()) {
                        primary_key_repeat_streak += 1;
                    } else {
                        primary_key_repeat_streak = 1;
                        last_primary_key_choice = Some(choice);
                    }
                }
                _ => {
                    primary_key_repeat_streak = 0;
                    last_primary_key_choice = None;
                }
            }
        }
        capture_stable_streak += 1;
        session_stable_streak += 1;
        let gate = live_gate(
            &LiveGateInputs {
                capture_mode,
                capture_stable: capture_stable_streak >= CAPTURE_STABLE_MIN_CYCLES,
                session_stable: session_stable_streak >= SESSION_STABLE_MIN_CYCLES,
                repeated_key: primary_key_repeat_streak >= repeat_min,
                recent_disruption: false,
                contradiction_active,
                contradiction_cooldown: cooldown_left > 0,
                recent_silence: false,
                relative_pair_unresolved: relative_pair_unresolved_in(&payload),
                primary_key_repeat_streak,
                dominant_margin: dominant_margin_of(&payload),
                window_dominance: ev.window_dominance,
                window_distinct_tonics: ev.window_distinct_tonics,
                evidence_calibrated: evidence_is_calibrated(&windows, &payload),
            },
            &contradiction_metrics_from_history(&history),
        );
        cooldown_left = cooldown_left.saturating_sub(1);
        // The gate only runs on a payload the consensus already called `likely_key`.
        let gate_allowed = !payload.ambiguous && gate.allowed;
        let gate_block = if payload.ambiguous {
            // `aggregate_results` already names which of its eleven terms fired; bucketing that is
            // better than re-deriving it, and it is the field the engine logs anyway.
            Some(match payload.reason.as_deref().unwrap_or("none") {
                r if r.starts_with("relative_pair_ambiguity") => "relative_pair_ambiguity",
                r if r.starts_with("contradiction_detected_multiple_tonics") => "multiple_tonics",
                r if r.starts_with("contradiction_detected_major_minor_conflict") => "major_minor_conflict",
                r if r.starts_with("contradiction_detected_profile_disagreement") => "profile_disagreement",
                r if r.starts_with("contradiction_detected_mixed_tonic_family") => "mixed_tonic_family",
                "weak_absolute_tonal_fit" => "weak_absolute_tonal_fit",
                "top_candidate_too_close_to_alternative" => "separation_too_close",
                "unstable_across_windows" => "unstable_across_windows",
                "low_confidence" => "low_confidence",
                _ => "ambiguous_unnamed",
            })
        } else if gate.allowed {
            None
        } else if primary_key_repeat_streak < repeat_min {
            Some("repeated_key")
        } else if contradiction_active {
            Some("contradiction_active")
        } else if ev.contradiction_burst {
            Some("contradiction_burst")
        } else if relative_pair_unresolved_in(&payload) {
            Some("relative_pair_unresolved")
        } else if !gate.stable_tonics {
            Some("stable_tonics")
        } else if !gate.recent_windows_clean {
            Some("recent_windows_clean")
        } else if !gate.endpoint_conservative_ok {
            Some("endpoint_conservative_ok")
        } else if !gate.margin_ok {
            Some("margin_ok")
        } else {
            Some("other")
        };

        let got = payload
            .primary_key
            .as_deref()
            .and_then(pitch_class)
            .zip(payload.primary_scale.as_deref().and_then(normalize_mode));
        cycles.push(Cycle {
            heard_seconds: input.heard_seconds,
            got,
            settled: !payload.ambiguous,
            fresh,
            gate_allowed,
            gate_block,
            tail_agrees: input.tail.map(|tail| got == Some(tail)),
        });
    }
    cycles
}

/// Every cycle at which the app would be showing an unhedged key, under a candidate buffer gate
/// and streak length.
///
/// Mirrors the engine loop: the streak counts fresh cycles that the consensus settled, resets when
/// a cycle is unsettled, and a cycle before the buffer gate opens is `warming_up` and therefore
/// never settled.
fn unhedged_cycles(cycles: &[Cycle], required_seconds: usize, min_streak: usize) -> Vec<Cycle> {
    let mut streak = 0usize;
    let mut open = Vec::new();
    for cycle in cycles {
        let settled = cycle.settled && cycle.heard_seconds >= required_seconds;
        if cycle.fresh && settled {
            streak += 1;
        } else if !settled {
            streak = 0;
        }
        if settled && streak >= min_streak {
            open.push(cycle.clone());
        }
    }
    open
}

/// When the app would first stop hedging.
fn lock_point(cycles: &[Cycle], required_seconds: usize, min_streak: usize) -> Option<Cycle> {
    unhedged_cycles(cycles, required_seconds, min_streak)
        .into_iter()
        .next()
}

struct ClipReplay {
    expected: (u8, &'static str),
    by_pass: Vec<(Pass, Vec<Cycle>)>,
}

/// The streak lengths worth reporting, always including the one that ships.
fn streak_sweep() -> Vec<usize> {
    let mut streaks = vec![2usize, 3, 4, 6, MIN_READY_STREAK];
    streaks.sort_unstable();
    streaks.dedup();
    streaks
}

fn median(mut values: Vec<usize>) -> Option<usize> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    Some(values[values.len() / 2])
}

#[test]
#[ignore = "replays every clip through the engine cycle by cycle; run with --ignored --nocapture"]
fn key_engine_time_to_answer_curve() {
    let cli = require_cli();
    let (root, clips, label) = load_corpus();
    let detector = LibKeyFinderDetector::from_executable(cli);
    let passes = [
        Pass::WholeBuffer,
        Pass::WholeBufferDatedHonestly,
        Pass::NewestWindow,
    ];
    // Long enough to cover the shipped gate plus its streak; the corpus clips run past this.
    let max_seconds = 60usize;

    let mut replays: Vec<ClipReplay> = Vec::new();
    for clip in &clips {
        let wav = root.join(&clip.path);
        assert!(wav.exists(), "clip {} missing at {}", clip.id, wav.display());
        let expected = (
            pitch_class(&clip.expected_key)
                .unwrap_or_else(|| panic!("clip {} has an unreadable key", clip.id)),
            normalize_mode(&clip.expected_mode)
                .unwrap_or_else(|| panic!("clip {} has an unreadable mode", clip.id)),
        );
        let (samples, rate) = read_mono_f32(&wav);
        let by_pass = passes
            .iter()
            .map(|pass| (*pass, replay(&detector, &samples, rate, *pass, max_seconds, 0)))
            .collect();
        replays.push(ClipReplay { expected, by_pass });
    }

    println!(
        "\n=== time to an answer: {} clips ({label}) ===",
        replays.len()
    );
    println!(
        "shipped gate: {}s of buffer, then {} agreeing analyses {}s apart",
        REQUIRED_AUDIO_SECONDS as usize, MIN_READY_STREAK, ANALYSIS_HOP_SECONDS
    );

    // --- what the engine holds after N seconds, whether or not it is willing to say so ---
    for (pass_index, pass) in passes.iter().enumerate() {
        println!("\n-- {} --", pass.label());
        println!(
            "{:>7}  {:>9}  {:>7}  {:>8}  {:>12}",
            "heard", "note-set", "tonic", "settled", "same as 60s"
        );
        let mut heard = ANALYSIS_WINDOW_SECONDS;
        while heard <= max_seconds {
            let mut tally = Tally::default();
            let mut settled = 0usize;
            let mut matches_final = 0usize;
            let mut counted = 0usize;
            for clip in &replays {
                let cycles = &clip.by_pass[pass_index].1;
                let Some(cycle) = cycles.iter().find(|c| c.heard_seconds == heard) else {
                    continue;
                };
                counted += 1;
                tally.record(&classify(clip.expected, cycle.got));
                if cycle.settled {
                    settled += 1;
                }
                if cycles.last().map(|last| last.got) == Some(cycle.got) {
                    matches_final += 1;
                }
            }
            if counted > 0 {
                println!(
                    "{:>6}s  {:>8.1}%  {:>6.1}%  {:>7.1}%  {:>11.1}%",
                    heard,
                    tally.note_set_pct(),
                    tally.tonic_pct(),
                    pct(settled, counted),
                    pct(matches_final, counted)
                );
            }
            heard += ANALYSIS_HOP_SECONDS;
        }
    }

    // --- and what each candidate gate would cost or save ---
    for (pass_index, pass) in passes.iter().enumerate() {
        println!("\n-- when the hedging stops: {} --", pass.label());
        println!(
            "{:>5} {:>7}  {:>9}  {:>8}  {:>7}  {:>11}",
            "buffer", "streak", "locked", "median", "tonic", "wrong roots"
        );
        // 4 and 8 are below anything the synthetic corpus could justify, but real music dwells on
        // its tonic and carries a melody, so the fast end has to be measured rather than assumed.
        let mut buffer_gates = vec![4usize, 8, 12, 20, 24, 28, 36, REQUIRED_AUDIO_SECONDS as usize];
        buffer_gates.sort_unstable();
        buffer_gates.dedup();
        for required in buffer_gates {
            for streak in streak_sweep() {
                let mut locked_at: Vec<usize> = Vec::new();
                let mut tally = Tally::default();
                let mut wrong_roots = 0usize;
                for clip in &replays {
                    let Some(lock) = lock_point(&clip.by_pass[pass_index].1, required, streak)
                    else {
                        continue;
                    };
                    locked_at.push(lock.heard_seconds);
                    let outcome = classify(clip.expected, lock.got);
                    if outcome != Outcome::Exact {
                        wrong_roots += 1;
                    }
                    tally.record(&outcome);
                }
                println!(
                    "{:>4}s  {:>6}  {:>4}/{:<4}  {:>7}  {:>6.1}%  {:>11}",
                    required,
                    streak,
                    locked_at.len(),
                    replays.len(),
                    median(locked_at)
                        .map(|m| format!("{m}s"))
                        .unwrap_or_else(|| "—".to_string()),
                    tally.tonic_pct(),
                    wrong_roots
                );
            }
        }
    }

    // A replay that never settles anywhere is a broken harness reporting a tidy zero, not a slow
    // engine. Some clip, under some setting, has to reach an answer.
    let ever_settles = replays
        .iter()
        .any(|clip| clip.by_pass.iter().any(|(_, cycles)| cycles.iter().any(|c| c.settled)));
    assert!(
        ever_settles,
        "no clip settled at any buffer length under either pass — the replay is not running the \
         engine"
    );

    // --- what the streak is for, on clips that do not hold still ---
    if let Some((moving_root, moving_clips)) = load_nonstationary_corpus() {
        let first = &moving_clips[0];
        println!(
            "\n-- riding out a middle section in another key: {} clips --",
            moving_clips.len()
        );
        println!(
            "each song leaves home for {:.0}s..{:.0}s and comes back; `decoy shown` counts the \
             clips that assert the excursion at some point, which is only a fault after the song \
             is home again",
            first.decoy_from_seconds, first.decoy_to_seconds
        );
        println!(
            "{:>5} {:>7}  {:>9}  {:>8}  {:>6}  {:>6}  {:>6}  {:>13}",
            "buffer", "streak", "locked", "median", "home", "decoy", "other", "decoy shown"
        );

        let mut moving: Vec<((u8, &'static str), Option<(u8, &'static str)>, Vec<Cycle>)> =
            Vec::new();
        for clip in &moving_clips {
            let wav = moving_root.join(&clip.path);
            assert!(wav.exists(), "clip {} missing at {}", clip.id, wav.display());
            let expected = (
                pitch_class(&clip.expected_key)
                    .unwrap_or_else(|| panic!("clip {} has an unreadable key", clip.id)),
                normalize_mode(&clip.expected_mode)
                    .unwrap_or_else(|| panic!("clip {} has an unreadable mode", clip.id)),
            );
            let decoy = clip
                .decoy_key
                .as_deref()
                .and_then(pitch_class)
                .zip(clip.decoy_mode.as_deref().and_then(normalize_mode));
            let (samples, rate) = read_mono_f32(&wav);
            let cycles = replay(&detector, &samples, rate, Pass::WholeBuffer, max_seconds, 0);
            moving.push((expected, decoy, cycles));
        }

        let mut fooled_anywhere = Vec::new();
        // The same fast gates as the accuracy sweep: a shorter buffer is only worth shipping if
        // it also refuses to assert the excursion these clips modulate into.
        let mut buffer_gates = vec![4usize, 8, 12, 20, REQUIRED_AUDIO_SECONDS as usize];
        buffer_gates.sort_unstable();
        buffer_gates.dedup();
        for required in buffer_gates {
            for streak in streak_sweep() {
                let (mut home, mut decoyed, mut other) = (0usize, 0usize, 0usize);
                let mut locked_at = Vec::new();
                let mut decoy_shown = 0usize;
                for (expected, decoy, cycles) in &moving {
                    let open = unhedged_cycles(cycles, required, streak);
                    // Not just the first lock: any moment the readout drops the hedge while
                    // naming the key the song left is a moment the player is reading the wrong
                    // neck with no warning on it.
                    if decoy.is_some() && open.iter().any(|c| c.got == *decoy) {
                        decoy_shown += 1;
                        fooled_anywhere.push((required, streak));
                    }
                    let Some(lock) = open.first() else {
                        continue;
                    };
                    locked_at.push(lock.heard_seconds);
                    if lock.got == Some(*expected) {
                        home += 1;
                    } else if lock.got.is_some() && lock.got == *decoy {
                        decoyed += 1;
                    } else {
                        other += 1;
                    }
                }
                println!(
                    "{:>4}s  {:>6}  {:>4}/{:<4}  {:>7}  {:>6}  {:>6}  {:>6}  {:>13}",
                    required,
                    streak,
                    locked_at.len(),
                    moving.len(),
                    median(locked_at)
                        .map(|m| format!("{m}s"))
                        .unwrap_or_else(|| "—".to_string()),
                    home,
                    decoyed,
                    other,
                    decoy_shown
                );
            }
        }
        if fooled_anywhere.is_empty() {
            println!("  no setting locked the key the song left");
        }

        // What this used to assert, and why it cannot any more.
        //
        // The old claim was that the shipped setting *never* asserts the excursion. It held for
        // one session and the reason was a defect: `window_winners_from_results` bucketed every
        // pass over a growing buffer together and kept the loudest-fitting one, which froze the
        // readout on an early reading — and these clips all start at home, so the frozen reading
        // was always right. The consensus was not resisting the modulation, it was ignoring all
        // the audio after the first twelve seconds. Fixing that was worth +6.6 note-set and +7.7
        // tonic on real recordings ("The readout was quoting a twelve-second guess").
        //
        // The claim was also too strong on its own terms. From 18s to 35s these clips *are* in the
        // excursion, and the analyzer says so — asserting it there is right, not a fault. What is
        // a fault is still saying it once the song is home, and that is what is measured now: the
        // engine reads the whole sixty-second buffer, so a seventeen-second excursion keeps its
        // pull for about twenty seconds after it ends. At the last cycle 21 of 24 clips are home
        // again and 3 are not.
        //
        // A floor rather than a claim, in the same spirit as `slips_asserted` above. Lower it only
        // with a measurement that says the lag is genuinely shorter.
        let still_wrong_at_the_end = moving
            .iter()
            .filter(|(_, decoy, cycles)| {
                decoy.is_some()
                    && unhedged_cycles(cycles, REQUIRED_AUDIO_SECONDS as usize, MIN_READY_STREAK)
                        .last()
                        .map(|c| c.got == *decoy)
                        .unwrap_or(false)
            })
            .count();
        assert!(
            still_wrong_at_the_end <= 3,
            "{still_wrong_at_the_end} of {} clips were still asserting the excursion at the end of \
             the clip, twenty-five seconds after the song came home — the buffer is holding a \
             passage it should have grown out of",
            moving.len()
        );
    }

    // The shipped pass reports its own span; the honest pass overwrites the span with the one it
    // knows is right. Identical results mean the detector is dating its verdicts correctly. They
    // diverged before `LibKeyFinderDetector::analyze` stopped claiming a fixed twelve seconds,
    // and the cost of that divergence was every second between 40 and 70.
    let shipped = position_of(&passes, Pass::WholeBuffer);
    let honest = position_of(&passes, Pass::WholeBufferDatedHonestly);
    for clip in &replays {
        let shipped_cycles = &clip.by_pass[shipped].1;
        let honest_cycles = &clip.by_pass[honest].1;
        for (a, b) in shipped_cycles.iter().zip(honest_cycles) {
            assert_eq!(
                (a.got, a.settled, a.fresh),
                (b.got, b.settled, b.fresh),
                "at {}s the shipped pass and an honestly dated one disagree — the detector is \
                 reporting a span it did not analyze, so consecutive passes read as repeats",
                a.heard_seconds
            );
        }
    }
}

fn position_of(passes: &[Pass], wanted: Pass) -> usize {
    passes
        .iter()
        .position(|p| *p == wanted)
        .expect("pass is in the list under test")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_pairs_share_a_note_set_and_are_scored_as_a_slip() {
        // E minor and G major are the same seven notes. That is the whole reason for two scores.
        assert_eq!(note_set(4, "minor"), note_set(7, "major"));
        assert_eq!(
            classify((4, "minor"), Some((7, "major"))),
            Outcome::RelativeSlip
        );
    }

    #[test]
    fn a_different_note_set_is_not_forgiven() {
        // E minor vs A minor differ by one note (F# vs F) and that is a wrong diagram.
        assert_ne!(note_set(4, "minor"), note_set(9, "minor"));
        assert_eq!(
            classify((9, "minor"), Some((4, "minor"))),
            Outcome::WrongNotes
        );
    }

    #[test]
    fn enharmonic_spellings_are_the_same_key() {
        assert_eq!(pitch_class("F#"), pitch_class("Gb"));
        assert_eq!(classify((6, "major"), Some((6, "major"))), Outcome::Exact);
    }

    #[test]
    fn note_set_accuracy_counts_slips_and_tonic_accuracy_does_not() {
        let mut tally = Tally::default();
        tally.record(&Outcome::Exact);
        tally.record(&Outcome::RelativeSlip);
        tally.record(&Outcome::WrongNotes);
        tally.record(&Outcome::NoAnswer);
        assert_eq!(tally.note_set_pct(), 50.0);
        assert_eq!(tally.tonic_pct(), 25.0);
    }
}

/// What a guess made before the buffer gate opens costs the rest of the song.
///
/// From a live capture of "You've Got a Friend in Me" (E♭ major, 127 seconds). At 15.2 seconds of
/// buffer — `enoughAudio: false`, state `warming_up` — the engine read A# major, the dominant.
/// From 55 seconds on it read E♭ on every single cycle and was never wrong again. It never
/// settled: `dominantShare` crawled 0.643 -> 0.750 against a `MIN_DOMINANCE_SHARE` of 0.84, and
/// the song ended while the player was still looking at "hedged, 35%".
///
/// The mechanism is one missing condition. `key_engine.rs` writes `decision_history` under
/// `fresh_analysis` alone, so a reading the engine has just labelled "not enough audio yet" votes
/// in the consensus exactly like any other — and `HISTORY_HORIZON` of 16 needs about 72 seconds to
/// flush it. Showing an early reading on the neck is a deliberate policy (`keyFusion.ts`: nothing
/// is ever withheld). Letting it *vote* is not written down anywhere.
///
/// This measures the fix rather than assuming it: the same clips replayed with the vote open from
/// 12s (shipped) and from `REQUIRED_AUDIO_SECONDS`, scored on whether the app ever stops hedging,
/// how long that takes, and whether the answer it locks is right.
///
/// **Measured and rejected, 273 real clips:**
///
/// ```text
///                                       locks   median lock   locked right  right but mute
/// every fresh cycle votes (shipped)       58%          32s            75%             18%
/// the vote waits for the buffer gate      57%          36s            76%             19%
/// ```
///
/// Four seconds slower for nothing. The reasoning was wrong about the capture that prompted it:
/// only the first of the three A# readings was below the gate, and by the time the block mattered
/// the 16-cycle horizon reached back only to *after* the gate opened, so no sub-gate vote was left
/// in the window at all. What actually blocks is in the next test — the horizon itself.
///
/// Kept because the run is 32 minutes and the numbers above are the reason not to spend them
/// again. What it does establish is the size of the real problem: **58% of clips ever stop
/// hedging, and on 18% the engine holds the right answer while the readout stays unsure.**
#[test]
#[ignore = "replays every clip twice; run with --ignored --nocapture"]
fn an_early_guess_must_not_vote_in_the_consensus() {
    let cli = require_cli();
    let (root, clips, label) = load_corpus();
    let detector = LibKeyFinderDetector::from_executable(cli);
    let max_seconds = 60usize;
    let arms = [
        ("every fresh cycle votes (shipped)", 0usize),
        ("the vote waits for the buffer gate", REQUIRED_AUDIO_SECONDS as usize),
    ];

    println!("\n=== an early guess in the vote: {} clips ({label}) ===", clips.len());
    println!(
        "{:<38}{:>7}{:>14}{:>15}{:>16}",
        "", "locks", "median lock", "locked right", "right but mute"
    );

    for (arm_label, history_from) in arms {
        let mut locked = 0usize;
        let mut locked_right = 0usize;
        let mut lock_times = Vec::new();
        // The failure the capture showed: the engine holds the right answer at the end and the
        // readout never stops hedging, so the player is told "unsure" about a correct diagram.
        let mut right_but_never_locked = 0usize;

        for clip in &clips {
            let wav = root.join(&clip.path);
            let expected = (
                pitch_class(&clip.expected_key).expect("key"),
                normalize_mode(&clip.expected_mode).expect("mode"),
            );
            let (samples, rate) = read_mono_f32(&wav);
            let cycles = replay(
                &detector,
                &samples,
                rate,
                Pass::WholeBuffer,
                max_seconds,
                history_from,
            );
            let lock = lock_point(&cycles, REQUIRED_AUDIO_SECONDS as usize, MIN_READY_STREAK);
            let final_right = cycles.last().and_then(|c| c.got) == Some(expected);
            match lock {
                Some(cycle) => {
                    locked += 1;
                    lock_times.push(cycle.heard_seconds);
                    if cycle.got == Some(expected) {
                        locked_right += 1;
                    }
                }
                None if final_right => right_but_never_locked += 1,
                None => {}
            }
        }

        let n = clips.len().max(1);
        println!(
            "{:<38}{:>6.0}%{:>13}{:>14.0}%{:>15.0}%",
            arm_label,
            100.0 * locked as f64 / n as f64,
            median(lock_times).map(|s| format!("{s}s")).unwrap_or_else(|| "—".into()),
            if locked > 0 { 100.0 * locked_right as f64 / locked as f64 } else { 0.0 },
            100.0 * right_but_never_locked as f64 / n as f64,
        );
    }
}

/// How long a correction takes to take hold, and what shortening that costs.
///
/// The previous test rules out the warm-up vote. What is left is the horizon itself.
/// `aggregate_results` scores `temporal_stability` as the share of `decision_history` agreeing
/// with the current answer, and the engine loop gates on `cm.dominant_share` the same way — so
/// when the engine changes its mind, every reading from before the change votes against the new
/// one until it ages out. At `HISTORY_HORIZON` of 16 and a cycle every ~4.5 seconds that is a
/// **72-second** tail, and the two gates downstream want 14/16 and 15/16 of the window:
///
/// ```text
///   stable_tonics            dominant_share >= 0.84  ->  14/16,  2 stale votes tolerated
///   endpoint_conservative_ok dominant_share >= 0.88  ->  15/16,  1 stale vote  tolerated
/// ```
///
/// On the capture that prompted this — "You've Got a Friend in Me", 127 seconds — the engine read
/// the dominant for 55 seconds, corrected to E♭, and then needed another 68 seconds of unbroken
/// agreement to be allowed to say so. It had 72. `repeatedKey=true` appeared at 21:45:42, meaning
/// `primary_key_repeat_streak` already knew the engine had settled, while the window count kept
/// overruling it for another minute.
///
/// A count over a fixed window cannot tell "D# and A# alternating" from "A# and then D#". Those
/// are different situations and only one of them is instability. This sweeps the horizon to find
/// what that conflation is worth, and prices it against the clips that exist to punish a short
/// memory: the non-stationary ones, whose middle section is in another key the readout must never
/// lock onto.
///
/// **What it measured: nothing, and that is the result.** Every horizon from 16 down to 1 scores
/// identically on both corpora —
///
/// ```text
///   273 real clips        locks 58%   median 32s   locked right 75%   right but mute 18%
///   72 synthetic clips    locks 31%   median 60s   locked right 100%  right but mute 39%
/// ```
///
/// — including the degenerate horizon of 1, where `temporal_stability` can only be 0.0 or 1.0.
/// A knob that scores the same at 1 as at 16 is not connected to the outcome: `ambiguous` in
/// `aggregate_results` is a wide OR and something else in it binds first, so the vote horizon
/// never gets to decide anything here.
///
/// **The gate that actually blocked the capture is not in this harness at all.** `stable_tonics`
/// and `endpoint_conservative_ok` live in the engine loop in `key_engine.rs`, downstream of
/// `decide_from_windows`, and they read `cm.dominant_share` — which is where the 14/16 and 15/16
/// arithmetic bites. `replay` stops at `decide_from_windows`, so no test in this repository
/// exercises the gate that decides whether a player is ever shown a confident key. That is the
/// reason this defect survived, and building that harness is the next piece of work, not another
/// sweep against this one.
///
/// The numbers above are still worth having for what they do say: **58% of real clips ever stop
/// hedging, and on 18% the engine holds the right answer while the readout stays unsure.**
#[test]
#[ignore = "sweeps the vote horizon over every clip; run with --ignored --nocapture"]
fn how_long_a_correction_takes_to_take_hold() {
    let cli = require_cli();
    let (root, clips, label) = load_corpus();
    let detector = LibKeyFinderDetector::from_executable(cli);
    let max_seconds = 60usize;
    // 1 is in the sweep as a plumbing check, not a candidate: at a horizon of one, every cycle
    // either fully agrees with its predecessor or fully disagrees, so `temporal_stability` can
    // only be 0.0 or 1.0. If that scores the same as 16, the knob is not connected to anything.
    let horizons = [HISTORY_HORIZON, 8, 4, 2, 1];

    // Analysed once; every horizon re-runs only the consensus over the same evidence.
    let mut analysed: Vec<((u8, &'static str), Vec<CycleInput>)> = Vec::new();
    for clip in &clips {
        let wav = root.join(&clip.path);
        let expected = (
            pitch_class(&clip.expected_key).expect("key"),
            normalize_mode(&clip.expected_mode).expect("mode"),
        );
        let (samples, rate) = read_mono_f32(&wav);
        analysed.push((
            expected,
            analyze_cycles(&detector, &samples, rate, Pass::WholeBuffer, max_seconds),
        ));
    }

    println!("\n=== how long a correction takes to take hold: {} clips ({label}) ===", analysed.len());
    println!(
        "{:>9}{:>9}{:>14}{:>15}{:>17}",
        "horizon", "locks", "median lock", "locked right", "right but mute"
    );
    for horizon in horizons {
        let (mut locked, mut locked_right, mut mute) = (0usize, 0usize, 0usize);
        let mut lock_times = Vec::new();
        for (expected, inputs) in &analysed {
            let cycles = decide_cycles(inputs, Pass::WholeBuffer, horizon, 0, CaptureMode::ProcessLoopback, PRIMARY_KEY_REPEAT_MIN);
            match lock_point(&cycles, REQUIRED_AUDIO_SECONDS as usize, MIN_READY_STREAK) {
                Some(cycle) => {
                    locked += 1;
                    lock_times.push(cycle.heard_seconds);
                    if cycle.got == Some(*expected) {
                        locked_right += 1;
                    }
                }
                None if cycles.last().and_then(|c| c.got) == Some(*expected) => mute += 1,
                None => {}
            }
        }
        let n = analysed.len().max(1);
        println!(
            "{:>9}{:>8.0}%{:>13}{:>14.0}%{:>16.0}%",
            horizon,
            100.0 * locked as f64 / n as f64,
            median(lock_times).map(|s| format!("{s}s")).unwrap_or_else(|| "—".into()),
            if locked > 0 { 100.0 * locked_right as f64 / locked as f64 } else { 0.0 },
            100.0 * mute as f64 / n as f64,
        );
    }

    // --- the cost: clips whose middle section is in another key ---
    let Some((decoy_root, decoy_clips)) = load_nonstationary_corpus() else {
        println!("\n(no non-stationary clips here; run without GSV_REAL_CORPUS for the cost side)");
        return;
    };
    let mut moving = Vec::new();
    for clip in &decoy_clips {
        let wav = decoy_root.join(&clip.path);
        let expected = (
            pitch_class(&clip.expected_key).expect("key"),
            normalize_mode(&clip.expected_mode).expect("mode"),
        );
        let decoy = clip
            .decoy_key
            .as_deref()
            .and_then(pitch_class)
            .zip(clip.decoy_mode.as_deref().and_then(normalize_mode));
        let (samples, rate) = read_mono_f32(&wav);
        moving.push((
            expected,
            decoy,
            analyze_cycles(&detector, &samples, rate, Pass::WholeBuffer, max_seconds),
        ));
    }

    println!(
        "\n-- what a shorter memory costs: {} clips that change key partway through --",
        moving.len()
    );
    println!("{:>9}{:>14}{:>13}{:>16}", "horizon", "locked home", "locked decoy", "decoy ever shown");
    for horizon in horizons {
        let (mut home, mut decoyed, mut shown) = (0usize, 0usize, 0usize);
        for (expected, decoy, inputs) in &moving {
            let cycles = decide_cycles(inputs, Pass::WholeBuffer, horizon, 0, CaptureMode::ProcessLoopback, PRIMARY_KEY_REPEAT_MIN);
            let open = unhedged_cycles(&cycles, REQUIRED_AUDIO_SECONDS as usize, MIN_READY_STREAK);
            if decoy.is_some() && open.iter().any(|c| c.got == *decoy) {
                shown += 1;
            }
            if let Some(lock) = open.first() {
                if lock.got == Some(*expected) {
                    home += 1;
                } else if lock.got.is_some() && lock.got == *decoy {
                    decoyed += 1;
                }
            }
        }
        let n = moving.len().max(1);
        println!(
            "{:>9}{:>13.0}%{:>12.0}%{:>15.0}%",
            horizon,
            100.0 * home as f64 / n as f64,
            100.0 * decoyed as f64 / n as f64,
            100.0 * shown as f64 / n as f64,
        );
    }
}

/// What the gate the player actually feels refuses, and why.
///
/// This is the harness that did not exist. `live_gate` — thirteen conditions that decide whether
/// the readout may stop hedging — sat inline in the engine's async loop, so every measurement in
/// this file stopped one step short of it and a defect lived there behind numbers that all looked
/// fine. `decide_cycles` now mirrors the loop state around it: the contradiction machine, the
/// cooldown, the repeat streak, the window vote.
///
/// Both capture modes, because they are not the same gate. `endpoint_conservative_ok` applies only
/// to `EndpointLoopback` and asks for `dominant_share >= 0.88` — 15 of a 16-cycle window — where
/// `ProcessLoopback` asks for nothing. On Linux the app runs on endpoint capture.
#[test]
#[ignore = "replays every clip through the live gate; run with --ignored --nocapture"]
fn what_the_live_gate_refuses() {
    let cli = require_cli();
    let (root, clips, label) = load_corpus();
    let detector = LibKeyFinderDetector::from_executable(cli);
    let analysed = analyse_corpus(&detector, &root, &clips, Pass::WholeBuffer, 60);

    println!("\n=== what the live gate refuses: {} clips ({label}) ===", analysed.len());
    // `PRIMARY_KEY_REPEAT_MIN` is swept because it is the honest version of a signal the engine
    // used to get by accident. Until `window_disagreement_metrics` keyed windows by their whole
    // span, a mind-change anywhere in the retained evidence read as `profile_disagreement` and
    // blocked the assert outright. That was a real caution wearing a wrong name; the streak is
    // the same idea said properly, and this is what it is worth.
    for (mode, repeat_min) in [CaptureMode::ProcessLoopback, CaptureMode::EndpointLoopback]
        .into_iter()
        .flat_map(|m| [5usize, 7, 9, 11, 13, 16].into_iter().map(move |r| (m, r)))
    {
        let arm = gate_arm(&analysed, mode, repeat_min, HISTORY_HORIZON);
        let n = analysed.len().max(1);
        println!(
            "\n-- {:?}, repeat_min {} --\n  {}",
            mode,
            repeat_min,
            arm.summary(n)
        );
        let mut ranked: Vec<_> = arm.blockers.into_iter().collect();
        ranked.sort_by_key(|(_, count)| std::cmp::Reverse(*count));
        println!("  what stops it at the last cycle:");
        for (reason, count) in ranked {
            println!("    {reason:<26}{count:>4}  ({:.0}%)", 100.0 * count as f64 / n as f64);
        }
    }

    // --- and the horizon, which only became a live knob once the winner was fixed ---
    //
    // Swept once before and found inert at every value from 16 to 1. That measurement is
    // withdrawn: it was taken while `window_winners_from_results` grouped every pass over the
    // growing buffer into one bucket and kept the highest-strength one, which froze the consensus
    // on a single early reading — so `decision_history` was uniform *by construction* and a knob
    // over its contents could not move anything. With the winner superseded by span the history
    // holds what the analyzer actually said, `stable_tonics` went from blocking 5% of clips to
    // 13%, and the width of that window is now the thing deciding them.
    println!("\n-- the vote horizon, at the shipped repeat_min {PRIMARY_KEY_REPEAT_MIN} --");
    println!(
        "{:>18}{:>9}{:>9}{:>10}{:>25}{:>17}",
        "capture", "horizon", "asserts", "median", "right when it asserts", "right but mute"
    );
    for mode in [CaptureMode::ProcessLoopback, CaptureMode::EndpointLoopback] {
        for horizon in [HISTORY_HORIZON, 12, 9, 6, 4, 2] {
            let arm = gate_arm(&analysed, mode, PRIMARY_KEY_REPEAT_MIN, horizon);
            let n = analysed.len().max(1);
            println!(
                "{:>18}{:>9}{:>8.0}%{:>10}{:>24.0}%{:>16.0}%",
                format!("{mode:?}"),
                horizon,
                100.0 * arm.asserts as f64 / n as f64,
                median(arm.first_assert.clone())
                    .map(|s| format!("{s}s"))
                    .unwrap_or_else(|| "—".into()),
                if arm.asserts > 0 {
                    100.0 * arm.asserts_right as f64 / arm.asserts as f64
                } else {
                    0.0
                },
                100.0 * arm.mute_but_right as f64 / n as f64,
            );
        }
    }
}

/// One arm of the live-gate sweep: what the readout did to every clip under one setting.
struct GateArm {
    asserts: usize,
    asserts_right: usize,
    /// Asserts whose *note set* is right, which includes the relative slips. Split out because the
    /// two kinds of wrong assert cost the player completely different things: a slip draws the
    /// identical diagram and only misplaces the root marker, while a wrong note set puts every
    /// bend outside the key. Scoring them as one number prices a hedge against the wrong thing.
    asserts_notes_right: usize,
    mute_but_right: usize,
    first_assert: Vec<usize>,
    /// Only the clips it asserted *correctly*. A setting that fires early on the clips it gets
    /// wrong flatters `first_assert`, and the player's wait is the wait for a right answer.
    first_right_assert: Vec<usize>,
    first_notes_right_assert: Vec<usize>,
    blockers: BTreeMap<&'static str, usize>,
}

impl GateArm {
    fn summary(&self, n: usize) -> String {
        format!(
            "asserts {:.0}%   median {}   right when it asserts {:.0}%   right but mute {:.0}%",
            100.0 * self.asserts as f64 / n as f64,
            median(self.first_assert.clone())
                .map(|s| format!("{s}s"))
                .unwrap_or_else(|| "—".into()),
            if self.asserts > 0 {
                100.0 * self.asserts_right as f64 / self.asserts as f64
            } else {
                0.0
            },
            100.0 * self.mute_but_right as f64 / n as f64,
        )
    }
}

/// Every clip's cycles under one consensus setting, ready to be scored against any gate.
///
/// Split out from `gate_arm` because `repeat_min` and the horizon are the only two of the four
/// knobs that change what the consensus *decides*; `REQUIRED_AUDIO_SECONDS` and
/// `MIN_READY_STREAK` are read off the cycles afterwards. Sweeping all four jointly without this
/// split re-runs the consensus twenty-five times for twenty-five identical answers.
fn gate_cycles(
    analysed: &[((u8, &'static str), Vec<CycleInput>)],
    mode: CaptureMode,
    repeat_min: usize,
    horizon: usize,
) -> Vec<((u8, &'static str), Vec<Cycle>)> {
    analysed
        .iter()
        .map(|(expected, inputs)| {
            (
                *expected,
                decide_cycles(inputs, Pass::WholeBuffer, horizon, 0, mode, repeat_min),
            )
        })
        .collect()
}

/// What the readout did to every clip, under a candidate buffer gate and ready streak.
fn score_gate(
    decided: &[((u8, &'static str), Vec<Cycle>)],
    required_seconds: usize,
    min_streak: usize,
) -> GateArm {
    score_gate_with(decided, required_seconds, min_streak, false)
}

/// As `score_gate`, optionally also requiring that the buffer agrees with its own recent tail.
fn score_gate_with(
    decided: &[((u8, &'static str), Vec<Cycle>)],
    required_seconds: usize,
    min_streak: usize,
    need_tail_agreement: bool,
) -> GateArm {
    let (mut asserts, mut asserts_right, mut mute_but_right) = (0usize, 0usize, 0usize);
    let mut asserts_notes_right = 0usize;
    let mut first_assert = Vec::new();
    let mut first_right_assert = Vec::new();
    let mut first_notes_right_assert = Vec::new();
    let mut blockers: BTreeMap<&'static str, usize> = BTreeMap::new();
    for (expected, cycles) in decided {
        // The shipped gate plus the buffer gate and the streak, which is what the player waits
        // through: `min_streak` consecutive fresh cycles the gate allowed.
        let mut streak = 0usize;
        let mut opened: Option<&Cycle> = None;
        for cycle in cycles {
            // `None` — a buffer too short for a tail to be different audio — is not a refusal.
            // Treating it as one would only re-time the gate, which is what this is an
            // alternative to.
            let tail_ok = !need_tail_agreement || cycle.tail_agrees != Some(false);
            let ok = cycle.gate_allowed && tail_ok && cycle.heard_seconds >= required_seconds;
            if cycle.fresh && ok {
                streak += 1;
            } else if !ok {
                streak = 0;
            }
            if ok && streak >= min_streak && opened.is_none() {
                opened = Some(cycle);
            }
        }
        // Where the last cycle stood, so a clip that never opens still says what stopped it.
        if let Some(last) = cycles
            .iter()
            .filter(|c| c.heard_seconds >= required_seconds)
            .next_back()
        {
            if let Some(reason) = last.gate_block {
                *blockers.entry(reason).or_insert(0) += 1;
            }
        }
        match opened {
            Some(cycle) => {
                asserts += 1;
                first_assert.push(cycle.heard_seconds);
                match classify(*expected, cycle.got) {
                    Outcome::Exact => {
                        asserts_right += 1;
                        asserts_notes_right += 1;
                        first_right_assert.push(cycle.heard_seconds);
                        first_notes_right_assert.push(cycle.heard_seconds);
                    }
                    Outcome::RelativeSlip => {
                        asserts_notes_right += 1;
                        first_notes_right_assert.push(cycle.heard_seconds);
                    }
                    Outcome::WrongNotes | Outcome::NoAnswer => {}
                }
            }
            None if cycles.last().and_then(|c| c.got) == Some(*expected) => mute_but_right += 1,
            None => {}
        }
    }
    GateArm {
        asserts,
        asserts_right,
        asserts_notes_right,
        mute_but_right,
        first_assert,
        first_right_assert,
        first_notes_right_assert,
        blockers,
    }
}

fn gate_arm(
    analysed: &[((u8, &'static str), Vec<CycleInput>)],
    mode: CaptureMode,
    repeat_min: usize,
    horizon: usize,
) -> GateArm {
    score_gate(
        &gate_cycles(analysed, mode, repeat_min, horizon),
        REQUIRED_AUDIO_SECONDS as usize,
        MIN_READY_STREAK,
    )
}

/// The two streaks the player waits through, measured together for the first time.
///
/// `PRIMARY_KEY_REPEAT_MIN` (7) counts identical primaries inside `live_gate`; `MIN_READY_STREAK`
/// (4) then counts cycles the gate allowed, outside it. Both are "the same answer N times
/// running", counted twice in different places, and each was chosen against a sweep that held
/// the other fixed — 7 in `what_the_live_gate_refuses`, 4 in `key_engine_time_to_answer_curve`.
/// Stacked they cost eleven cycles, forty-four seconds, which is most of what the player waits.
///
/// `REQUIRED_AUDIO_SECONDS` is in the sweep because the comment above it is no longer true.
/// Twenty was "where the accuracy curve flattens", and that curve was withdrawn in
/// `KEY_ACCURACY_BASELINE.md`: measured out of fold, twenty seconds is the engine's *worst*
/// operating point, not its knee.
///
/// The column that matters is `correct` — the share of all clips that get a confident answer that
/// is also right. `asserts` counts wrong ones too, and a setting can buy assert rate by asserting
/// rubbish sooner.
#[test]
#[ignore = "replays every clip through the gate at every setting; run with --ignored --nocapture"]
fn what_the_two_streaks_cost_together() {
    let cli = require_cli();
    let (root, clips, label) = load_corpus();
    let detector = LibKeyFinderDetector::from_executable(cli);
    let analysed = analyse_corpus(&detector, &root, &clips, Pass::WholeBuffer, 60);
    let n = analysed.len().max(1);

    println!("\n=== the two streaks, jointly: {n} clips ({label}) ===");
    println!(
        "  columns: asserts = confidently answered at all; notes = of those, the seven notes are \n\
         \x20 right (exact + relative slip, the diagram a player solos over); exact = root and mode \n\
         \x20 too; wrong = a different note set asserted confidently, which is the one that hurts. \n\
         \x20 median is over the asserts whose notes are right — a setting cannot buy it by being \n\
         \x20 fast and wrong."
    );
    for mode in [CaptureMode::EndpointLoopback, CaptureMode::ProcessLoopback] {
        let mut rows: Vec<(usize, usize, usize, GateArm)> = Vec::new();
        for repeat_min in [1usize, 2, 3, 4, 5, 7, 9] {
            let decided = gate_cycles(&analysed, mode, repeat_min, HISTORY_HORIZON);
            for buffer_gate in [12usize, 16, 20, 24, 28] {
                for min_streak in [1usize, 2, 3, 4, 6] {
                    rows.push((
                        buffer_gate,
                        repeat_min,
                        min_streak,
                        score_gate(&decided, buffer_gate, min_streak),
                    ));
                }
            }
        }

        println!("\n-- {mode:?} --");
        let header = || {
            println!(
                "{:>7}{:>8}{:>8}{:>10}{:>8}{:>8}{:>8}{:>9}{:>12}",
                "buffer",
                "repeat",
                "streak",
                "asserts",
                "notes",
                "exact",
                "wrong",
                "median",
                "mute+right"
            )
        };
        let medians = |arm: &GateArm| {
            let show = |v: Vec<usize>| {
                median(v)
                    .map(|s| format!("{s}s"))
                    .unwrap_or_else(|| "—".into())
            };
            (
                show(arm.first_notes_right_assert.clone()),
                show(arm.first_right_assert.clone()),
            )
        };
        let line = |gate: usize, repeat: usize, streak: usize, arm: &GateArm, mark: &str| {
            let (notes_median, exact_median) = medians(arm);
            println!(
                "{:>7}{:>8}{:>8}{:>9.0}%{:>7.0}%{:>7.0}%{:>7.0}%{:>9}{:>11.0}%  {}",
                format!("{gate}s"),
                repeat,
                streak,
                100.0 * arm.asserts as f64 / n as f64,
                100.0 * arm.asserts_notes_right as f64 / n as f64,
                100.0 * arm.asserts_right as f64 / n as f64,
                100.0 * (arm.asserts - arm.asserts_notes_right) as f64 / n as f64,
                if notes_median == exact_median {
                    notes_median
                } else {
                    format!("{notes_median}/{exact_median}")
                },
                100.0 * arm.mute_but_right as f64 / n as f64,
                mark,
            );
        };
        let shipped = (
            REQUIRED_AUDIO_SECONDS as usize,
            PRIMARY_KEY_REPEAT_MIN,
            MIN_READY_STREAK,
        );

        // The shipped point first, so every row below reads as a move away from something.
        header();
        for (gate, repeat, streak, arm) in &rows {
            if (*gate, *repeat, *streak) == shipped {
                line(*gate, *repeat, *streak, arm, "<- ships");
            }
        }

        // The whole surface at the shipped buffer gate, because the frontier below reports the
        // corners and the shape between them is what says whether a choice sits on a cliff.
        println!("\n  every (repeat, streak) at the shipped {}s buffer gate:", shipped.0);
        header();
        for (gate, repeat, streak, arm) in &rows {
            if *gate == shipped.0 {
                line(*gate, *repeat, *streak, arm, "");
            }
        }

        // The frontier: nothing else answers sooner, more often, *and* asserts fewer wrong note
        // sets. Three objectives rather than two — the two-objective version of this sweep put
        // every corner of the grid on the frontier, because asserting instantly always raises the
        // count of right asserts and the cost never appeared in the comparison.
        println!("\n  the frontier — nothing else is faster, righter and no more often wrong:");
        header();
        let key = |arm: &GateArm| {
            (
                median(arm.first_notes_right_assert.clone()).unwrap_or(usize::MAX),
                arm.asserts_notes_right,
                arm.asserts - arm.asserts_notes_right,
            )
        };
        let mut frontier: Vec<&(usize, usize, usize, GateArm)> = rows
            .iter()
            .filter(|(_, _, _, arm)| arm.asserts_notes_right > 0)
            .filter(|(_, _, _, arm)| {
                let (secs, right, wrong) = key(arm);
                !rows.iter().any(|(_, _, _, other)| {
                    let (o_secs, o_right, o_wrong) = key(other);
                    let no_worse = o_secs <= secs && o_right >= right && o_wrong <= wrong;
                    let better = o_secs < secs || o_right > right || o_wrong < wrong;
                    no_worse && better
                })
            })
            .collect();
        frontier.sort_by_key(|(_, _, _, arm)| key(arm));
        for (gate, repeat, streak, arm) in frontier {
            line(*gate, *repeat, *streak, arm, "");
        }
    }
}

/// Counting cycles is confidence made of time. This is confidence made of evidence.
///
/// The gate decides when to stop hedging by waiting for the same answer six times running, which
/// costs every player thirty-two seconds whether or not the reading was ever in doubt. It waits
/// because it has nothing else: every pass over a growing buffer is a nested span of every other
/// one, so they cannot contradict each other, and since the winner became "the pass that heard
/// most" the window vote has exactly one entry.
///
/// A trailing window is not nested. `exp_recent_agreement.py` prices it out of fold over 396
/// clips: when the whole buffer still agrees with its newest thirty seconds — 87.6% of clips — the
/// answer is right 67.8% of the time, and when it does not it is right **46.0%**. That is a
/// sharper separation than any amount of repetition produces, and it costs one classification of
/// a chromagram the analyzer has already built.
///
/// This asks whether the two are interchangeable: can the wait come down if the readout has to
/// agree with its own recent past instead of with its own recent history?
#[test]
#[ignore = "two analyzer passes per cycle over every clip; run with --ignored --nocapture"]
fn what_a_second_look_at_the_recent_audio_is_worth() {
    let cli = require_cli();
    let (root, clips, label) = load_corpus();
    let detector = LibKeyFinderDetector::from_executable(cli);
    let analysed = analyse_corpus(&detector, &root, &clips, Pass::WholeBuffer, 60);
    let n = analysed.len().max(1);

    println!(
        "\n=== waiting versus looking again: {n} clips ({label}) ===\n\
         the tail is the newest {TAIL_SECONDS}s of the same buffer, classified by the same profile"
    );
    println!(
        "{:>8}{:>8}{:>8}{:>10}{:>8}{:>8}{:>8}{:>9}{:>12}",
        "tail?", "repeat", "streak", "asserts", "notes", "exact", "wrong", "median", "mute+right"
    );
    for mode in [CaptureMode::EndpointLoopback] {
        for (repeat_min, min_streak) in [(4usize, 3usize), (3, 2), (2, 2), (1, 1)] {
            let decided = gate_cycles(&analysed, mode, repeat_min, HISTORY_HORIZON);
            for need_tail in [false, true] {
                let arm = score_gate_with(
                    &decided,
                    REQUIRED_AUDIO_SECONDS as usize,
                    min_streak,
                    need_tail,
                );
                println!(
                    "{:>8}{:>8}{:>8}{:>9.0}%{:>7.0}%{:>7.0}%{:>7.0}%{:>9}{:>11.0}%{}",
                    if need_tail { "agrees" } else { "—" },
                    repeat_min,
                    min_streak,
                    100.0 * arm.asserts as f64 / n as f64,
                    100.0 * arm.asserts_notes_right as f64 / n as f64,
                    100.0 * arm.asserts_right as f64 / n as f64,
                    100.0 * (arm.asserts - arm.asserts_notes_right) as f64 / n as f64,
                    median(arm.first_notes_right_assert.clone())
                        .map(|s| format!("{s}s"))
                        .unwrap_or_else(|| "—".into()),
                    100.0 * arm.mute_but_right as f64 / n as f64,
                    if (repeat_min, min_streak)
                        == (PRIMARY_KEY_REPEAT_MIN, MIN_READY_STREAK)
                        && !need_tail
                    {
                        "  <- ships"
                    } else {
                        ""
                    },
                );
            }
        }
    }

    // What the signal is on its own, so the table above can be read as "did the gate use it".
    let (mut agree, mut agree_right, mut differ, mut differ_right) = (0usize, 0, 0usize, 0);
    for (expected, inputs) in &analysed {
        let Some(last) = inputs.last() else { continue };
        let Some(tail) = last.tail else { continue };
        let whole = last
            .windows
            .first()
            .and_then(|w| pitch_class(&w.key).zip(normalize_mode(&w.scale)));
        let right = whole == Some(*expected);
        if whole == Some(tail) {
            agree += 1;
            agree_right += usize::from(right);
        } else {
            differ += 1;
            differ_right += usize::from(right);
        }
    }
    println!(
        "\n  at the last cycle: agree on {}/{} clips, right {:.0}% of the time; \
         differ on {}, right {:.0}%",
        agree,
        agree + differ,
        100.0 * agree_right as f64 / agree.max(1) as f64,
        differ,
        100.0 * differ_right as f64 / differ.max(1) as f64,
    );
}
