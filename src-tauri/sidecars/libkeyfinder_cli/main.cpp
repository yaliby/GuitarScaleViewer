// gsv-libkeyfinder-cli — the shipped key analyzer.
//
// What changed and why
// --------------------
// This used to print one key and throw everything else away. That single answer was all the Rust
// engine ever saw, so `key_detection.rs` filled the rest of the window record with constants
// (`strength: 0.90`, `first_to_second_relative_strength: 0.25`, `candidates: None`). Two things
// followed from that, both measured:
//
//   * The engine could not tell "torn between G major and E minor" from "certain", because it
//     never received a runner-up. Its confidence number was derived from the hardcoded 0.90 and
//     was therefore theatre.
//   * The relative-major/minor decision — 22 of the engine's 24 misses on the 72-clip corpus
//     (docs/KEY_ACCURACY_BASELINE.md) — had no evidence to work with beyond the winner's name.
//
// So this now emits what the analysis already computed internally:
//
//   * `chroma`      — the 12 pitch classes, summed over every octave.
//   * `bassChroma`  — the same 12, from the low octaves only. This is the cue the tonic decision
//                     was missing: a key and its relative share all seven notes, but the bass
//                     treats only one of them as home.
//   * `strength`    — how well the chroma actually fits the key libKeyFinder named, instead of
//                     the constant 0.90 the Rust side used to invent.
//
// What it deliberately does **not** emit is a rival 24-key ranking. An earlier draft scored all
// 24 keys here with Krumhansl-Kessler profiles; measured against libKeyFinder's own classifier
// over the 72-clip corpus it agreed only 45.8% of the time. Feeding that into
// `candidate_support_for_window` would have silently replaced the shipped classifier's verdict
// and invalidated the measured baseline. libKeyFinder remains the judge of `key`/`scale`; this
// tool's new job is to hand over the evidence it was throwing away.
//
// Every decision built on that evidence — which end of a relative pair is home, whether the pair
// is separable at all — lives in Rust (`key_engine::tonic_from_bass`), where `cargo test` can
// reach it.

#include <sndfile.h>

#include <algorithm>
#include <cmath>
#include <iomanip>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

#include <keyfinder/keyfinder.h>
#include <keyfinder/workspace.h>
#include <keyfinder/chromagram.h>

#include "chord_frontend.h"

