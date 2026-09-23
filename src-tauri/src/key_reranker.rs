//! Re-decide the key from the analyzer's shortlist, using chord evidence the profile cannot see.
//!
//! # Why there is a second opinion at all
//!
//! The tone profile in the libkeyfinder CLI matches a chromagram against an octave-resolved
//! template. That decides the note set well — about 75% on real recordings — and it decides the
//! *root* much less well, because the errors it makes are near misses: a key confused with its
//! relative, which has the identical seven notes, or with its subdominant or dominant, which share
//! six of seven. Measured over the real corpus, the true key sits in the profile's top three
//! candidates for **80.7%** of clips while the engine keeps only **65.5%** of them. A seventh of
//! every wrong answer is a key the classifier had already found and then ranked second.
//!
//! Nothing derived from that chromagram closes the gap, and three fitted models were built to
//! establish it: a free 24-way classifier over the same features lost by 2.6 points, an additive
//! correction to the profile's own score lost, and a re-ranker over time-resolved chroma came out
//! flat. They fail for one reason, and it is upstream of all of them — libKeyFinder's FFT frame is
//! a 3.7-second window, and what separates C major from G major is *which chord the music rests on
//! and resolves to*, which is averaged away before any classifier sees it.
//!
//! So the CLI reads the audio a second time at five times that time resolution
//! (`chord_frontend.cpp`) and hands over eighteen numbers per candidate. This applies the weights.
//!
//! # What it is allowed to do
//!
//! Only reorder the shortlist. It cannot invent a key the profile did not rank, and the profile's
//! own margin is one of its inputs — the fitted weight on `score_gap_to_leader` is the second
//! largest of the twenty-one, so it defers by default and overrules on evidence. An earlier version
//! of this idea, free to re-score all 24 candidates, spent its capacity learning to suppress the
//! twenty-one the profile had already ruled out and lost to doing nothing.
//!
//! Measured, 6-fold cross-validation split by song over the real corpus:
//!
//! ```text
//!   profile alone                     note-set 74.0%   tonic 65.4%
//!   + this re-ranker                  note-set 74.7%   tonic 67.1%
//! ```
//!
//! Those are the 396-clip / 337-song numbers. The same two rows read 74.9/63.5 and 77.3/68.6 on
//! the 226-clip corpus this was first fitted to, and the shrinking gap is the honest finding: the
//! chord tie-break is worth about a third of what the smaller corpus said it was.

/// How many of the profile's ranked candidates are considered. Matches `SHORTLIST_SIZE` in the
/// CLI, which is where the list is actually cut.
pub const SHORTLIST_SIZE: usize = 3;

/// The chord features per candidate, in the order `chord_frontend.cpp` emits them.
pub const CHORD_FEATURE_COUNT: usize = 18;

/// Three pieces of context about the candidate's place in the ranking, then the chord features.
pub const FEATURE_COUNT: usize = 3 + CHORD_FEATURE_COUNT;

/// The re-ranker's weights, in the order the feature vector is built.
///
/// Fitted on 396 clips from 337 songs (322 of which have the true key somewhere on the shortlist
/// and so contribute a gradient), on the features the **C++** front end produces rather than the
/// Python prototype's — the two agree to 0.6% on the chroma and on 97% of chord frames, which is
/// close enough to develop against and not close enough to fit against.
///
/// The standardiser does not appear here. The fitted score is `w · ((x - mean) / scale)`, and the
/// `- Σ wᵢ · meanᵢ / scaleᵢ` term is identical for every candidate on the shortlist, so it cancels
/// in the comparison. Folding `1/scale` into the weights leaves these numbers as the whole model.
///
/// What it leans on, by standardised magnitude: the profile's own margin (+0.74) and rank (-0.52)
/// first, then `changes_into_tonic` — how often a chord change *lands* on the tonic chord (+0.43) —
/// then how much of the time that chord is sounding (+0.39), how much of the time is spent in the
/// key at all (+0.29), and the plagal and authentic cadences (+0.20, +0.17). That is the order a
/// musician would give, which is the best evidence available that it is reading music and not
/// noise, and the refit onto 396 clips did not disturb it.
const WEIGHTS: [f32; FEATURE_COUNT] = [
      119.733771,  // score_gap_to_leader
       -0.635209,  // shortlist_position
        0.027512,  // is_major
        2.568233,  // time_on_tonic
       -0.069787,  // time_on_relative_tonic
        0.022856,  // time_on_V_major
        1.296036,  // time_on_IV_major
       -0.039347,  // time_on_iv_minor
        0.670455,  // time_on_ii_minor
       -0.335625,  // time_on_vi_minor
        0.459751,  // time_on_III_major
        0.989837,  // time_on_VII_major
        1.293328,  // time_diatonic
        3.863603,  // changes_into_tonic
        3.437716,  // cadence_V_to_tonic
        3.311931,  // cadence_IV_to_tonic
       -0.888510,  // cadence_VII_to_tonic
        0.064399,  // opens_on_tonic
       -0.470241,  // closes_on_tonic
       -0.035638,  // most_common_is_tonic
       -0.253790,  // longest_run_is_tonic
];

