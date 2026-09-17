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
    first_to_second_relative_strength: Option<f32>,
    candidates: Option<Vec<AnalyzeCandidate>>,
}

#[derive(Debug, Deserialize)]
struct AnalyzeCandidate {
    key: String,
    scale: String,
    score: f32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnalyzeResponse {
    windows: Vec<AnalyzeWindow>,
    error: Option<String>,
    backend_used: Option<String>,
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
        std::env::var("KEY_ANALYZER_PYTHON").unwrap_or_else(|_| "py".to_string()),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("sidecars/key_analyzer/key_analyzer.py"),
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

        // This integration test validates the real sidecar's evidence contract.
        // Native history, ambiguity, and readiness are exercised in key_engine
        // tests. Winner vote share is not a confidence or readiness measurement.
        let mut scores: HashMap<(String, String), f32> = HashMap::new();
        let mut winners = std::collections::HashSet::new();
        for window in &response.windows {
            assert!(window.strength.is_finite());
            winners.insert(window.key.clone());
            let Some(candidates)=window.candidates.as_ref() else {
                // Essentia and older sidecars retain the optional winner-only
                // protocol. Only the NumPy backend promises all 24 candidates.
                assert_ne!(response.backend_used.as_deref(),Some("numpy_fallback"),"{} numpy candidates missing",fixture.id);
                *scores.entry((window.key.to_ascii_uppercase(),window.scale.to_ascii_lowercase())).or_insert(0.0)+=window.strength;
                continue;
            };
            assert_eq!(candidates.len(),24,"{} must score every key",fixture.id);
            assert!(candidates.iter().all(|c|c.score.is_finite() && (0.0..=1.0).contains(&c.score)));
            assert!(candidates.windows(2).all(|c|c[0].score>=c[1].score));
            let distinct: std::collections::HashSet<_>=candidates.iter().map(|c|(&c.key,&c.scale)).collect();
            assert_eq!(distinct.len(),24);
            let top=&candidates[0];
            assert_eq!((&window.key,&window.scale),(&top.key,&top.scale));
            assert!((window.strength-top.score).abs()<1e-5);
            let margin=(top.score-candidates[1].score)/top.score.max(1e-9);
            let actual_margin=window.first_to_second_relative_strength.expect("candidate scores include their normalized margin");
            assert!((actual_margin-margin).abs()<1e-5);
            for candidate in candidates {
                let key=(candidate.key.to_ascii_uppercase(),candidate.scale.to_ascii_lowercase());
                *scores.entry(key).or_insert(0.0)+=candidate.score;
            }
        }
        // The generator deliberately cycles all twelve roots here. Its old
        // fixed-A-minor assertion was not a legitimate tonal reference label.
        if fixture.r#class=="contradiction_prone" {
            assert!(winners.len()>=3,"{} must retain competing tonic evidence",fixture.id);
            continue;
        }
        let mut ranked: Vec<_> = scores.into_iter().collect();
        ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        let top = ranked.first().expect("at least one vote");

        let expected_primary = (
            fixture.expected_primary.key.to_ascii_uppercase(),
            fixture.expected_primary.scale.to_ascii_lowercase(),
        );
        let top_key = top.0.clone();
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
    }
}
