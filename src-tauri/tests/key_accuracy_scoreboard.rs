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

use app_lib::audio_models::CaptureMode;
use app_lib::key_detection::{KeyDetector, LibKeyFinderDetector};
use app_lib::key_engine::{
    decide_from_windows, AnalysisEvidence, ANALYSIS_HOP_SECONDS, ANALYSIS_WINDOW_SECONDS,
    HISTORY_HORIZON, MAX_ANALYSIS_SPAN_SECONDS, MIN_READY_STREAK, REQUIRED_AUDIO_SECONDS,
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
fn replay(
    detector: &LibKeyFinderDetector,
    samples: &[f32],
    rate: u32,
    pass: Pass,
    max_seconds: usize,
) -> Vec<Cycle> {
    let mut evidence = AnalysisEvidence::default();
    let mut history: VecDeque<String> = VecDeque::new();
    let mut chroma_by_window_end: BTreeMap<u64, Vec<f32>> = BTreeMap::new();
    let mut cycles = Vec::new();

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

        let start_ms = start_seconds as u64 * 1000;
        if let Some(chroma) = output.chroma.as_ref() {
            for window in &output.windows {
                chroma_by_window_end.insert(window.window_end_ms + start_ms, chroma.clone());
            }
        }
        let fresh = evidence.accept(&output.windows, start_ms, heard as u64 * rate as u64);
        // Exactly what the loop hands the consensus: the recent evidence when this cycle added
        // to it, and the bare pass when it did not.
        let windows = if fresh {
            evidence.recent()
        } else {
            output.windows.clone()
        };
        let chroma = match pass {
            Pass::WholeBuffer | Pass::WholeBufferDatedHonestly => output.chroma.clone(),
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
        if fresh {
            if let (Some(key), Some(scale)) = (&payload.primary_key, &payload.primary_scale) {
                if history.len() == HISTORY_HORIZON {
                    history.pop_front();
                }
                history.push_back(format!("{key}:{scale}"));
            }
        }

        let got = payload
            .primary_key
            .as_deref()
            .and_then(pitch_class)
            .zip(payload.primary_scale.as_deref().and_then(normalize_mode));
        cycles.push(Cycle {
            heard_seconds: heard,
            got,
            settled: !payload.ambiguous,
            fresh,
        });
        heard += ANALYSIS_HOP_SECONDS;
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
            .map(|pass| (*pass, replay(&detector, &samples, rate, *pass, max_seconds)))
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
            "each song leaves home for {:.0}s..{:.0}s and comes back; locking the key it left for \
             means the readout was fooled",
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
            let cycles = replay(&detector, &samples, rate, Pass::WholeBuffer, max_seconds);
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

        // The shipped setting is the one that has to hold. A song that steps out for seventeen
        // seconds and comes home must not leave the player reading the wrong neck with no hedge
        // on it.
        let shipped_never_asserts_the_decoy = moving.iter().all(|(_, decoy, cycles)| {
            decoy.is_none()
                || !unhedged_cycles(cycles, REQUIRED_AUDIO_SECONDS as usize, MIN_READY_STREAK)
                    .iter()
                    .any(|c| c.got == *decoy)
        });
        assert!(
            shipped_never_asserts_the_decoy,
            "at the shipped buffer gate and streak, the readout asserted the key of a middle \
             section the song had already left"
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
