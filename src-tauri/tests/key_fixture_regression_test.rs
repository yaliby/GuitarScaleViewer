use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureKey {
    key: String,
    scale: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureSpec {
    id: String,
    r#class: String,
    path: String,
    expected_primary: FixtureKey,
    acceptable_alternatives: Vec<FixtureKey>,
    expected_ambiguous: bool,
    expected_not_ready: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalyzeRequest {
    sample_rate_hz: u32,
    window_seconds: usize,
    hop_seconds: usize,
    profile_types: Vec<String>,
    samples_mono_f32: Vec<f32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnalyzeWindow {
    key: String,
    scale: String,
    strength: f32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnalyzeResponse {
    windows: Vec<AnalyzeWindow>,
    error: Option<String>,
}

fn resolve_sidecar_python() -> (String, PathBuf) {
    if let Ok(sidecar) = std::env::var("KEY_ANALYZER_SIDECAR") {
        let path = PathBuf::from(&sidecar);
        if sidecar.to_ascii_lowercase().ends_with(".py") {
            let py = std::env::var("KEY_ANALYZER_PYTHON").unwrap_or_else(|_| "py".to_string());
            return (py, path);
        }
    }
    (
        "py".to_string(),
        PathBuf::from("sidecars").join("key_analyzer").join("key_analyzer.py"),
    )
}

fn read_wav_mono(path: &Path) -> (u32, Vec<f32>) {
    let mut reader = hound::WavReader::open(path)
        .unwrap_or_else(|e| panic!("failed to open wav {}: {e}", path.display()));
    let spec = reader.spec();
    let sample_rate = spec.sample_rate;
    let channels = spec.channels.max(1) as usize;
    let mut mono = Vec::new();

    match spec.sample_format {
        hound::SampleFormat::Float => {
            let mut frame = Vec::with_capacity(channels);
            for sample in reader.samples::<f32>() {
                frame.push(sample.unwrap_or(0.0));
                if frame.len() == channels {
                    let avg = frame.iter().copied().sum::<f32>() / channels as f32;
                    mono.push(avg.clamp(-1.0, 1.0));
                    frame.clear();
                }
            }
        }
        hound::SampleFormat::Int => {
            let scale = (1_i64 << (spec.bits_per_sample.saturating_sub(1) as u32)) as f32;
            let mut frame = Vec::with_capacity(channels);
            for sample in reader.samples::<i32>() {
                frame.push((sample.unwrap_or(0) as f32 / scale).clamp(-1.0, 1.0));
                if frame.len() == channels {
                    let avg = frame.iter().copied().sum::<f32>() / channels as f32;
                    mono.push(avg.clamp(-1.0, 1.0));
                    frame.clear();
                }
            }
        }
    }
    (sample_rate, mono)
}

fn analyze_with_sidecar(sample_rate_hz: u32, samples: &[f32]) -> AnalyzeResponse {
    let (python_cmd, script) = resolve_sidecar_python();
    if !script.exists() {
        panic!("sidecar python script not found at {}", script.display());
    }
    let request = AnalyzeRequest {
        sample_rate_hz,
        window_seconds: 12,
        hop_seconds: 4,
        profile_types: vec![
            "bgate".to_string(),
            "krumhansl".to_string(),
            "shaath".to_string(),
            "temperley".to_string(),
            "edma".to_string(),
        ],
        samples_mono_f32: samples.to_vec(),
    };
    let payload = serde_json::to_vec(&request).expect("serialize request");
    let mut cmd = Command::new(&python_cmd);
    if python_cmd.eq_ignore_ascii_case("py") {
        cmd.arg("-3");
    }
    let mut child = cmd
        .arg(script)
        .arg("--analyze")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn sidecar");

    child
        .stdin
        .as_mut()
        .expect("stdin")
        .write_all(&payload)
        .expect("write request");
    let out = child.wait_with_output().expect("wait sidecar");
    if !out.status.success() {
        panic!(
            "sidecar failed with status {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        );
    }
    serde_json::from_slice(&out.stdout).expect("decode sidecar response")
}

#[test]
fn fixture_regression_with_real_sidecar() {
    if std::env::var("RUN_KEY_FIXTURES").ok().as_deref() != Some("1") {
        eprintln!("skipping key fixture regression (set RUN_KEY_FIXTURES=1 to run)");
        return;
    }

    let raw =
        std::fs::read_to_string("tests/key_fixtures_manifest.json").expect("read fixture manifest");
    let fixtures: Vec<FixtureSpec> = serde_json::from_str(&raw).expect("parse fixture manifest");
    assert!(!fixtures.is_empty(), "fixture manifest is empty");

    for fixture in fixtures {
        let wav_path = PathBuf::from(&fixture.path);
        assert!(
            wav_path.exists(),
            "fixture {} wav not found at {}",
            fixture.id,
            wav_path.display()
        );
        let (sample_rate_hz, mono) = read_wav_mono(&wav_path);
        let response = analyze_with_sidecar(sample_rate_hz, &mono);
        if let Some(error) = response.error {
            panic!("fixture {} sidecar error: {error}", fixture.id);
        }
        assert!(
            !response.windows.is_empty(),
            "fixture {} returned no analysis windows",
            fixture.id
        );

        let mut votes: HashMap<(String, String), f32> = HashMap::new();
        for w in response.windows {
            let key = (w.key.to_ascii_uppercase(), w.scale.to_ascii_lowercase());
            *votes.entry(key).or_insert(0.0) += w.strength.max(0.01);
        }
        let mut ranked: Vec<_> = votes.into_iter().collect();
        ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        let total: f32 = ranked.iter().map(|(_, s)| *s).sum::<f32>().max(1e-6);
        let top = ranked.first().expect("at least one vote");
        let top_share = top.1 / total;
        let second_share = ranked.get(1).map(|x| x.1 / total).unwrap_or(0.0);
        let ambiguous = top_share - second_share < 0.12;

        let expected_primary = (
            fixture.expected_primary.key.to_ascii_uppercase(),
            fixture.expected_primary.scale.to_ascii_lowercase(),
        );
        let top_key = top.0.clone();
        if fixture.r#class == "relative_ground_truth_minor_center" {
            assert_ne!(
                top_key,
                ("G".to_string(), "major".to_string()),
                "fixture {} must not promote relative major over ground-truth minor center",
                fixture.id
            );
        }
        let alternative_match = fixture.acceptable_alternatives.iter().any(|alt| {
            (
                alt.key.to_ascii_uppercase(),
                alt.scale.to_ascii_lowercase(),
            ) == top_key
        });

        assert!(
            top_key == expected_primary || alternative_match,
            "fixture {} top candidate {:?} not in expected set",
            fixture.id,
            top_key
        );
        assert_eq!(
            ambiguous, fixture.expected_ambiguous,
            "fixture {} ambiguous mismatch",
            fixture.id
        );

        if fixture.expected_not_ready.unwrap_or(false) {
            assert!(
                ambiguous || top_share < 0.7,
                "fixture {} expected not-ready style outcome",
                fixture.id
            );
        }
        if fixture.r#class == "dominant_bias_failure_case" {
            assert!(
                ambiguous || top_share < 0.78,
                "fixture {} should not present over-confident dominant-bias outcome",
                fixture.id
            );
        }
        if fixture.r#class == "easy_stable_major" || fixture.r#class == "easy_stable_minor" {
            assert!(
                !ambiguous && top_share >= 0.68,
                "fixture {} should remain clean/stable",
                fixture.id
            );
        }
    }
}
