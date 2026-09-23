//! How likely the note set on the neck is to be right — read off the evidence, not off the clock.
//!
//! # What this replaces
//!
//! The engine used to decide when to stop hedging by counting: the same answer four times running,
//! then every gate in `live_gate`. That is confidence made of time. Replayed through the engine
//! over 666 real clips (`tests/key_latency_replay.rs`), the readout turned confident at a median of
//! 24 seconds and was wrong about the notes 25.5% of the times it did — a clear song is as clear
//! at twelve seconds as at twenty-four, and a muddy one repeats its wrong answer just as
//! faithfully as a right one.
//!
//! # What it reads instead
//!
//! The analyzer's own scores. The decisive one is the **note-set margin**: the verdict's score minus
//! the best score of any key with a *different* set of notes. The runner-up is often the relative,
//! which draws the identical seven notes, so the plain top-two gap says nothing about whether the
//! diagram is right — this does. At twelve seconds it splits the corpus from 38% right (bottom
//! fifth) to 87% right (top fifth).
//!
//! Six features, a logistic fitted by `scripts/key-research/emit_confidence.py` and measured out
//! of fold by `exp_confidence.py` (6-fold by song, 4 partitions). Calibration, all spans pooled:
//!
//! ```text
//!   p 0.5-0.7   61.5% right      p 0.7-0.8   77.1%      p 0.8-0.9   85.0%      p 0.9+   88.4%
//! ```
//!
//! And as a policy — confident from the first reading at or above the threshold, on the hop grid:
//!
//! ```text
//!                            confident   median   right notes   wrong notes   precision
//!   four repeats + gates        63.7%      24s         47.4%         16.2%        74.5%
//!   p >= 0.75                   71.2%      12s         55.9%         15.3%        78.5%
//!   p >= 0.80                   57.4%      16s         47.6%          9.8%        83.0%
//! ```
//!
//! **The weights are a calibration of one analyzer build.** They read the profile's cosine scores,
//! and those change scale whenever what the chromagram is built from changes: separating the drums
//! out (2026-09-23) roughly doubled the typical gap between candidates, and the fit made on the
//! unseparated build then called 76% of clips confident at 74% precision instead of 63% at 79%.
//! Refit with `emit_confidence.py` against a span cache built by the binary that ships — the
//! numbers above are that refit, on the separated build.
//!
//! More clips told confidently, twelve seconds sooner, at the old gate's precision or better. A
//! gradient-boosted model and eight more features (chord evidence, the relative gap, score drift)
//! were measured against this and bought nothing out of fold, which is the pattern every model in
//! this engine has shown: on a corpus this size, parameters are the thing to be stingy with.

use crate::audio_models::WindowAnalysisResult;

pub const FEATURE_COUNT: usize = 6;

/// Agreement with earlier readings is counted up to this many of them.
pub const RUN_CAP: usize = 6;

/// The span feature is clamped here: the corpus holds about forty seconds of music per clip, so
/// the fit has never seen a longer buffer and should not be asked to extrapolate one.
pub const SPAN_FEATURE_MAX_SECONDS: f32 = 40.0;

/// A reading at or above this may be shown as settled.
///
/// Chosen where the policy matched the old gate's coverage (63% of clips against 64%) rather than
/// where it maximises anything, so the change was a like-for-like trade: the same share of songs
/// told confidently, twelve seconds sooner, 79.3% right instead of 74.5%. Kept through the refit
/// to separated audio, where the same threshold covers 71% of clips at 78.5%.
pub const CONFIDENT_NOTE_SET_P: f32 = 0.75;

/// The weights, in the order `features` builds them, with the standardiser folded in.
///
/// Fitted on 12,305 readings from 666 clips of the span cache built by the separated analyzer.
const WEIGHTS: [f32; FEATURE_COUNT] = [
    20.112728, // note_set_margin
    2.037997,  // top_score
    -0.076931, // log_span
    0.327421,  // prev_same
    0.052666,  // run
    14.065217, // note_set_margin_x_log_span
];
const INTERCEPT: f32 = -2.399680;

