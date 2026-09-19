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

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

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
    let key = answer.key.as_deref()?;
    let pc = pitch_class(key)?;
    let mode = normalize_mode(answer.scale.as_deref()?)?;
    // The shipped gate, not a copy of it: this is the same function the engine runs.
    let claim = answer
        .chroma
        .as_deref()
        .and_then(|chroma| app_lib::key_engine::tonic_is_supported(chroma, key, mode))
        .map(|supported| {
            if supported {
                Claim::TonicAsserted
            } else {
                Claim::TonicOpen
            }
        });
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
        });
    }
    clips
}

#[test]
#[ignore = "needs the built libkeyfinder CLI and a generated corpus; run with --ignored --nocapture"]
fn key_engine_accuracy_scoreboard() {
    let cli = cli_path();
    assert!(
        cli.exists(),
        "libkeyfinder CLI not built at {}\n  build it with: ./sidecars/libkeyfinder_cli/build.sh",
        cli.display()
    );

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
        // The property the gate exists for. A wrong root asserted confidently is the one failure
        // the player cannot recover from without touching the screen.
        assert_eq!(
            slips_asserted, 0,
            "the app asserted {slips_asserted} root(s) it got wrong instead of showing them as open"
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