namespace {

const char* const PITCH_NAMES[12] = {"C",  "C#", "D",  "D#", "E",  "F",
                                     "F#", "G",  "G#", "A",  "A#", "B"};

// Band 0 of libKeyFinder's chromagram is C, so band index and pitch class line up directly.
//
// This was measured, not assumed: the first version of this file reasoned from the key_t enum
// (which counts from A_MAJOR) that band 0 must be A, and produced a chroma whose peak sat nine
// semitones above the true tonic on every cadence clip in the corpus. Running all 24 cadence
// clips and taking the modal offset between the chroma peak and the known tonic gives 0 — the
// residual cases peak on the fifth, which is ordinary. `chroma_peaks_on_the_tonic` in
// key_engine.rs keeps this honest against a libKeyFinder upgrade that moves it.
const int BAND_ZERO_PITCH_CLASS = 0;  // C

/// How many of the profile's ranked candidates the engine is offered for re-ranking.
///
/// Measured on 396 clips / 337 songs: the true key is in the top 1 for 65.5% of clips, top 2 for
/// 77.0%, top 3 for 80.7%, top 4 for 84.1%, top 5 for 86.7%. A wider shortlist holds the answer
/// more often and gives the re-ranker more chances to pick something silly. Four was the peak on
/// the 167-song corpus; `refit_all.py` now puts it at three, and four is within noise of it.
const int SHORTLIST_SIZE = 3;

/// Above this margin between the top two candidates, the chord front end is not run at all.
///
/// Two things fall out of one constant. The chord analysis is an STFT, a median-filter pass and a
/// filterbank over the whole buffer, and the engine re-analyses every four seconds for as long as
/// the app is open — so not running it is worth real battery. And the margin is strongly predictive
/// on its own: below 0.003 the classifier's leader is right 46% of the time, from 0.003 to 0.008
/// 75%, and above 0.008 **88%**. There is very little there to win and a confident answer to lose.
///
/// Measured over the real corpus, restricting the re-ranker to the closest three-quarters of calls
/// scores 76.5/67.1 against 76.6/66.8 for running it always — the same number, a quarter less work.
/// It also makes "this only breaks ties" a property of the code rather than an observation about
/// the fitted weights.
const double CHORD_TIE_BREAK_MAX_GAP = 0.008;

// Krumhansl-Kessler key profiles, indexed from the tonic. Used only to rank the 24 candidates;
// libKeyFinder's own classifier still decides `key`/`scale`.
const double MAJOR_PROFILE[12] = {6.35, 2.23, 3.48, 2.33, 4.38, 4.09,
                                  5.19, 2.39, 3.66, 2.29, 2.88, 2.88};
const double MINOR_PROFILE[12] = {6.33, 2.68, 3.52, 5.38, 2.60, 3.53,
                                  2.54, 4.75, 3.98, 2.69, 3.34, 3.17};

// Tone profiles fitted to real recordings, replacing libKeyFinder's built-in pair.
//
// libKeyFinder classifies by cosine similarity between the 72-band chromagram and an
// octave-resolved tone profile. Its built-in profiles are Sha'ath's, shaped for DJ software.
// Nothing about them came from the music this app listens to.
//
// Fitted in two steps, both against the 337-song / 396-clip real corpus, and both measured by
// 6-fold cross-validation split **by song** over eight random partitions (scripts/key-research):
//
//   1. **generatively** — every clip's chromagram rotated so its true tonic sits at the profile's
//      origin, averaged per mode, blended 0.70 toward the fitted shape as regularisation. This
//      asks "what does a major key look like", which is not the question the classifier answers.
//   2. **discriminatively** — the result is then nudged to minimise the classifier's own
//      cross-entropy over all 24 candidates. The errors that remain are near misses (IV, V, the
//      relative: keys sharing six or seven notes), and an average cannot separate those, because
//      what distinguishes C major from G major is not what they have in common.
//
//     Sha'ath (libKeyFinder default)  note-set 65.9%          tonic 58.8%
//     generative only                 note-set 71.0% +/- 0.6  tonic 62.9% +/- 0.6
//     + discriminative refinement     note-set 74.0% +/- 0.4  tonic 65.4% +/- 0.6
//     refitted to separated audio     note-set 75.4% +/- 0.3  tonic 68.1% +/- 0.4
//
// The last row is the pair below. Since 2026-09-23 libKeyFinder reads the mix with its percussion
// masked out (`gsv::harmonic_signal`), so the profile it is matched against was fitted on the
// chromagrams of separated audio — `GSV_CHROMA_CACHE` built by this binary, `refit_all.py`, then
// `emit_profiles.py`. The blend and pull optima did not move (0.70 and 5.0); the gain is the input,
// not the fit. At twelve seconds of music, which is where the neck is first drawn, it is worth
// 66.7 / 55.5 -> 68.2 / 59.7 (`exp_hpss_audio.py`).
//
// The refinement's regularisation sits on a plateau running pull 3 to 14, so it is not a tuned
// point. A single fold split is not a measurement here: on the first 64-song corpus one partition
// gave 77.2% and another 71.5% for the same profile, which is why every number above is a mean
// over several partitions.
//
// The blend moved 0.80 -> 0.70 and the pull 7.0 -> 5.0 when the corpus grew from 226 clips to 396.
// That is the expected direction and the reason `refit_all.py` re-sweeps rather than just refits:
// 144 free numbers need less holding back once there is more data behind them.
//
// libKeyFinder still does the classifying. Only what it matches against has changed.
const double FITTED_MAJOR_72[72] = {
    1.339449, 0.849755, 0.980199, 0.861599, 1.395571, 1.231376, 0.918464, 1.394734, 0.880452, 1.257926, 0.875805, 1.122167,
    2.978680, 1.615930, 1.524246, 1.348766, 2.448100, 2.215040, 1.499051, 2.690263, 1.723187, 2.605179, 1.594048, 2.022895,
    3.707152, 1.778034, 2.014114, 1.550652, 3.296790, 2.397882, 1.494302, 3.258785, 1.797819, 3.010068, 1.584179, 2.375674,
    4.569345, 2.181876, 2.788013, 1.986684, 4.162838, 2.507918, 1.558807, 3.797526, 1.811778, 3.326483, 1.582713, 2.874470,
    4.700648, 2.109560, 3.262908, 2.150997, 4.498833, 2.410570, 2.057646, 4.119962, 1.948575, 3.655423, 1.991433, 3.532305,
    3.863408, 2.312264, 2.844529, 2.216260, 3.942655, 2.355190, 2.320439, 3.847773, 2.374280, 3.227392, 2.156304, 3.328430,
};

const double FITTED_MINOR_72[72] = {
    1.622738, 0.844162, 1.150086, 1.130131, 0.916659, 1.071396, 1.082933, 1.495682, 1.146352, 1.041164, 1.276351, 1.067936,
    3.301293, 1.572886, 1.935924, 2.522515, 1.593180, 1.582067, 1.536799, 2.570394, 2.113201, 1.619280, 2.474309, 1.905422,
    3.575193, 1.472348, 2.293001, 3.228171, 1.781197, 2.042895, 1.696841, 3.374028, 2.273980, 1.448612, 2.946427, 1.878204,
    3.896555, 1.468165, 2.857352, 4.221021, 2.183823, 2.717671, 2.115105, 4.124986, 2.321428, 1.472787, 3.305864, 1.870890,
    4.215399, 1.852129, 3.413067, 4.368815, 2.161719, 3.193961, 2.351135, 4.432010, 2.182138, 2.040211, 3.791915, 2.047900,
    3.636558, 2.090939, 3.195507, 3.559920, 2.393967, 2.915081, 2.406433, 4.034969, 2.164079, 2.388027, 3.600084, 2.439209,
};

/// Collapse the per-hop chromagram into the 72 numbers the classifier matches against.
///
/// libKeyFinder's own `collapseToOneHop` sums raw magnitudes, so the loudest bars of an excerpt
/// decide the key: a distorted chorus outweighs the verse that established it, and one cymbal
/// crash smears energy across all twelve bins. That is the right default for a DJ tool, where the
/// loudest section is the one being mixed, and the wrong one here.
///
/// Two corrections, measured independently over a 4x5 grid of scalings and compressions:
///
///   * divide each hop by its own peak, so every hop contributes equally regardless of how loud
///     that moment was;
///   * take a logarithm, so no single band can dominate by magnitude alone.
///
/// Together **+2.3 note-set and +3.5 tonic** over the plain sum, on the same fitted profiles. The
/// grid has a clear interior optimum rather than a tuned point — every compression between 0.5 and
/// log gains, and only the very aggressive 0.25 turns negative.
///
/// `FITTED_MAJOR_72` and `FITTED_MINOR_72` were fitted against *this* aggregation. Changing one
/// without refitting the other is measured nonsense: re-run `scripts/key-research/emit_profiles.py`.
std::vector<double> aggregate_chromagram(const KeyFinder::Chromagram& chromagram) {
    const unsigned int hops = chromagram.getHops();
    std::vector<double> out(BANDS, 0.0);
    if (hops == 0) {
        return out;
    }

    std::vector<std::vector<double>> scaled(hops, std::vector<double>(BANDS, 0.0));
    double total = 0.0;
    for (unsigned int hop = 0; hop < hops; hop++) {
        double peak = 0.0;
        for (unsigned int band = 0; band < BANDS; band++) {
            peak = std::max(peak, chromagram.getMagnitude(hop, band));
        }
        if (peak <= 0.0) {
            continue;  // a silent hop contributes nothing rather than dividing by zero
        }
        for (unsigned int band = 0; band < BANDS; band++) {
            scaled[hop][band] = chromagram.getMagnitude(hop, band) / peak;
            total += scaled[hop][band];
        }
    }

    // Rescale to mean 1 before the logarithm. Without this the compression would be applied to a
    // different part of the curve for every clip, which is how an earlier attempt at combining
    // normalisation and compression lost to either one alone.
    const double mean = total / (static_cast<double>(hops) * BANDS);
    if (mean <= 0.0) {
        return out;
    }
    for (unsigned int band = 0; band < BANDS; band++) {
        double sum = 0.0;
        for (unsigned int hop = 0; hop < hops; hop++) {
            sum += std::log1p(scaled[hop][band] / mean);
        }
        out[band] = sum / hops;
    }
    return out;
}

std::string to_label(KeyFinder::key_t key) {
    switch (key) {
        case KeyFinder::A_MAJOR: return "A:major";
        case KeyFinder::A_MINOR: return "A:minor";
        case KeyFinder::B_FLAT_MAJOR: return "A#:major";
        case KeyFinder::B_FLAT_MINOR: return "A#:minor";
        case KeyFinder::B_MAJOR: return "B:major";
        case KeyFinder::B_MINOR: return "B:minor";
        case KeyFinder::C_MAJOR: return "C:major";
        case KeyFinder::C_MINOR: return "C:minor";
        case KeyFinder::D_FLAT_MAJOR: return "C#:major";
        case KeyFinder::D_FLAT_MINOR: return "C#:minor";
        case KeyFinder::D_MAJOR: return "D:major";
        case KeyFinder::D_MINOR: return "D:minor";
        case KeyFinder::E_FLAT_MAJOR: return "D#:major";
        case KeyFinder::E_FLAT_MINOR: return "D#:minor";
        case KeyFinder::E_MAJOR: return "E:major";
        case KeyFinder::E_MINOR: return "E:minor";
        case KeyFinder::F_MAJOR: return "F:major";
        case KeyFinder::F_MINOR: return "F:minor";
        case KeyFinder::G_FLAT_MAJOR: return "F#:major";
        case KeyFinder::G_FLAT_MINOR: return "F#:minor";
        case KeyFinder::G_MAJOR: return "G:major";
        case KeyFinder::G_MINOR: return "G:minor";
        case KeyFinder::A_FLAT_MAJOR: return "G#:major";
        case KeyFinder::A_FLAT_MINOR: return "G#:minor";
        case KeyFinder::SILENCE: return "silence";
        default: return "unknown";
    }
}

/// Pearson correlation between a chroma vector and a key profile rotated to `tonic`.
double correlate(const std::vector<double>& chroma, const double profile[12], int tonic) {
    double chroma_mean = 0.0;
    double profile_mean = 0.0;
    for (int i = 0; i < 12; i++) {
        chroma_mean += chroma[i];
        profile_mean += profile[i];
    }
    chroma_mean /= 12.0;
    profile_mean /= 12.0;

    double covariance = 0.0;
    double chroma_var = 0.0;
    double profile_var = 0.0;
    for (int i = 0; i < 12; i++) {
        const double c = chroma[(tonic + i) % 12] - chroma_mean;
        const double p = profile[i] - profile_mean;
        covariance += c * p;
        chroma_var += c * c;
        profile_var += p * p;
    }
    const double denom = std::sqrt(chroma_var * profile_var);
    if (denom < 1e-12) {
        return 0.0;
    }
    return covariance / denom;
}

/// Pitch class of a key name, or -1 when it cannot be read.
int pitch_class_of(const std::string& name) {
    for (int i = 0; i < 12; i++) {
        if (name == PITCH_NAMES[i]) {
            return i;
        }
    }
    return -1;
}

/// Cosine similarity of the chromagram against every one of the 24 candidate keys.
///
/// This is libKeyFinder's `KeyClassifier::classify` written out, for one reason: the classifier
/// returns only its winner, and the tie-break that follows needs the runners-up. Candidate `i` has
/// tonic `(9 + i/2) % 12` and is major when `i` is even, matching `key_t`'s order; the three
/// semitone shift is `ToneProfile`'s constructor rotating C-indexed bands onto an A-indexed enum.
///
/// The caller must check `ranking_agrees_with` before trusting the order. An earlier version of
/// this tool scored the 24 keys with Krumhansl-Kessler profiles and agreed with libKeyFinder's own
/// classifier only 45.8% of the time; feeding that into the engine would have silently replaced
/// the shipped verdict. This reproduces the real thing rather than approximating it, and says so
/// out loud if it ever stops doing that.
std::vector<double> candidate_scores(const std::vector<double>& bands,
                                     const double major[72], const double minor[72]) {
    std::vector<double> scores(24, 0.0);
    double band_norm = 0.0;
    for (int i = 0; i < 72; i++) {
        band_norm += bands[i] * bands[i];
    }
    band_norm = std::sqrt(band_norm);
    for (int candidate = 0; candidate < 24; candidate++) {
        const double* profile = (candidate % 2 == 0) ? major : minor;
        const int offset = candidate / 2;
        double dot = 0.0;
        double profile_norm = 0.0;
        for (int octave = 0; octave < 6; octave++) {
            for (int i = 0; i < 12; i++) {
                const double p = profile[octave * 12 + ((i + 3 - offset + 12) % 12)];
                dot += bands[octave * 12 + i] * p;
                profile_norm += p * p;
            }
        }
        profile_norm = std::sqrt(profile_norm);
        scores[candidate] =
            (band_norm > 0.0 && profile_norm > 0.0) ? dot / (band_norm * profile_norm) : 0.0;
    }
    return scores;
}

/// Does the replicated ranking's winner match what libKeyFinder actually returned?
bool ranking_agrees_with(const std::vector<double>& scores, KeyFinder::key_t key) {
    int best = 0;
    for (int i = 1; i < 24; i++) {
        if (scores[i] > scores[best]) {
            best = i;
        }
    }
    static const KeyFinder::key_t ORDER[24] = {
        KeyFinder::A_MAJOR,       KeyFinder::A_MINOR,
        KeyFinder::B_FLAT_MAJOR,  KeyFinder::B_FLAT_MINOR,
        KeyFinder::B_MAJOR,       KeyFinder::B_MINOR,
        KeyFinder::C_MAJOR,       KeyFinder::C_MINOR,
        KeyFinder::D_FLAT_MAJOR,  KeyFinder::D_FLAT_MINOR,
        KeyFinder::D_MAJOR,       KeyFinder::D_MINOR,
        KeyFinder::E_FLAT_MAJOR,  KeyFinder::E_FLAT_MINOR,
        KeyFinder::E_MAJOR,       KeyFinder::E_MINOR,
        KeyFinder::F_MAJOR,       KeyFinder::F_MINOR,
        KeyFinder::G_FLAT_MAJOR,  KeyFinder::G_FLAT_MINOR,
        KeyFinder::G_MAJOR,       KeyFinder::G_MINOR,
        KeyFinder::A_FLAT_MAJOR,  KeyFinder::A_FLAT_MINOR,
    };
    return ORDER[best] == key;
}

void print_chroma(const char* name, const std::vector<double>& chroma, bool trailing_comma) {
    std::cout << "\"" << name << "\":[";
    for (int i = 0; i < 12; i++) {
        if (i) std::cout << ",";
        std::cout << std::fixed << std::setprecision(6) << chroma[i];
    }
    std::cout << "]";
    if (trailing_comma) std::cout << ",";
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: gsv-libkeyfinder-cli <wav_path>\n";
        return 2;
    }