/// What the model reads about one reading.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CalibrationInputs {
    pub note_set_margin: f32,
    pub top_score: f32,
    pub span_seconds: f32,
    /// How many of the readings immediately before this one named the same note set.
    pub run: usize,
}

fn features(inputs: &CalibrationInputs) -> [f32; FEATURE_COUNT] {
    let log_span = inputs.span_seconds.clamp(1.0, SPAN_FEATURE_MAX_SECONDS).ln();
    let run = inputs.run.min(RUN_CAP) as f32;
    [
        inputs.note_set_margin,
        inputs.top_score,
        log_span,
        if inputs.run > 0 { 1.0 } else { 0.0 },
        run,
        inputs.note_set_margin * log_span,
    ]
}

/// The probability that this reading's note set is the song's.
pub fn note_set_probability(inputs: &CalibrationInputs) -> f32 {
    let z = INTERCEPT
        + WEIGHTS
            .iter()
            .zip(features(inputs).iter())
            .map(|(w, x)| w * x)
            .sum::<f32>();
    1.0 / (1.0 + (-z).exp())
}

fn pitch_class(label: &str) -> Option<i32> {
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
    Some(pc.rem_euclid(12))
}

/// The major tonic of the note set a key draws, which is the same for a key and its relative.
fn note_set_id(key: &str, scale: &str) -> Option<i32> {
    let pc = pitch_class(key)?;
    match scale {
        "major" => Some(pc),
        "minor" => Some((pc + 3).rem_euclid(12)),
        _ => None,
    }
}

/// Do two keys draw the same seven notes? True for a key and itself or its relative.
pub fn same_note_set(key_a: &str, scale_a: &str, key_b: &str, scale_b: &str) -> bool {
    matches!(
        (note_set_id(key_a, scale_a), note_set_id(key_b, scale_b)),
        (Some(a), Some(b)) if a == b
    )
}

/// The readings before `newest`, newest first. One pass per hop, so consecutive entries here are
/// the consecutive readings the model was fitted on.
fn earlier_newest_first<'a>(
    results: &'a [WindowAnalysisResult],
    newest: &WindowAnalysisResult,
) -> impl Iterator<Item = &'a WindowAnalysisResult> {
    let mut earlier: Vec<&WindowAnalysisResult> = results
        .iter()
        .filter(|w| w.window_end_ms < newest.window_end_ms)
        .collect();
    earlier.sort_by(|a, b| b.window_end_ms.cmp(&a.window_end_ms));
    earlier.into_iter()
}

/// How many readings immediately before the newest one named exactly its key — not its relative.
///
/// Not a model input. It is what the neck needs to move between the two ends of one note set,
/// which the probability was never fitted to decide: it asks whether the seven notes are right,
/// and a key and its relative share all seven.
pub fn key_run(results: &[WindowAnalysisResult]) -> usize {
    let Some(newest) = results.iter().max_by_key(|w| w.window_end_ms) else {
        return 0;
    };
    earlier_newest_first(results, newest)
        .take_while(|w| w.key == newest.key && w.scale == newest.scale)
        .count()
}