/// One entry of the analyzer's shortlist.
#[derive(Debug, Clone, PartialEq)]
pub struct ShortlistEntry {
    pub key: String,
    pub scale: String,
    /// The profile's cosine similarity for this candidate.
    pub score: f32,
    /// `CHORD_FEATURE_COUNT` numbers, or empty when the CLI had no usable chord evidence.
    pub chord_features: Vec<f32>,
}

/// Which shortlist entry the chord evidence favours, or `None` to keep the analyzer's own answer.
///
/// Returns `None` rather than `Some(0)` when it declines, so a caller can tell "the re-ranker
/// agreed" from "the re-ranker never ran". Every rejection path is a case where the evidence is
/// absent or malformed, and in all of them the profile's verdict stands untouched.
pub fn rerank(shortlist: &[ShortlistEntry]) -> Option<usize> {
    if shortlist.len() < 2 {
        return None;
    }
    // Chord evidence is withheld by the CLI for silence, and for the case where its replicated
    // ranking fails to reproduce libKeyFinder's own winner. Either way there is nothing to add.
    if shortlist
        .iter()
        .any(|entry| entry.chord_features.len() != CHORD_FEATURE_COUNT)
    {
        return None;
    }
    if !shortlist
        .iter()
        .all(|entry| entry.score.is_finite() && entry.chord_features.iter().all(|v| v.is_finite()))
    {
        return None;
    }

    let leader_score = shortlist[0].score;
    let leader = &shortlist[0];
    let mut best = 0usize;
    let mut best_score = f32::NEG_INFINITY;
    for (position, entry) in shortlist.iter().take(SHORTLIST_SIZE).enumerate() {
        // Which end of the leader's note set is home — never a different note set.
        //
        // Replayed over every second of every clip in the span cache, the two kinds of move this
        // model makes are not the same bet. Choosing the leader's relative instead of the leader
        // helped the root at every buffer length and cannot touch the diagram (twelve seconds:
        // 8 -> 12 right roots over 31 moves; thirty-six: 2 -> 9 over 20). Moving to a key with
        // different notes lost at every length but one: 21 -> 13 right diagrams over 50 moves at
        // twelve seconds, 27 -> 22 at eight, 14 -> 12 at thirty-six. The chord features are
        // shares and counts over a buffer, and in the short buffers the neck is drawn from they
        // are too thin to overrule the profile about which *notes* are playing.
        //
        // Restricted, out of fold by song (note-set / exact): 64.0 / 55.6 against 62.8 / 54.7 at
        // twelve seconds, 62.2 / 53.0 against 60.5 / 52.1 at ten, and level-to-slightly-behind
        // past twenty — where the unrestricted numbers are the in-sample ones, since these weights
        // were fitted on those clips. See `scripts/key-research/exp_rerank_spans.py`.
        if position > 0
            && !crate::key_confidence::same_note_set(&entry.key, &entry.scale, &leader.key, &leader.scale)
        {
            continue;
        }
        let context = [
            entry.score - leader_score,
            position as f32,
            if entry.scale == "major" { 1.0 } else { 0.0 },
        ];
        let mut score = 0.0f32;
        for (weight, value) in WEIGHTS.iter().zip(context.iter().chain(entry.chord_features.iter()))
        {
            score += weight * value;
        }
        if score > best_score {
            best_score = score;
            best = position;
        }
    }
    Some(best)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(key: &str, scale: &str, score: f32, features: Vec<f32>) -> ShortlistEntry {
        ShortlistEntry {
            key: key.to_string(),
            scale: scale.to_string(),
            score,
            chord_features: features,
        }
    }

    fn flat() -> Vec<f32> {
        vec![0.0; CHORD_FEATURE_COUNT]
    }

    /// Chord evidence at the corpus median for whichever candidate the analyzer put first.
    ///
    /// The numbers come from `scripts/key-research/rerank_behaviour.py`, which prints the real
    /// distribution for exactly this purpose. An earlier draft of these tests invented its values
    /// and asserted that a "wide lead" survives strong evidence, using a lead of 0.06 — three times
    /// larger than the widest that occurs in the corpus. The test failed and the model was right.
    fn typical() -> Vec<f32> {
        let mut features = flat();
        features[0] = 0.214; // time_on_tonic
        features[9] = 0.684; // time_diatonic
        features[10] = 0.234; // changes_into_tonic
        features
    }

    /// The same, at the 90th percentile: a candidate the music clearly keeps landing on, with a
    /// dominant that resolves to it.
    fn compelling() -> Vec<f32> {
        let mut features = flat();
        features[0] = 0.476; // time_on_tonic
        features[9] = 0.981; // time_diatonic
        features[10] = 0.374; // changes_into_tonic
        features[11] = 0.127; // cadence_V_to_tonic
        features
    }

    /// With no chord evidence to separate them, the profile's leader must survive: every feature
    /// equal means only `score_gap_to_leader` and `shortlist_position` are in play, and both of
    /// those favour the top of the list.
    #[test]
    fn identical_evidence_keeps_the_analyzer_verdict() {
        let shortlist = vec![
            entry("C", "major", 0.9700, typical()),
            entry("A", "minor", 0.9662, typical()),
            entry("G", "major", 0.9640, typical()),
            entry("F", "major", 0.9620, typical()),
        ];
        assert_eq!(rerank(&shortlist), Some(0));
    }

    /// The case the whole thing exists for. The profile leans one way by less than it usually does
    /// — a 0.0017 gap, the median of the calls it overrules, against a 0.0046 median overall — and
    /// the runner-up is where the phrases land and where the dominant resolves.
    #[test]
    fn a_landing_tonic_overrules_a_narrow_lead() {
        let shortlist = vec![
            entry("C", "major", 0.9700, typical()),
            entry("A", "minor", 0.9683, compelling()),
            entry("G", "major", 0.9640, typical()),
            entry("F", "major", 0.9620, typical()),
        ];
        assert_eq!(rerank(&shortlist), Some(1));
    }

    /// A leader with evidence of its own keeps its place against a rival with just as much, because
    /// the margin and the ranking are then the only things left to separate them. This is the guard
    /// that matters: the model must break ties, not hold opinions about confident calls.
    #[test]
    fn the_leader_keeps_its_place_when_the_evidence_is_level() {
        let shortlist = vec![
            entry("C", "major", 0.9700, compelling()),
            entry("A", "minor", 0.9683, compelling()),
            entry("G", "major", 0.9640, typical()),
            entry("F", "major", 0.9620, typical()),
        ];
        assert_eq!(rerank(&shortlist), Some(0));
    }

    /// Margin alone does not protect a leader whose own chord evidence is only ordinary.
    ///
    /// This is worth pinning because it is the surprising half of the design and the easiest thing
    /// to break by accident. Against a rival at the 90th percentile of chord evidence, a leader at
    /// the median is overruled at *every* margin this model is ever consulted at: the tipping point
    /// sits near a 0.0115 cosine gap, and the CLI withholds chord evidence entirely above
    /// `CHORD_TIE_BREAK_MAX_GAP` = 0.008, so the whole live range is inside it.
    ///
    /// That is deliberate, and it is what the measurement bought. The re-ranker is not idle on
    /// confident calls because it is forbidden to act on them; it is idle on them because a leader
    /// the profile is confident about almost always has the chord evidence to match, so the two
    /// agree. Over the corpus it changes 11.3% of answers and is net +32 clips in 2376.
    ///
    /// The refit onto 396 clips moved the tipping point from 0.021 to 0.0115 — the weight on
    /// `score_gap_to_leader` more than doubled, which is the model being told by more data to
    /// trust the profile further and interfere less. This test failed on that refit and was
    /// updated, which is the behaviour the note below asks for.
    ///
    /// If a future refit moves the tipping point below the gap asserted here, this test fails, and
    /// that should be read as a change of behaviour rather than a broken assertion.
    #[test]
    fn margin_alone_does_not_protect_an_ordinary_leader() {
        // The widest gap at which the CLI still ships chord features at all.
        let widest_consulted_gap = 0.008;
        let shortlist = vec![
            entry("C", "major", 0.9700, typical()),
            entry("A", "minor", 0.9700 - widest_consulted_gap, compelling()),
            entry("G", "major", 0.9500, typical()),
            entry("F", "major", 0.9480, typical()),
        ];
        assert_eq!(rerank(&shortlist), Some(1));

        // ... and past it, the margin does win, so the weight has the sign it should.
        let beyond = vec![
            entry("C", "major", 0.9700, typical()),
            entry("A", "minor", 0.9700 - 0.030, compelling()),
            entry("G", "major", 0.9300, typical()),
            entry("F", "major", 0.9280, typical()),
        ];
        assert_eq!(rerank(&beyond), Some(0));
    }

    /// Chord evidence decides which end of a note set is home; it is not allowed to change the note
    /// set. The same compelling evidence that moves the root to the relative is ignored when it
    /// points at a fifth-related key, however narrow the profile's lead.
    #[test]
    fn chord_evidence_never_moves_the_diagram_to_other_notes() {
        let fifth_on_second = vec![
            entry("C", "major", 0.9700, typical()),
            entry("G", "major", 0.9699, compelling()),
            entry("A", "minor", 0.9500, typical()),
        ];
        assert_eq!(rerank(&fifth_on_second), Some(0));
        // With the relative behind the fifth, it is still the relative that may win.
        let relative_on_third = vec![
            entry("C", "major", 0.9700, typical()),
            entry("G", "major", 0.9699, compelling()),
            entry("A", "minor", 0.9690, compelling()),
        ];
        assert_eq!(rerank(&relative_on_third), Some(2));
    }

    #[test]
    fn missing_or_malformed_evidence_declines_rather_than_guessing() {
        let short = vec![entry("C", "major", 0.97, flat())];
        assert_eq!(rerank(&short), None);

        let wrong_width = vec![
            entry("C", "major", 0.97, vec![0.0; 4]),
            entry("A", "minor", 0.96, vec![0.0; 4]),
        ];
        assert_eq!(rerank(&wrong_width), None);

        let empty = vec![
            entry("C", "major", 0.97, Vec::new()),
            entry("A", "minor", 0.96, Vec::new()),
        ];
        assert_eq!(rerank(&empty), None);

        let mut nan = flat();
        nan[3] = f32::NAN;
        let poisoned = vec![
            entry("C", "major", 0.97, flat()),
            entry("A", "minor", 0.96, nan),
        ];
        assert_eq!(rerank(&poisoned), None);

        let infinite = vec![
            entry("C", "major", f32::INFINITY, flat()),
            entry("A", "minor", 0.96, flat()),
        ];
        assert_eq!(rerank(&infinite), None);
    }

    /// The CLI cuts the list at `SHORTLIST_SIZE`, but nothing stops a future build sending more,
    /// and the weights were fitted against four candidates. Anything past that is ignored rather
    /// than scored by a model that never saw a fifth position.
    #[test]
    fn extra_candidates_beyond_the_shortlist_are_ignored() {
        let mut irresistible = flat();
        irresistible[0] = 1.0;
        irresistible[9] = 1.0;
        irresistible[10] = 1.0;
        irresistible[11] = 1.0;
        let mut shortlist = vec![
            entry("C", "major", 0.97, flat()),
            entry("A", "minor", 0.96, flat()),
            entry("G", "major", 0.95, flat()),
            entry("F", "major", 0.94, flat()),
        ];
        shortlist.push(entry("D", "minor", 0.9600, irresistible));
        assert_eq!(rerank(&shortlist), Some(0));
    }

    #[test]
    fn weight_table_matches_the_feature_layout() {
        assert_eq!(WEIGHTS.len(), FEATURE_COUNT);
        assert_eq!(FEATURE_COUNT, 3 + CHORD_FEATURE_COUNT);
    }
}
