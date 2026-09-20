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
#include <iostream>
#include <string>
#include <vector>

#include <keyfinder/keyfinder.h>
#include <keyfinder/workspace.h>
#include <keyfinder/chromagram.h>

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
// Fitted in two steps, both against the 167-song / 226-clip real corpus, and both measured by
// 6-fold cross-validation split **by song** over ten random partitions (scripts/key-research):
//
//   1. **generatively** — every clip's chromagram rotated so its true tonic sits at the profile's
//      origin, averaged per mode, blended 0.80 toward the fitted shape as regularisation. This
//      asks "what does a major key look like", which is not the question the classifier answers.
//   2. **discriminatively** — the result is then nudged to minimise the classifier's own
//      cross-entropy over all 24 candidates. The errors that remain are near misses (IV, V, the
//      relative: keys sharing six or seven notes), and an average cannot separate those, because
//      what distinguishes C major from G major is not what they have in common.
//
//     Sha'ath (libKeyFinder default)  note-set 65.9%          tonic 58.8%
//     generative only                 note-set 69.7% +/- 0.8  tonic 57.9% +/- 1.0
//     + discriminative refinement     note-set 72.7% +/- 0.9  tonic 60.0% +/- 0.7
//     + the log aggregation below     note-set 74.9% +/- 0.7  tonic 63.5% +/- 0.7
//
// The refinement's regularisation sits on a plateau running pull 5 to 14, so it is not a tuned
// point. A single fold split is not a measurement here: on the first 64-song corpus one partition
// gave 77.2% and another 71.5% for the same profile, which is why every number above is a mean
// over ten partitions.
//
// libKeyFinder still does the classifying. Only what it matches against has changed.
const double FITTED_MAJOR_72[72] = {
    1.224143, 0.805402, 0.970389, 0.844917, 1.164742, 1.022740, 0.866868, 1.153762, 0.904857, 1.308164, 0.821600, 1.084137,
    2.787149, 1.545346, 1.665085, 1.389100, 2.217212, 2.161821, 1.555460, 2.574744, 1.607528, 2.469213, 1.640102, 1.929317,
    3.574733, 1.972868, 2.390691, 1.591326, 2.877206, 2.206250, 1.518903, 3.214113, 1.785263, 2.936017, 1.844812, 2.431618,
    4.166277, 2.084742, 2.861616, 2.012884, 3.787006, 2.603826, 1.595455, 3.534424, 1.833725, 3.071926, 1.728430, 2.762407,
    4.419814, 2.251903, 3.423980, 2.302556, 4.155970, 2.562381, 2.137849, 4.035311, 2.071780, 3.485709, 2.213780, 3.481206,
    3.935668, 2.562503, 3.158089, 2.528175, 3.976413, 2.724510, 2.756631, 3.942531, 2.604121, 3.274325, 2.475740, 3.433313,
};

const double FITTED_MINOR_72[72] = {
    1.635556, 0.770443, 1.097478, 1.121405, 0.918963, 1.065661, 1.090132, 1.340917, 1.022736, 1.012000, 1.152781, 1.079227,
    3.211326, 1.712475, 1.984737, 2.427782, 1.641578, 1.818657, 1.615026, 2.422201, 2.116011, 1.685003, 2.435985, 1.780377,
    3.489368, 1.733772, 2.349046, 3.087215, 1.988610, 2.393947, 1.759969, 3.030297, 2.143130, 1.580804, 2.925985, 1.899470,
    3.644938, 1.638610, 2.752734, 3.781366, 2.105785, 2.760771, 2.037997, 3.736912, 2.287337, 1.545076, 3.024380, 1.874764,
    3.958783, 2.050441, 3.360843, 3.990411, 2.278684, 3.239105, 2.405293, 4.099668, 2.201954, 2.099979, 3.576308, 2.130131,
    3.617709, 2.396145, 3.271911, 3.555571, 2.641071, 3.183060, 2.713885, 4.059938, 2.446621, 2.742045, 3.632906, 2.631368,
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

    KeyFinder::AudioData audio;
    audio.setFrameRate(info.samplerate);
    audio.setChannels(info.channels);
    audio.addToSampleCount(static_cast<int>(frames_read * info.channels));
    for (size_t i = 0; i < static_cast<size_t>(frames_read) * static_cast<size_t>(info.channels); i++) {
        audio.setSample(static_cast<int>(i), samples[i]);
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
    std::cout << "]}" << std::endl;
    return 0;
}