/// The inputs for the newest reading in `results`, and the key it named.
///
/// `None` when that reading carries no margin — the analyzer sent no shortlist, or the backend is
/// not libkeyfinder — so the caller knows to fall back to the older gates rather than invent a
/// probability.
pub fn calibration_inputs(
    results: &[WindowAnalysisResult],
) -> Option<(CalibrationInputs, String, String)> {
    let newest = results.iter().max_by_key(|w| w.window_end_ms)?;
    let margin = newest.note_set_margin.filter(|m| m.is_finite())?;
    let top_score = newest.top_score.filter(|s| s.is_finite())?;
    let span_seconds =
        newest.window_end_ms.saturating_sub(newest.window_start_ms) as f32 / 1000.0;
    let run = earlier_newest_first(results, newest)
        .take_while(|w| same_note_set(&w.key, &w.scale, &newest.key, &newest.scale))
        .count();
    Some((
        CalibrationInputs {
            note_set_margin: margin,
            top_score,
            span_seconds,
            run,
        },
        newest.key.clone(),
        newest.scale.clone(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reading(key: &str, scale: &str, end_s: u64, margin: Option<f32>) -> WindowAnalysisResult {
        serde_json::from_value(serde_json::json!({
            "profileType": "libkeyfinder",
            "key": key,
            "scale": scale,
            "displayName": format!("{key} {scale}"),
            "strength": 0.7,
            "firstToSecondRelativeStrength": 0.25,
            "noteSetMargin": margin,
            "topScore": 0.95,
            "windowStartMs": 0,
            "windowEndMs": end_s * 1000,
        }))
        .unwrap()
    }

    /// Pinned against `emit_confidence.py`'s own output for the same inputs, so a change to the
    /// feature order or the arithmetic here cannot pass silently.
    #[test]
    fn matches_the_fitted_model() {
        for (margin, top, span, run, expected) in [
            (0.002_f32, 0.95_f32, 8.0_f32, 0usize, 0.3717_f32),
            (0.015, 0.95, 12.0, 2, 0.6466),
            (0.030, 0.96, 20.0, 4, 0.8497),
            (0.008, 0.93, 16.0, 0, 0.4391),
            (-0.004, 0.95, 24.0, 1, 0.3573),
        ] {
            let p = note_set_probability(&CalibrationInputs {
                note_set_margin: margin,
                top_score: top,
                span_seconds: span,
                run,
            });
            assert!((p - expected).abs() < 5e-4, "{margin} {top} {span} {run}: {p} vs {expected}");
        }
    }

    #[test]
    fn a_wider_margin_is_never_less_likely() {
        let at = |margin: f32| {
            note_set_probability(&CalibrationInputs {
                note_set_margin: margin,
                top_score: 0.95,
                span_seconds: 12.0,
                run: 1,
            })
        };
        assert!(at(0.02) > at(0.01));
        assert!(at(0.01) > at(0.0));
    }

    #[test]
    fn a_relative_counts_as_the_same_notes() {
        assert!(same_note_set("C", "major", "A", "minor"));
        assert!(same_note_set("A", "minor", "C", "major"));
        assert!(same_note_set("D#", "major", "C", "minor"));
        assert!(same_note_set("Eb", "major", "C", "minor"));
        assert!(!same_note_set("C", "major", "G", "major"));
        assert!(!same_note_set("C", "major", "C", "minor"));
    }

    #[test]
    fn agreement_is_counted_back_from_the_newest_reading_until_it_breaks() {
        let results = vec![
            reading("G", "major", 4, Some(0.01)),
            reading("C", "major", 8, Some(0.01)),
            reading("A", "minor", 12, Some(0.01)),
            reading("C", "major", 16, Some(0.02)),
        ];
        let (inputs, key, scale) = calibration_inputs(&results).unwrap();
        assert_eq!((key.as_str(), scale.as_str()), ("C", "major"));
        // A minor and C major are one note set; G major is not, and it ends the run.
        assert_eq!(inputs.run, 2);
        assert_eq!(inputs.span_seconds, 16.0);
        assert!((inputs.note_set_margin - 0.02).abs() < 1e-6);
    }

    #[test]
    fn the_key_run_stops_at_the_relative_where_the_note_set_run_does_not() {
        let results = vec![
            reading("C", "major", 4, Some(0.01)),
            reading("A", "minor", 8, Some(0.01)),
            reading("C", "major", 12, Some(0.01)),
            reading("C", "major", 16, Some(0.02)),
        ];
        assert_eq!(key_run(&results), 1);
        assert_eq!(calibration_inputs(&results).unwrap().0.run, 3);
        assert_eq!(key_run(&results[..1]), 0);
        assert_eq!(key_run(&[]), 0);
    }

    #[test]
    fn no_margin_means_no_probability_rather_than_a_made_up_one() {
        assert!(calibration_inputs(&[reading("C", "major", 12, None)]).is_none());
        assert!(calibration_inputs(&[]).is_none());
    }
}