    const char* wav_path = argv[1];
    SF_INFO info{};
    SNDFILE* file = sf_open(wav_path, SFM_READ, &info);
    if (!file) {
        std::cerr << "open_failed\n";
        return 3;
    }

    std::vector<float> samples(static_cast<size_t>(info.frames) * static_cast<size_t>(info.channels));
    sf_count_t frames_read = sf_readf_float(file, samples.data(), info.frames);
    sf_close(file);
    if (frames_read <= 0) {
        std::cerr << "read_failed\n";
        return 4;
    }

    // What libKeyFinder reads is the mix with its percussion masked out (`gsv::harmonic_signal`):
    // drums put a broadband floor under every chromagram band, and the fitted profile below was
    // fitted to separated audio. `GSV_SEPARATION=0` hands it the mix as recorded, which is the only
    // way to measure the difference against the same binary — and the profile it is matched with
    // then no longer fits, so that switch is for experiments, not for shipping.
    //
    // The chord evidence further down still reads `samples`, the original mix. Its weights were
    // fitted there, and it runs its own separation tuned for chords rather than keys.
    const char* separation_setting = std::getenv("GSV_SEPARATION");
    const bool separate = !(separation_setting != nullptr && std::string(separation_setting) == "0");
    const std::vector<float> key_audio =
        separate ? gsv::harmonic_signal(samples, info.channels, info.samplerate) : samples;
    const int key_channels = separate ? 1 : info.channels;

