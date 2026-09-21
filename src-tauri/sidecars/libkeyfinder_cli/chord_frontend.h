// A chord-resolution chromagram, and the key evidence read off it.
//
// Why this exists, and why it is not libKeyFinder's chromagram
// -----------------------------------------------------------
// The tone profile decides which seven notes are on the neck, and it is right about 75% of the
// time. Of what is left, the largest blocks are a key confused with its relative (identical seven
// notes) and with its subdominant or dominant (six shared notes). Measured: the true key sits in
// the profile's **top three candidates for 82.2% of clips** while the engine keeps only 63.8% of
// them, so eighteen points are sitting in the ranking waiting for a tie-break.
//
// Nothing derived from libKeyFinder's chromagram can supply one, and three different models have
// been fitted to prove it. The reason is in the front end, not the model: libKeyFinder's FFT frame
// is 16384 samples at a 4410 Hz working rate — a **3.7 second window**, which smears three or four
// chords into one observation. What separates C major from G major is not which notes occur, it is
// which chord the music rests on and resolves to, and that information is averaged away before any
// classifier sees it.
//
// So this is a second, independent front end whose only job is to read chords:
//
//   * decimate to 11025 Hz — well above the top of the pitch range that matters, four times
//     cheaper than working at 44.1k;
//   * STFT at 8192/2048, a **0.74 second** window: five times sharper in time than libKeyFinder's
//     and still 1.35 Hz per bin, enough to separate semitones at the bottom of a bass guitar;
//   * harmonic-percussive separation by median filtering. Drums are broadband and brief, so they
//     survive a median across frequency and vanish under a median across time; pitched material
//     does the opposite. The measured explanation for the tonic-evidence gate being inert on real
//     audio was exactly this — "drums, distortion, vocals and reverb put energy in all twelve
//     chroma bins";
//   * per-recording tuning estimation. A *global* pitch offset was tested and lost; 28% of corpus
//     clips sit 20 cents or more from A440, which is enough to smear every partial across two
//     filterbank bins.
//
// Measured contribution of those last two, over the real corpus with everything else held fixed:
// removing both costs 1.2 points of note-set and 2.2 of tonic.
//
// This file computes **evidence only**. It scores no key and picks no winner: it emits eighteen
// numbers per candidate and the Rust engine decides, which is the same division of labour the rest
// of this CLI follows.

#ifndef GSV_CHORD_FRONTEND_H
#define GSV_CHORD_FRONTEND_H

#include <string>
#include <vector>

namespace gsv {

// The eighteen features, per candidate key, in this order. Named so the Rust side's weight vector
// can be read against something.
extern const char* const CHORD_FEATURE_NAMES[];
constexpr int CHORD_FEATURE_COUNT = 18;

// Candidates are ordered the same way libKeyFinder's key_t is: A major, A minor, A# major, ...
constexpr int CANDIDATE_COUNT = 24;

struct ChordEvidence {
    // [candidate][feature]
    std::vector<std::vector<double>> features;
    double tuning_cents = 0.0;
    int frames = 0;
    bool valid = false;

    // Diagnostics, filled only when `want_diagnostics` is set. The Python prototype in
    // scripts/key-research computes the same chain, and comparing the chord *labels* alone cannot
    // tell a front-end difference from an argmax that happened to fall the other way on a tie.
    std::vector<double> chroma_totals;   // 12, summed over frames
    std::vector<double> bass_totals;     // 12, summed over frames
    std::vector<int> chord_labels;       // one per frame
};

/// Analyse interleaved audio. `samples` is `frames * channels` long.
ChordEvidence analyse_chords(const std::vector<float>& samples, int channels, int sample_rate,
                             bool want_diagnostics = false);

}  // namespace gsv

#endif  // GSV_CHORD_FRONTEND_H
