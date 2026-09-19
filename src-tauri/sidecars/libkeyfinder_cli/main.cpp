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
    KeyFinder::key_t key = finder.keyOfChromagram(workspace);

    std::string label = to_label(key);
    std::string key_name = "unknown";
    std::string scale = "unknown";
    size_t sep = label.find(':');
    if (sep != std::string::npos) {
        key_name = label.substr(0, sep);
        scale = label.substr(sep + 1);
    }

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