    KeyFinder::AudioData audio;
    audio.setFrameRate(info.samplerate);
    audio.setChannels(key_channels);
    audio.addToSampleCount(static_cast<int>(key_audio.size()));
    for (size_t i = 0; i < key_audio.size(); i++) {
        audio.setSample(static_cast<int>(i), key_audio[i]);
    }

    // The progressive path so the chromagram survives the call: `keyOfAudio` builds one
    // internally and drops it, which is exactly the information this tool exists to keep.
    KeyFinder::KeyFinder finder;
    KeyFinder::Workspace workspace;
    finder.progressiveChromagram(audio, workspace);
    finder.finalChromagram(workspace);
    const std::vector<double> collapsed_chroma =
        workspace.chromagram != nullptr ? aggregate_chromagram(*workspace.chromagram)
                                        : std::vector<double>(BANDS, 0.0);
    const std::vector<double> fitted_major(FITTED_MAJOR_72, FITTED_MAJOR_72 + 72);
    const std::vector<double> fitted_minor(FITTED_MINOR_72, FITTED_MINOR_72 + 72);
    KeyFinder::key_t key = finder.keyOfChromaVector(collapsed_chroma, fitted_major, fitted_minor);

    // --bands: the 72-band vector the classifier was actually given, after `aggregate_chromagram`.
    //
    // The shipped output collapses six octaves onto twelve pitch classes, but libKeyFinder's
    // classifier never sees that — it matches octave-resolved profiles against these 72 bands by
    // cosine similarity. Anything that wants to test a different tone profile has to work here.
    if (argc >= 3 && std::string(argv[2]) == "--bands" && workspace.chromagram != nullptr) {
        std::cout << "{\"bands\":[";
        for (size_t i = 0; i < collapsed_chroma.size(); i++) {
            if (i) std::cout << ",";
            std::cout << std::fixed << std::setprecision(6) << collapsed_chroma[i];
        }
        std::cout << "],\"key\":\"" << to_label(key) << "\"}" << std::endl;
        return 0;
    }

