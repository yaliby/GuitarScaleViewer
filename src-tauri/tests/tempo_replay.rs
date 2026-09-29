//! Replays recordings through the shipped live tempo tracker and scores it against their tempo.
//!
//! Not part of `cargo test`: it needs audio. Build a manifest with
//! `scripts/chord-research/tempo_manifest.py`, then
//!
//!     GSV_TEMPO_MANIFEST=/path/manifest.json cargo test --release --test tempo_replay -- --ignored --nocapture
//!
//! The manifest is a JSON list of `{"path": wav, "bpm": reference, "beats": [seconds...]}`. Each
//! file is fed in half-second packets, as the capture delivers them, and read after 8, 12, 20 and
//! 30 seconds of music: Acc1 is the reference tempo within 4%, Acc2 also counts its double, half,
//! triple and third. The beat pulse is scored where the deck would draw it: from each steady
//! reading, the next beats it predicts are matched to the reference beats within 70 ms.

use app_lib::tempo::{TempoTracker, FRAME_RATE};
use serde::Deserialize;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Deserialize)]
struct Item {
    path: String,
    bpm: f32,
    #[serde(default)]
    beats: Vec<f64>,
}

fn read_mono(path: &str) -> Option<(Vec<f32>, u32)> {
    let mut reader = hound::WavReader::open(path).ok()?;
    let spec = reader.spec();
    let channels = spec.channels as usize;
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().filter_map(Result::ok).collect(),
        hound::SampleFormat::Int => {
            let scale = 1.0 / (1u64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .filter_map(Result::ok)
                .map(|v| v as f32 * scale)
                .collect()
        }
    };
    let mono = samples
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect();
    Some((mono, spec.sample_rate))
}

fn within(found: f32, reference: f32, tolerance: f32) -> bool {
    (found - reference).abs() <= tolerance * reference
}

#[test]
#[ignore]
fn live_tempo_against_references() {
    let Ok(manifest) = std::env::var("GSV_TEMPO_MANIFEST") else {
        eprintln!("GSV_TEMPO_MANIFEST is not set; nothing to replay");
        return;
    };
    let items: Vec<Item> =
        serde_json::from_str(&std::fs::read_to_string(&manifest).expect("manifest")).expect("json");
    let checkpoints = [8.0f32, 12.0, 20.0, 30.0];
    let mut acc1 = vec![0usize; checkpoints.len()];
    let mut acc2 = vec![0usize; checkpoints.len()];
    let mut counted = vec![0usize; checkpoints.len()];
    let mut steady = vec![0usize; checkpoints.len()];
    let (mut hits, mut predicted, mut signed_error, mut matched) = (0usize, 0usize, 0.0f64, 0usize);
    for item in &items {
        let Some((audio, rate)) = read_mono(&item.path) else {
            eprintln!("skipped unreadable {}", item.path);
            continue;
        };
        let mut tracker = TempoTracker::new(rate);
        let packet = rate as usize / 2;
        let start = Instant::now();
        let mut next = 0;
        for (index, chunk) in audio.chunks(packet).enumerate() {
            let fed = ((index * packet + chunk.len()) as f64) / rate as f64;
            // Replay runs faster than real time, so the capture clock is synthetic: the packet
            // ending `fed` seconds into the audio was captured `fed` seconds after `start`.
            let at = start + Duration::from_secs_f64(fed);
            tracker.push(chunk, Some(at));
            let chosen = tracker.update();
            let reading = tracker.read_at(at, chosen.as_ref());
            // The tracker put the beat on the wall clock as "now minus how long ago it was heard",
            // with now = `at`; undo that to find it in the audio.
            let wall = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs_f64();
            if let (Some(last), Some(period)) = (reading.last_beat_at_ms, reading.period_ms) {
                if !item.beats.is_empty() {
                    let last_audio = last / 1000.0 - wall + fed;
                    let period = period as f64 / 1000.0;
                    // The beats the deck would pulse on before the next reading arrives.
                    let mut beat = last_audio + period;
                    while beat < fed + 0.5 {
                        if beat > fed {
                            predicted += 1;
                            let nearest = item
                                .beats
                                .iter()
                                .map(|b| beat - b)
                                .min_by(|a, b| a.abs().total_cmp(&b.abs()))
                                .unwrap_or(f64::MAX);
                            if nearest.abs() <= 0.07 {
                                hits += 1;
                            }
                            if nearest.abs() <= 0.15 {
                                signed_error += nearest;
                                matched += 1;
                            }
                        }
                        beat += period;
                    }
                }
            }
            while next < checkpoints.len() && fed >= checkpoints[next] as f64 {
                if (audio.len() as f64 / rate as f64) >= checkpoints[next] as f64 {
                    counted[next] += 1;
                    if let Some(bpm) = reading.bpm {
                        if within(bpm, item.bpm, 0.04) {
                            acc1[next] += 1;
                        }
                        if [1.0f32, 2.0, 0.5, 3.0, 1.0 / 3.0]
                            .iter()
                            .any(|m| within(bpm, item.bpm * m, 0.04))
                        {
                            acc2[next] += 1;
                        }
                    }
                    if reading.state == "steady" {
                        steady[next] += 1;
                    }
                }
                next += 1;
            }
        }
    }
    eprintln!("{} recordings, envelope at {FRAME_RATE} fps", items.len());
    for (i, seconds) in checkpoints.iter().enumerate() {
        let n = counted[i].max(1) as f32;
        eprintln!(
            "after {seconds:>4.0}s  n={:>4}  Acc1 {:5.1}%  Acc2 {:5.1}%  steady {:5.1}%",
            counted[i],
            100.0 * acc1[i] as f32 / n,
            100.0 * acc2[i] as f32 / n,
            100.0 * steady[i] as f32 / n,
        );
    }
    if predicted > 0 {
        eprintln!(
            "pulse: {predicted} predicted beats, {:.1}% within 70 ms; mean signed error {:+.1} ms over {matched} within 150 ms",
            100.0 * hits as f32 / predicted as f32,
            1000.0 * signed_error / matched.max(1) as f64
        );
    }
}