    // --bands-hops: the 72-band chromagram *per hop*, not summed.
    //
    // `--bands` throws away time, and time is where the tonic lives: a key and its relative share
    // every pitch class, and what separates them is which chord a phrase rests on. Research on the
    // profiles only ever needed the sum; anything that wants to reason about chord changes, or
    // about how the answer would have looked at 20 seconds, needs the hops. Emitting them once
    // lets an experiment run from a cache instead of re-analysing 226 clips.
    if (argc >= 3 && std::string(argv[2]) == "--bands-hops" && workspace.chromagram != nullptr) {
        const unsigned int hop_count = workspace.chromagram->getHops();
        std::cout << "{\"hops\":" << hop_count << ",\"bands\":" << BANDS << ",\"frames\":[";
        for (unsigned int hop = 0; hop < hop_count; hop++) {
            if (hop) std::cout << ",";
            std::cout << "[";
            for (unsigned int band = 0; band < BANDS; band++) {
                if (band) std::cout << ",";
                std::cout << std::fixed << std::setprecision(3)
                          << workspace.chromagram->getMagnitude(hop, band);
            }
            std::cout << "]";
        }
        std::cout << "],\"key\":\"" << to_label(key) << "\"}" << std::endl;
        return 0;
    }

    // --chords: the chord-derived evidence, 18 numbers per candidate key.
    //
    // This is a second front end (chord_frontend.h) reading the same audio at five times
    // libKeyFinder's time resolution, because the tie-break between a key and its relative,
    // subdominant or dominant is about *which chord the music rests on* and a 3.7-second FFT frame
    // cannot see one. Emitted so the research harness can check the C++ against the Python it was
    // fitted in; the shipped path carries the same numbers inside the main output.
    if (argc >= 3 && std::string(argv[2]) == "--chords") {
        const bool diagnostics = (argc >= 4 && std::string(argv[3]) == "--diagnostics");
        const gsv::ChordEvidence evidence =
            gsv::analyse_chords(samples, info.channels, info.samplerate, diagnostics);
        std::cout << "{\"valid\":" << (evidence.valid ? "true" : "false")
                  << ",\"tuningCents\":" << std::fixed << std::setprecision(1)
                  << evidence.tuning_cents << ",\"frames\":" << evidence.frames;
        if (diagnostics) {
            std::cout << ",\"chromaTotals\":[";
            for (size_t i = 0; i < evidence.chroma_totals.size(); i++) {
                if (i) std::cout << ",";
                std::cout << std::fixed << std::setprecision(4) << evidence.chroma_totals[i];
            }
            std::cout << "],\"bassTotals\":[";
            for (size_t i = 0; i < evidence.bass_totals.size(); i++) {
                if (i) std::cout << ",";
                std::cout << std::fixed << std::setprecision(4) << evidence.bass_totals[i];
            }
            std::cout << "],\"chordLabels\":[";
            for (size_t i = 0; i < evidence.chord_labels.size(); i++) {
                if (i) std::cout << ",";
                std::cout << evidence.chord_labels[i];
            }
            std::cout << "]";
        }
        std::cout << ",\"features\":[";
        for (size_t c = 0; c < evidence.features.size(); c++) {
            if (c) std::cout << ",";
            std::cout << "[";
            for (size_t f = 0; f < evidence.features[c].size(); f++) {
                if (f) std::cout << ",";
                std::cout << std::fixed << std::setprecision(6) << evidence.features[c][f];
            }
            std::cout << "]";
        }
        std::cout << "]}" << std::endl;
        return 0;
    }

    // --hop-energy: total chromagram magnitude per hop.
    //
    // libKeyFinder fills at most 44 hops however much audio it is handed — about 41 seconds —
    // and everything past that produces no chroma at all. Measured by feeding clips of growing
    // length (10s->11 hops, 20s->22, 40s->44, 45s->44, 60s->44), and confirmed with music rather
    // than silence: splice 30s of one song onto 30s of another and the verdict is the first
    // song's, as if the second half were not there. `MAX_ANALYSIS_SPAN_SECONDS` is 44, so the
    // shipped engine sits just inside this; the constant is not arbitrary and must not grow.
    if (argc >= 3 && std::string(argv[2]) == "--hop-energy" && workspace.chromagram != nullptr) {
        const unsigned int hop_count = workspace.chromagram->getHops();
        std::cout << "{\"hops\":" << hop_count << ",\"hopEnergy\":[";
        for (unsigned int hop = 0; hop < hop_count; hop++) {
            double total = 0.0;
            for (unsigned int band = 0; band < BANDS; band++) {
                total += workspace.chromagram->getMagnitude(hop, band);
            }
            if (hop) std::cout << ",";
            std::cout << std::fixed << std::setprecision(1) << total;
        }
        std::cout << "]}" << std::endl;
        return 0;
    }

    std::string label = to_label(key);
    std::string key_name = "unknown";
    std::string scale = "unknown";
    size_t sep = label.find(':');
    if (sep != std::string::npos) {
        key_name = label.substr(0, sep);
        scale = label.substr(sep + 1);
    }

    // These stay raw sums, deliberately, while the classifier reads `aggregate_chromagram`.
    // `chroma` is not classifier input — it feeds `strength` and `key_engine::tonic_is_supported`,
    // whose threshold was calibrated against summed magnitudes. Re-pointing it at the aggregation
    // would move that threshold's meaning without anything having measured the result, and the
    // scoreboard's `slips_asserted` floor is asserted against its present behaviour.
    std::vector<double> chroma(12, 0.0);
    std::vector<double> bass(12, 0.0);
    // Time-sliced bass, because collapsing the whole chromagram to one hop throws away *when* a
    // note was played — and when is the part that separates a key from its relative. Measured:
    // over the six corpus clips the engine slips on, total bass magnitude picks the true tonic
    // 1 time in 6, because a four-chord loop gives every root equal time. Where the tonic does
    // stand out is at the edges of a phrase. These segments let the Rust side weight that
    // without this tool deciding anything.
    const int SEGMENTS = 8;
    std::vector<std::vector<double>> bass_segments(SEGMENTS, std::vector<double>(12, 0.0));
    int hops = 0;
    if (workspace.chromagram != nullptr) {
        hops = static_cast<int>(workspace.chromagram->getHops());
        for (int hop = 0; hop < hops; hop++) {
            const int segment = hops <= 1 ? 0 : std::min(SEGMENTS - 1, hop * SEGMENTS / hops);
            for (unsigned int band = 0; band < BANDS; band++) {
                const double magnitude = workspace.chromagram->getMagnitude(hop, band);
                const int pc = (static_cast<int>(band % 12) + BAND_ZERO_PITCH_CLASS) % 12;
                const int octave = static_cast<int>(band / 12);
                chroma[pc] += magnitude;
                // The bottom two of libKeyFinder's six octaves. A key and its relative share
                // every note; what differs is which one the bass line treats as home.
                if (octave < 2) {
                    bass[pc] += magnitude;
                    bass_segments[segment][pc] += magnitude;
                }
            }
        }
    }

    // Correlations run -1..1; the engine's contract is 0..1, so map rather than clamp — clamping
    // would collapse every negative correlation onto the same score.
    auto normalized = [](double score) { return std::max(0.0, std::min(1.0, (score + 1.0) / 2.0)); };

    // How well the chroma fits the key libKeyFinder actually named. Replaces a hardcoded 0.90,
    // so the engine's confidence finally varies with the audio.
    double strength = 0.0;
    const int tonic_pc = pitch_class_of(key_name);
    if (tonic_pc >= 0) {
        const bool is_major = (scale == "major");
        strength = normalized(correlate(chroma, is_major ? MAJOR_PROFILE : MINOR_PROFILE, tonic_pc));
    }

    std::cout << "{"
              << "\"backendUsed\":\"libkeyfinder\","
              << "\"key\":\"" << key_name << "\","
              << "\"scale\":\"" << scale << "\","
              << "\"strength\":" << std::fixed << std::setprecision(6) << strength << ","
              << "\"hops\":" << hops << ",";
    print_chroma("chroma", chroma, true);
    print_chroma("bassChroma", bass, true);
    std::cout << "\"bassSegments\":[";
    for (int s = 0; s < SEGMENTS; s++) {
        if (s) std::cout << ",";
        std::cout << "[";
        for (int i = 0; i < 12; i++) {
            if (i) std::cout << ",";
            std::cout << std::fixed << std::setprecision(6) << bass_segments[s][i];
        }
        std::cout << "]";
    }
    std::cout << "],";

    // The shortlist, and the chord evidence for each entry on it.
    //
    // The profile puts the true key first 63.8% of the time and inside its top four 84.6% of the
    // time, so a fifth of every wrong answer is a candidate the classifier had already found and
    // then ranked second. Separating those needs evidence a 3.7-second FFT frame cannot hold —
    // which chord the music rests on — so `chord_frontend.cpp` reads the same audio again at five
    // times the time resolution and this hands the result over per candidate.
    //
    // Emitted only when the replicated ranking reproduces libKeyFinder's own winner. If it ever
    // does not, the shortlist is withheld rather than shipped wrong, and the engine falls back to
    // the classifier's single answer.
    const std::vector<double> scores = candidate_scores(collapsed_chroma, FITTED_MAJOR_72, FITTED_MINOR_72);
    const bool ranking_trustworthy = ranking_agrees_with(scores, key);

    std::vector<int> order(24);
    for (int i = 0; i < 24; i++) {
        order[i] = i;
    }
    std::sort(order.begin(), order.end(),
              [&scores](int a, int b) { return scores[a] > scores[b]; });
    const double top_gap = scores[order[0]] - scores[order[1]];
    const bool close_enough_to_be_worth_asking = top_gap <= CHORD_TIE_BREAK_MAX_GAP;

    // --research: the shipped output, byte for byte in every field it already has, plus what an
    // experiment needs to re-decide the answer without re-running the analysis — the 72 bands the
    // classifier matched, all 24 scores, and the chord evidence for every candidate *whether or not*
    // the shipped path would have asked for it. The per-candidate `chordFeatures` below still follow
    // the shipped rule, so the engine's re-ranker sees exactly what it would see live.
    const bool research = (argc >= 3 && std::string(argv[2]) == "--research");
    const bool ask_chords = ranking_trustworthy && close_enough_to_be_worth_asking;
    const gsv::ChordEvidence all_chords =
        research ? gsv::analyse_chords(samples, info.channels, info.samplerate) : gsv::ChordEvidence{};
    const gsv::ChordEvidence chord_evidence =
        ask_chords ? (research ? all_chords : gsv::analyse_chords(samples, info.channels, info.samplerate))
                   : gsv::ChordEvidence{};

    std::cout << "\"rankingAgrees\":" << (ranking_trustworthy ? "true" : "false")
              << ",\"topGap\":" << std::fixed << std::setprecision(6) << top_gap
              << ",\"chordEvidence\":" << (chord_evidence.valid ? "true" : "false")
              << ",\"tuningCents\":" << std::fixed << std::setprecision(1)
              << chord_evidence.tuning_cents << ",\"candidates\":[";
    if (ranking_trustworthy) {
        for (int slot = 0; slot < SHORTLIST_SIZE; slot++) {
            const int candidate = order[slot];
            if (slot) std::cout << ",";
            const int candidate_pc = (9 + candidate / 2) % 12;
            const bool candidate_major = (candidate % 2 == 0);
            // Each candidate carries its *own* fit to the chroma. Without this the engine would
            // weight a re-ranked key by how well the chroma fitted the key it replaced, which is a
            // different number about a different key — and `strength` is what the consensus layer
            // votes with.
            const double candidate_strength = normalized(correlate(
                chroma, candidate_major ? MAJOR_PROFILE : MINOR_PROFILE, candidate_pc));
            std::cout << "{\"key\":\"" << PITCH_NAMES[candidate_pc] << "\","
                      << "\"scale\":\"" << (candidate_major ? "major" : "minor") << "\","
                      << "\"score\":" << std::fixed << std::setprecision(6) << scores[candidate]
                      << ",\"strength\":" << std::fixed << std::setprecision(6) << candidate_strength
                      << ",\"chordFeatures\":[";
            // Empty when there is no chord evidence — the margin was wide enough that the front
            // end was never run, or the audio was silent. An empty list makes the engine's
            // re-ranker decline outright rather than score a row of zeros and arrive at the same
            // place by arithmetic; "we did not ask" and "we asked and learned nothing" should not
            // look the same on the wire.
            if (chord_evidence.valid) {
                for (int f = 0; f < gsv::CHORD_FEATURE_COUNT; f++) {
                    if (f) std::cout << ",";
                    std::cout << std::fixed << std::setprecision(6)
                              << chord_evidence.features[candidate][f];
                }
            }
            std::cout << "]}";
        }
    }
    std::cout << "]";
    if (research) {
        std::cout << ",\"bands\":[";
        for (size_t i = 0; i < collapsed_chroma.size(); i++) {
            if (i) std::cout << ",";
            std::cout << std::fixed << std::setprecision(6) << collapsed_chroma[i];
        }
        std::cout << "],\"scores\":[";
        for (int i = 0; i < 24; i++) {
            if (i) std::cout << ",";
            std::cout << std::fixed << std::setprecision(6) << scores[i];
        }
        std::cout << "],\"allChordValid\":" << (all_chords.valid ? "true" : "false")
                  << ",\"allChordFrames\":" << all_chords.frames
                  << ",\"allTuningCents\":" << std::fixed << std::setprecision(1)
                  << all_chords.tuning_cents << ",\"allChordFeatures\":[";
        if (all_chords.valid) {
            for (int c = 0; c < gsv::CANDIDATE_COUNT; c++) {
                if (c) std::cout << ",";
                std::cout << "[";
                for (int f = 0; f < gsv::CHORD_FEATURE_COUNT; f++) {
                    if (f) std::cout << ",";
                    std::cout << std::fixed << std::setprecision(6) << all_chords.features[c][f];
                }
                std::cout << "]";
            }
        }
        std::cout << "]";
    }
    std::cout << "}" << std::endl;
    return 0;
}
