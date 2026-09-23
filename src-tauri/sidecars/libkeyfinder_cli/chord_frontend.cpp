#include "chord_frontend.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <complex>
#include <cstdlib>
#include <cstdio>
#include <numeric>

namespace gsv {
namespace {

constexpr int TARGET_RATE = 11025;
constexpr int N_FFT = 8192;
constexpr int HOP = 2048;
constexpr int MIN_MIDI = 28;   // E1, below a five-string bass
constexpr int MAX_MIDI = 96;   // C7
constexpr int PITCH_COUNT = MAX_MIDI - MIN_MIDI;
constexpr int BASS_MAX_MIDI = 55;  // below G3, where a bass line lives
constexpr int MEDIAN_KERNEL = 17;

/// How many frames of chord evidence are averaged before the chord is decided: 4 frames is 0.74s.
///
/// Measured over the real corpus, everything else held: 0.7s scores 77.2/68.3, 1.5s 76.2/67.0,
/// 3.0s 75.9/65.2, 4.5s 75.7/64.1, and going the other way 0.37s falls to 76.0/64.7. Less smoothing
/// than a chord lasts, which reads oddly until you notice that the STFT window is already 0.74s
/// wide — the evidence arriving at this step has been averaged once already, and the features that
/// pay are the ones counting *where a phrase lands*, which a second averaging blurs away.
constexpr int SMOOTH_FRAMES = 4;

/// How much the bass register's own pitch profile counts toward naming a chord.
///
/// A chord's root in the bass is what makes it that chord rather than an inversion of its
/// neighbour. 0.0 scores 76.3/67.3, 0.3 scores 77.2/68.3, 0.6 scores 76.8/66.8, 1.0 scores
/// 76.3/66.4 — a shallow interior optimum, so this is a hint and not a vote.
constexpr double BASS_WEIGHT = 0.3;
constexpr double EPS = 1e-12;

/// Windowed-sinc low-pass, spelled out rather than taken from a library.
///
/// The research harness that fitted the weights this feeds is Python, and the two have to agree. A
/// library's decimator would be a different filter with a different phase response on each side, so
/// the filter is defined here and reproduced there instead of the other way round.
std::vector<double> lowpass_kernel(int taps, double cutoff) {
    std::vector<double> kernel(taps);
    const double centre = (taps - 1) / 2.0;
    double total = 0.0;
    for (int i = 0; i < taps; i++) {
        const double x = i - centre;
        const double sinc = (std::abs(x) < 1e-9)
                                ? 2.0 * cutoff
                                : std::sin(2.0 * M_PI * cutoff * x) / (M_PI * x);
        // Hamming window: the sidelobe floor matters more here than the main-lobe width, because
        // anything that survives above the new Nyquist folds back on top of real partials.
        const double window = 0.54 - 0.46 * std::cos(2.0 * M_PI * i / (taps - 1));
        kernel[i] = sinc * window;
        total += kernel[i];
    }
    for (double& v : kernel) {
        v /= total;
    }
    return kernel;
}

std::vector<double> decimate(const std::vector<double>& input, int factor) {
    if (factor <= 1) {
        return input;
    }
    const std::vector<double> kernel = lowpass_kernel(81, 0.5 / factor);
    const int taps = static_cast<int>(kernel.size());
    const int half = taps / 2;
    const long length = static_cast<long>(input.size());
    std::vector<double> out;
    out.reserve(input.size() / factor + 1);
    for (long centre = 0; centre < length; centre += factor) {
        double acc = 0.0;
        // The first and last forty samples are the only ones that can run off the end, and they are
        // a rounding error's worth of a sixty-second buffer. Splitting the interior out of the
        // bounds check is the whole optimisation, and it changes no output value.
        if (centre >= half && centre + half < length) {
            const double* window = input.data() + centre - half;
            for (int k = 0; k < taps; k++) {
                acc += kernel[k] * window[k];
            }
        } else {
            for (int k = 0; k < taps; k++) {
                const long index = centre + k - half;
                if (index >= 0 && index < length) {
                    acc += kernel[k] * input[index];
                }
            }
        }
        out.push_back(acc);
    }
    return out;
}

/// Iterative radix-2 FFT. N_FFT is a power of two by construction, so this needs no general case.
///
/// Written out rather than linked because the packaged app already has to carry libkeyfinder.so
/// beside the binary, and adding a second native dependency for one transform is a worse trade than
/// forty lines of Cooley-Tukey.
void fft_in_place(std::vector<std::complex<double>>& data) {
    const size_t n = data.size();
    for (size_t i = 1, j = 0; i < n; i++) {
        size_t bit = n >> 1;
        for (; j & bit; bit >>= 1) {
            j ^= bit;
        }
        j ^= bit;
        if (i < j) {
            std::swap(data[i], data[j]);
        }
    }
    for (size_t len = 2; len <= n; len <<= 1) {
        const double angle = -2.0 * M_PI / static_cast<double>(len);
        const std::complex<double> step(std::cos(angle), std::sin(angle));
        for (size_t i = 0; i < n; i += len) {
            std::complex<double> w(1.0, 0.0);
            for (size_t k = 0; k < len / 2; k++) {
                const std::complex<double> u = data[i + k];
                const std::complex<double> v = data[i + k + len / 2] * w;
                data[i + k] = u + v;
                data[i + k + len / 2] = u - v;
                w *= step;
            }
        }
    }
}

/// (bins, frames) magnitude spectrogram, Hann windowed, no boundary padding.
std::vector<std::vector<double>> spectrogram(const std::vector<double>& samples, int& frames_out) {
    const int bins = N_FFT / 2 + 1;
    const int frames = samples.size() >= static_cast<size_t>(N_FFT)
                           ? static_cast<int>((samples.size() - N_FFT) / HOP) + 1
                           : 0;
    frames_out = frames;
    std::vector<std::vector<double>> out(bins, std::vector<double>(std::max(frames, 0), 0.0));
    if (frames <= 0) {
        return out;
    }
    std::vector<double> window(N_FFT);
    for (int i = 0; i < N_FFT; i++) {
        window[i] = 0.5 - 0.5 * std::cos(2.0 * M_PI * i / N_FFT);
    }
    std::vector<std::complex<double>> buffer(N_FFT);
    for (int frame = 0; frame < frames; frame++) {
        const size_t start = static_cast<size_t>(frame) * HOP;
        for (int i = 0; i < N_FFT; i++) {
            buffer[i] = std::complex<double>(samples[start + i] * window[i], 0.0);
        }
        fft_in_place(buffer);
        for (int bin = 0; bin < bins; bin++) {
            out[bin][frame] = std::abs(buffer[bin]);
        }
    }
    return out;
}

/// A median over a sliding window of fixed width, kept sorted between steps.
///
/// The separation takes about a million medians per analysis and an analysis happens every four
/// seconds, so the difference between re-selecting the window each time and maintaining it is worth
/// having. Removing one value and inserting another into a sorted array of seventeen is two short
/// binary searches and two small memmoves; `nth_element` on the same seventeen is several times
/// that, because it cannot assume anything about the order it starts from.
///
/// The result is identical either way — the window holds the same multiset — so this changes no
/// output value and needs no refit.
template <int Kernel>
class SlidingMedianOf {
  public:
    void reset(const double* values, int count) {
        for (int i = 0; i < count; i++) {
            sorted_[i] = values[i];
        }
        std::sort(sorted_, sorted_ + count);
        size_ = count;
    }

    /// Drop one instance of `outgoing`, add `incoming`, and return the new median.
    double slide(double outgoing, double incoming) {
        double* at = std::lower_bound(sorted_, sorted_ + size_, outgoing);
        // `lower_bound` lands on the first equal element, and any instance will do since they
        // compare equal. A miss can only mean a NaN got in, and shifting nothing is the safe
        // response — the window stays the right size.
        if (at != sorted_ + size_) {
            std::move(at + 1, sorted_ + size_, at);
            size_--;
        }
        double* into = std::lower_bound(sorted_, sorted_ + size_, incoming);
        std::move_backward(into, sorted_ + size_, sorted_ + size_ + 1);
        *into = incoming;
        size_++;
        return sorted_[size_ / 2];
    }

    double median() const { return sorted_[size_ / 2]; }

  private:
    double sorted_[Kernel + 1];
    int size_ = 0;
};
using SlidingMedian = SlidingMedianOf<MEDIAN_KERNEL>;

/// Soft-mask percussion out of the spectrogram.
void remove_percussion(std::vector<std::vector<double>>& magnitude, int bin_limit) {
    const int bins = static_cast<int>(magnitude.size());
    const int frames = bins > 0 ? static_cast<int>(magnitude[0].size()) : 0;
    if (frames == 0) {
        return;
    }
    const int half = MEDIAN_KERNEL / 2;
    const int top = std::min(bins, bin_limit);

    std::vector<std::vector<double>> harmonic(top, std::vector<double>(frames, 0.0));
    double window[MEDIAN_KERNEL];
    SlidingMedian running;

    auto clamped = [](const std::vector<double>& row, int index, int limit) {
        return row[std::min(std::max(index, 0), limit - 1)];
    };

    // Along time: each row is contiguous, so this walks memory in order.
    for (int bin = 0; bin < top; bin++) {
        const std::vector<double>& row = magnitude[bin];
        std::vector<double>& out = harmonic[bin];
        for (int k = 0; k < MEDIAN_KERNEL; k++) {
            window[k] = clamped(row, k - half, frames);
        }
        running.reset(window, MEDIAN_KERNEL);
        out[0] = running.median();
        for (int frame = 1; frame < frames; frame++) {
            out[frame] = running.slide(clamped(row, frame - 1 - half, frames),
                                       clamped(row, frame + half, frames));
        }
    }

    // Along frequency the same window spans seventeen *different* rows, which is a cache miss per
    // sample if walked the obvious way. Copying the column out first turns it back into a linear
    // walk — this was the single most expensive thing in the analysis.
    //
    // It also fixes a real defect. Writing the mask back in place while the window still had to
    // read eight bins below meant the filter saw values it had already modified, so the separation
    // was not the median filter it claims to be and drifted further from the reference
    // implementation the weights were fitted against the further up the spectrum it went.
    std::vector<double> column(bins);
    for (int frame = 0; frame < frames; frame++) {
        for (int bin = 0; bin < bins; bin++) {
            column[bin] = magnitude[bin][frame];
        }
        for (int k = 0; k < MEDIAN_KERNEL; k++) {
            window[k] = clamped(column, k - half, bins);
        }
        running.reset(window, MEDIAN_KERNEL);
        for (int bin = 0; bin < top; bin++) {
            const double percussive =
                bin == 0 ? running.median()
                         : running.slide(clamped(column, bin - 1 - half, bins),
                                         clamped(column, bin + half, bins));
            const double h = harmonic[bin][frame];
            const double mask = (h * h) / (h * h + percussive * percussive + EPS);
            magnitude[bin][frame] = column[bin] * mask;
        }
    }
}

/// Triangular weights from FFT bins onto equal-tempered pitches, offset by `cents`.
///
/// Sparse, because it has to be: a semitone is half a percent of the spectrum, so a dense
/// (68 x 1560) bank is 99% zeros, and the tuning search builds one for each of eleven candidate
/// offsets. Storing only the live span per pitch turns 75 MB of allocation into a few kilobytes.
struct PitchBand {
    int first_bin = 0;
    std::vector<double> weights;
};

std::vector<PitchBand> pitch_filterbank(double cents, int bins) {
    std::vector<PitchBand> bank(PITCH_COUNT);
    const double bin_hz = static_cast<double>(TARGET_RATE) / N_FFT;
    for (int p = 0; p < PITCH_COUNT; p++) {
        const double midi = MIN_MIDI + p;
        const double centre = 440.0 * std::pow(2.0, (midi - 69.0) / 12.0) *
                              std::pow(2.0, cents / 1200.0);
        // A half-semitone half-width makes adjacent filters meet exactly, so energy is assigned to
        // one semitone or split between two neighbours and never counted twice.
        const double lo = centre * std::pow(2.0, -0.5 / 12.0);
        const double hi = centre * std::pow(2.0, 0.5 / 12.0);
        const int first = std::max(0, static_cast<int>(std::floor(lo / bin_hz)));
        const int last = std::min(bins - 1, static_cast<int>(std::ceil(hi / bin_hz)));
        if (last < first) {
            continue;
        }
        bank[p].first_bin = first;
        bank[p].weights.resize(last - first + 1, 0.0);
        for (int bin = first; bin <= last; bin++) {
            const double f = bin * bin_hz;
            const double left = (f - lo) / std::max(centre - lo, EPS);
            const double right = (hi - f) / std::max(hi - centre, EPS);
            bank[p].weights[bin - first] = std::max(0.0, std::min(left, right));
        }
    }
    return bank;
}

double estimate_tuning_cents(const std::vector<std::vector<double>>& magnitude, int bins) {
    const int frames = magnitude.empty() ? 0 : static_cast<int>(magnitude[0].size());
    if (frames == 0) {
        return 0.0;
    }
    std::vector<double> average(bins, 0.0);
    for (int bin = 0; bin < bins; bin++) {
        average[bin] = std::accumulate(magnitude[bin].begin(), magnitude[bin].end(), 0.0) / frames;
    }
    double best_offset = 0.0;
    double best_score = -1.0;
    for (double cents = -50.0; cents <= 50.5; cents += 10.0) {
        const std::vector<PitchBand> bank = pitch_filterbank(cents, bins);
        double total = 0.0;
        std::vector<double> energy(PITCH_COUNT, 0.0);
        for (int p = 0; p < PITCH_COUNT; p++) {
            double acc = 0.0;
            for (size_t i = 0; i < bank[p].weights.size(); i++) {
                acc += bank[p].weights[i] * average[bank[p].first_bin + i];
            }
            energy[p] = acc;
            total += acc;
        }
        if (total <= EPS) {
            continue;
        }
        // Peakiness: maximal when energy concentrates on few pitches, which is what happens when
        // the filterbank lines up with the recording's actual tuning.
        double score = 0.0;
        for (double v : energy) {
            score += (v / total) * (v / total);
        }
        if (score > best_score) {
            best_score = score;
            best_offset = cents;
        }
    }
    return best_offset;
}

std::vector<std::vector<double>> triad_templates() {
    std::vector<std::vector<double>> out(CANDIDATE_COUNT, std::vector<double>(12, 0.0));
    const int intervals[2][3] = {{0, 4, 7}, {0, 3, 7}};  // major, minor
    for (int pitch = 0; pitch < 12; pitch++) {
        for (int quality = 0; quality < 2; quality++) {
            std::vector<double>& row = out[2 * pitch + quality];
            for (int i = 0; i < 3; i++) {
                row[(pitch + intervals[quality][i]) % 12] = 1.0;
            }
            const double norm = std::sqrt(3.0);
            for (double& v : row) {
                v /= norm;
            }
        }
    }
    return out;
}

void smooth_rows(std::vector<std::vector<double>>& rows, int width) {
    if (width <= 1 || rows.empty()) {
        return;
    }
    const int frames = static_cast<int>(rows[0].size());
    // Matches numpy's convolve(..., mode="same") against a uniform kernel: the window is centred,
    // truncated at the edges, and always divided by the full width rather than the live count.
    //
    // The offset is `(width - 1) / 2`, not `width / 2`. They agree for odd widths and differ by one
    // frame for even ones, which is enough to move a chord boundary — and a chord boundary is what
    // `opens_on_tonic` and the cadence counts are reading.
    const int left = (width - 1) / 2;
    for (std::vector<double>& row : rows) {
        std::vector<double> out(frames, 0.0);
        for (int frame = 0; frame < frames; frame++) {
            double acc = 0.0;
            for (int k = 0; k < width; k++) {
                const int index = frame + left - k;
                if (index >= 0 && index < frames) {
                    acc += row[index];
                }
            }
            out[frame] = acc / width;
        }
        row.swap(out);
    }
}

/// Stage timings to stderr under `GSV_CHORD_TIMING=1`.
///
/// This runs on the app's own machine every four seconds for as long as the player has it open, so
/// what it costs is a product decision and not an implementation detail. Keeping the measurement in
/// the code means the next person to change a stage can see what they changed.
struct StageTimer {
    using Clock = std::chrono::steady_clock;
    const bool enabled = std::getenv("GSV_CHORD_TIMING") != nullptr;
    Clock::time_point mark = Clock::now();

    void lap(const char* stage) {
        if (!enabled) {
            return;
        }
        const auto now = Clock::now();
        std::fprintf(stderr, "  %-16s %6.1f ms\n", stage,
                     std::chrono::duration<double, std::milli>(now - mark).count());
        mark = now;
    }
};

struct Run {
    int chord;
    int length;
};

/// The separation pass that runs before libKeyFinder: a short STFT at the chord front end's working
/// rate. 2048 samples at 11025 Hz is a 0.19 s window with a 46 ms hop and 5.4 Hz per bin — sharp
/// enough in time that a drum hit is a spike across one or two frames, sharp enough in frequency
/// that a held note is a line along one bin.
constexpr int SEPARATION_N_FFT = 2048;
constexpr int SEPARATION_HOP = 512;

/// Both median widths, in frames along time and bins along frequency: 1.4 s and 167 Hz.
///
/// Measured out of fold on the real corpus with the profile refitted to the separated audio
/// (`scripts/key-research/exp_hpss_audio.py`): 17 and 31 both gain at every buffer length, and 31
/// is the better of the two where the player starts listening — 68.2 / 59.7 at twelve seconds
/// against 67.9 / 58.4, and 66.7 / 55.5 for no separation at all.
constexpr int SEPARATION_KERNEL = 31;

/// libKeyFinder decimates by ten before it builds its chromagram, so at 44.1 kHz nothing above
/// 2.2 kHz ever reaches it. Separating up to a little past that and zeroing the rest halves the
/// median work and changes nothing the classifier can see.
constexpr double SEPARATION_TOP_HZ = 2600.0;

void inverse_fft_in_place(std::vector<std::complex<double>>& data) {
    for (std::complex<double>& v : data) {
        v = std::conj(v);
    }
    fft_in_place(data);
    const double n = static_cast<double>(data.size());
    for (std::complex<double>& v : data) {
        v = std::conj(v) / n;
    }
}

/// Interpolate by `factor`, a power of two, two at a time with the same windowed sinc `decimate`
/// uses — the inverse of the path the audio took down, so a round trip with nothing removed in
/// between leaves libKeyFinder's verdicts as they were (measured: identical on every clip).
std::vector<double> upsample(const std::vector<double>& input, int factor) {
    std::vector<double> working = input;
    const std::vector<double> kernel = lowpass_kernel(81, 0.25);
    const int taps = static_cast<int>(kernel.size());
    const int half = taps / 2;
    while (factor > 1) {
        const long in_len = static_cast<long>(working.size());
        const long out_len = in_len * 2;
        std::vector<double> out(out_len, 0.0);
        for (long i = 0; i < out_len; i++) {
            // The zero-stuffed signal is non-zero only at even positions, so only every other tap
            // lands on a sample. Doubling restores the energy the inserted zeros took away.
            double acc = 0.0;
            for (int k = static_cast<int>(((half - i) % 2 + 2) % 2); k < taps; k += 2) {
                const long position = i + k - half;
                if (position >= 0 && position < out_len) {
                    acc += kernel[k] * working[position / 2];
                }
            }
            out[i] = 2.0 * acc;
        }
        working.swap(out);
        factor /= 2;
    }
    return working;
}

std::vector<Run> runs_of(const std::vector<int>& sequence) {
    std::vector<Run> out;
    for (int chord : sequence) {
        if (!out.empty() && out.back().chord == chord) {
            out.back().length++;
        } else {
            out.push_back({chord, 1});
        }
    }
    return out;
}

}  // namespace

const char* const CHORD_FEATURE_NAMES[] = {
    "time_on_tonic", "time_on_relative_tonic", "time_on_V_major", "time_on_IV_major",
    "time_on_iv_minor", "time_on_ii_minor", "time_on_vi_minor", "time_on_III_major",
    "time_on_VII_major", "time_diatonic", "changes_into_tonic", "cadence_V_to_tonic",
    "cadence_IV_to_tonic", "cadence_VII_to_tonic", "opens_on_tonic", "closes_on_tonic",
    "most_common_is_tonic", "longest_run_is_tonic",
};

ChordEvidence analyse_chords(const std::vector<float>& samples, int channels, int sample_rate,
                             bool want_diagnostics) {
    ChordEvidence evidence;
    evidence.features.assign(CANDIDATE_COUNT, std::vector<double>(CHORD_FEATURE_COUNT, 0.0));
    if (samples.empty() || channels <= 0 || sample_rate <= 0) {
        return evidence;
    }

    StageTimer timer;
    const size_t frame_count = samples.size() / static_cast<size_t>(channels);
    std::vector<double> mono(frame_count, 0.0);
    for (size_t i = 0; i < frame_count; i++) {
        double acc = 0.0;
        for (int c = 0; c < channels; c++) {
            acc += samples[i * channels + c];
        }
        mono[i] = acc / channels;
    }

    // Down to the working rate.
    //
    // The app feeds 44100 (`ANALYZER_SAMPLE_RATE_HZ` in audio_capture.rs resamples the 48 kHz
    // capture to it), which is exactly four times the working rate, and that integer path is the
    // one the shipped features were fitted against. Any other rate is resampled instead — worth
    // the extra branch because the alternative is that changing one constant in the Rust side
    // silently switches the whole chord tie-break off and costs two and a half points of accuracy
    // with nothing in the logs to say so.
    std::vector<double> working = mono;
    if (sample_rate != TARGET_RATE) {
        if (sample_rate % TARGET_RATE == 0) {
            int factor = sample_rate / TARGET_RATE;
            while (factor > 1) {
                const int step = (factor % 2 == 0) ? 2 : factor;
                working = decimate(working, step);
                factor /= step;
            }
        } else {
            const double ratio = static_cast<double>(TARGET_RATE) / sample_rate;
            if (ratio < 1.0) {
                // Band-limit first, or everything above the new Nyquist folds down on top of the
                // partials the filterbank is about to measure.
                const std::vector<double> kernel = lowpass_kernel(81, 0.5 * ratio);
                std::vector<double> filtered(working.size(), 0.0);
                const int half = static_cast<int>(kernel.size()) / 2;
                const long length = static_cast<long>(working.size());
                for (long i = 0; i < length; i++) {
                    double acc = 0.0;
                    for (int k = 0; k < static_cast<int>(kernel.size()); k++) {
                        const long index = i + k - half;
                        if (index >= 0 && index < length) {
                            acc += kernel[k] * working[index];
                        }
                    }
                    filtered[i] = acc;
                }
                working.swap(filtered);
            }
            const size_t out_count = static_cast<size_t>(working.size() * ratio);
            std::vector<double> resampled(out_count, 0.0);
            for (size_t i = 0; i < out_count; i++) {
                const double position = i / ratio;
                const size_t left = static_cast<size_t>(position);
                const double fraction = position - left;
                const double a = working[std::min(left, working.size() - 1)];
                const double b = working[std::min(left + 1, working.size() - 1)];
                resampled[i] = a + fraction * (b - a);
            }
            working.swap(resampled);
        }
    }

    timer.lap("decimate");

    int frames = 0;
    std::vector<std::vector<double>> magnitude = spectrogram(working, frames);
    timer.lap("stft");
    if (frames <= 0) {
        return evidence;
    }
    const int bins = static_cast<int>(magnitude.size());
    // Everything above C7 is outside the pitch range that is mapped, so nothing below cares about
    // it. Bounding the median filter here is most of what makes this affordable.
    const double top_hz = 440.0 * std::pow(2.0, (MAX_MIDI + 1 - 69.0) / 12.0);
    const int bin_limit = std::min(bins, static_cast<int>(top_hz * N_FFT / TARGET_RATE) + 2);

    remove_percussion(magnitude, bin_limit);
    timer.lap("hpss");
    evidence.tuning_cents = estimate_tuning_cents(magnitude, bin_limit);
    timer.lap("tuning");

    const std::vector<PitchBand> bank = pitch_filterbank(evidence.tuning_cents, bin_limit);
    std::vector<std::vector<double>> chroma(12, std::vector<double>(frames, 0.0));
    std::vector<std::vector<double>> bass(12, std::vector<double>(frames, 0.0));
    for (int p = 0; p < PITCH_COUNT; p++) {
        const int pitch_class = (MIN_MIDI + p) % 12;
        const bool in_bass = (MIN_MIDI + p) < BASS_MAX_MIDI;
        for (size_t i = 0; i < bank[p].weights.size(); i++) {
            const double weight = bank[p].weights[i];
            if (weight <= 0.0) {
                continue;
            }
            const std::vector<double>& row = magnitude[bank[p].first_bin + i];
            for (int frame = 0; frame < frames; frame++) {
                const double value = weight * row[frame];
                chroma[pitch_class][frame] += value;
                if (in_bass) {
                    bass[pitch_class][frame] += value;
                }
            }
        }
    }

    timer.lap("filterbank");

    // --- chord sequence -------------------------------------------------------------------
    const std::vector<std::vector<double>> templates = triad_templates();
    std::vector<std::vector<double>> scores(CANDIDATE_COUNT, std::vector<double>(frames, 0.0));
    for (int frame = 0; frame < frames; frame++) {
        double norm = 0.0;
        double bass_total = 0.0;
        for (int pc = 0; pc < 12; pc++) {
            norm += chroma[pc][frame] * chroma[pc][frame];
            bass_total += bass[pc][frame];
        }
        norm = std::sqrt(norm);
        for (int chord = 0; chord < CANDIDATE_COUNT; chord++) {
            double dot = 0.0;
            if (norm > EPS) {
                for (int pc = 0; pc < 12; pc++) {
                    dot += templates[chord][pc] * chroma[pc][frame] / norm;
                }
            }
            // A chord's root in the bass is what makes it that chord rather than an inversion of
            // its neighbour, and a collapsed chroma cannot see it.
            if (bass_total > EPS) {
                dot += BASS_WEIGHT * bass[chord / 2][frame] / bass_total;
            }
            scores[chord][frame] = dot;
        }
    }
    smooth_rows(scores, SMOOTH_FRAMES);

    std::vector<int> sequence(frames, 0);
    for (int frame = 0; frame < frames; frame++) {
        int best = 0;
        for (int chord = 1; chord < CANDIDATE_COUNT; chord++) {
            if (scores[chord][frame] > scores[best][frame]) {
                best = chord;
            }
        }
        sequence[frame] = best;
    }

    timer.lap("chords");

    // --- features -------------------------------------------------------------------------
    std::vector<double> occupancy(CANDIDATE_COUNT, 0.0);
    for (int chord : sequence) {
        occupancy[chord] += 1.0 / frames;
    }
    const std::vector<Run> segments = runs_of(sequence);
    int longest_chord = segments.empty() ? -1 : segments[0].chord;
    int longest_length = 0;
    for (const Run& run : segments) {
        if (run.length > longest_length) {
            longest_length = run.length;
            longest_chord = run.chord;
        }
    }
    int most_common = 0;
    for (int chord = 1; chord < CANDIDATE_COUNT; chord++) {
        if (occupancy[chord] > occupancy[most_common]) {
            most_common = chord;
        }
    }
    const int change_count = std::max<int>(static_cast<int>(segments.size()) - 1, 1);

    // Candidate order matches libKeyFinder's key_t: A major, A minor, A# major, ...
    const int MAJOR_DEGREES[6][2] = {{0, 0}, {2, 1}, {4, 1}, {5, 0}, {7, 0}, {9, 1}};
    const int MINOR_DEGREES[7][2] = {{0, 1}, {3, 0}, {5, 1}, {7, 1}, {7, 0}, {8, 0}, {10, 0}};

    for (int candidate = 0; candidate < CANDIDATE_COUNT; candidate++) {
        const int root = (9 + candidate / 2) % 12;
        const bool is_major = (candidate % 2 == 0);
        auto chord_index = [&](int interval, bool major) {
            return 2 * ((root + interval) % 12) + (major ? 0 : 1);
        };
        const int tonic = chord_index(0, is_major);
        const int relative = is_major ? chord_index(9, false) : chord_index(3, true);

        int into_tonic = 0;
        int from_v = 0;
        int from_iv = 0;
        int from_vii = 0;
        for (size_t i = 0; i + 1 < segments.size(); i++) {
            if (segments[i + 1].chord != tonic) {
                continue;
            }
            into_tonic++;
            if (segments[i].chord == chord_index(7, true)) from_v++;
            if (segments[i].chord == chord_index(5, true)) from_iv++;
            if (segments[i].chord == chord_index(10, true)) from_vii++;
        }

        double diatonic = 0.0;
        if (is_major) {
            for (const auto& degree : MAJOR_DEGREES) {
                diatonic += occupancy[chord_index(degree[0], degree[1] == 0)];
            }
        } else {
            for (const auto& degree : MINOR_DEGREES) {
                diatonic += occupancy[chord_index(degree[0], degree[1] == 0)];
            }
        }

        std::vector<double>& f = evidence.features[candidate];
        f[0] = occupancy[tonic];
        f[1] = occupancy[relative];
        f[2] = occupancy[chord_index(7, true)];
        f[3] = occupancy[chord_index(5, true)];
        f[4] = occupancy[chord_index(5, false)];
        f[5] = occupancy[chord_index(2, false)];
        f[6] = occupancy[chord_index(9, false)];
        f[7] = occupancy[chord_index(3, true)];
        f[8] = occupancy[chord_index(10, true)];
        f[9] = diatonic;
        f[10] = static_cast<double>(into_tonic) / change_count;
        f[11] = static_cast<double>(from_v) / change_count;
        f[12] = static_cast<double>(from_iv) / change_count;
        f[13] = static_cast<double>(from_vii) / change_count;
        f[14] = (!segments.empty() && segments.front().chord == tonic) ? 1.0 : 0.0;
        f[15] = (!segments.empty() && segments.back().chord == tonic) ? 1.0 : 0.0;
        f[16] = (most_common == tonic) ? 1.0 : 0.0;
        f[17] = (longest_chord == tonic) ? 1.0 : 0.0;
    }

    if (want_diagnostics) {
        evidence.chroma_totals.assign(12, 0.0);
        evidence.bass_totals.assign(12, 0.0);
        for (int pc = 0; pc < 12; pc++) {
            for (int frame = 0; frame < frames; frame++) {
                evidence.chroma_totals[pc] += chroma[pc][frame];
                evidence.bass_totals[pc] += bass[pc][frame];
            }
        }
        evidence.chord_labels = sequence;
    }

    evidence.frames = frames;
    evidence.valid = true;
    return evidence;
}

std::vector<float> harmonic_signal(const std::vector<float>& samples, int channels, int sample_rate) {
    const size_t frame_count = channels > 0 ? samples.size() / static_cast<size_t>(channels) : 0;
    std::vector<double> mono(frame_count, 0.0);
    for (size_t i = 0; i < frame_count; i++) {
        double acc = 0.0;
        for (int c = 0; c < channels; c++) {
            acc += samples[i * channels + c];
        }
        mono[i] = acc / channels;
    }
    auto as_float = [](const std::vector<double>& v, size_t length) {
        std::vector<float> out(length, 0.0f);
        for (size_t i = 0; i < length && i < v.size(); i++) {
            out[i] = static_cast<float>(v[i]);
        }
        return out;
    };

    // The app always sends 44100, four times the working rate. Any rate that is not a power-of-two
    // multiple of it is analysed unseparated rather than resampled twice — and says so, because a
    // separation that silently switches itself off costs accuracy with nothing in the logs.
    int factor = sample_rate > 0 && sample_rate % TARGET_RATE == 0 ? sample_rate / TARGET_RATE : 0;
    if (factor <= 0 || (factor & (factor - 1)) != 0) {
        std::fprintf(stderr, "separation_skipped: sample rate %d is not 11025 * 2^k\n", sample_rate);
        return as_float(mono, frame_count);
    }
    StageTimer timer;
    std::vector<double> working = mono;
    for (int step = factor; step > 1; step /= 2) {
        working = decimate(working, 2);
    }
    timer.lap("sep decimate");

    const int n = SEPARATION_N_FFT;
    const int hop = SEPARATION_HOP;
    const int pad = n / 2;
    const long length = static_cast<long>(working.size());
    if (length == 0) {
        return as_float(mono, frame_count);
    }
    // Zero-padded by half a window at each end, like scipy's `stft(boundary="zeros")`, so the first
    // and last samples are covered by as many frames as the middle ones and come back intact.
    const long frames = (length + 2 * pad - n + hop - 1) / hop + 1;
    std::vector<double> padded(static_cast<size_t>((frames - 1) * hop + n), 0.0);
    std::copy(working.begin(), working.end(), padded.begin() + pad);

    std::vector<double> window(n);
    for (int i = 0; i < n; i++) {
        window[i] = 0.5 - 0.5 * std::cos(2.0 * M_PI * i / n);
    }
    const int bins = n / 2 + 1;
    const int top = std::min(bins, static_cast<int>(std::ceil(SEPARATION_TOP_HZ * n / TARGET_RATE)) + 1);
    // The frequency median at the top separated bin reads half a kernel above it.
    const int read_top = std::min(bins, top + SEPARATION_KERNEL / 2 + 1);

    std::vector<std::vector<std::complex<double>>> spectra(frames);
    std::vector<std::vector<double>> magnitude(read_top, std::vector<double>(frames, 0.0));
    std::vector<std::complex<double>> buffer(n);
    for (long f = 0; f < frames; f++) {
        const double* start = padded.data() + f * hop;
        for (int i = 0; i < n; i++) {
            buffer[i] = std::complex<double>(start[i] * window[i], 0.0);
        }
        fft_in_place(buffer);
        spectra[f].assign(buffer.begin(), buffer.begin() + bins);
        for (int bin = 0; bin < read_top; bin++) {
            magnitude[bin][f] = std::abs(buffer[bin]);
        }
    }
    timer.lap("sep stft");

    // The soft mask, H^2 / (H^2 + P^2): H a median along time (held notes survive it, hits do not),
    // P a median along frequency (hits survive it, held notes do not). Edges repeat the nearest
    // value, as scipy's `mode="nearest"` does.
    const int half = SEPARATION_KERNEL / 2;
    std::vector<std::vector<double>> harmonic(top, std::vector<double>(frames, 0.0));
    double window_values[SEPARATION_KERNEL];
    SlidingMedianOf<SEPARATION_KERNEL> running;
    auto clamped = [](const std::vector<double>& row, long index, long limit) {
        return row[std::min(std::max(index, 0L), limit - 1)];
    };
    for (int bin = 0; bin < top; bin++) {
        const std::vector<double>& row = magnitude[bin];
        for (int k = 0; k < SEPARATION_KERNEL; k++) {
            window_values[k] = clamped(row, k - half, frames);
        }
        running.reset(window_values, SEPARATION_KERNEL);
        harmonic[bin][0] = running.median();
        for (long f = 1; f < frames; f++) {
            harmonic[bin][f] = running.slide(clamped(row, f - 1 - half, frames), clamped(row, f + half, frames));
        }
    }
    std::vector<double> column(read_top);
    for (long f = 0; f < frames; f++) {
        for (int bin = 0; bin < read_top; bin++) {
            column[bin] = magnitude[bin][f];
        }
        for (int k = 0; k < SEPARATION_KERNEL; k++) {
            window_values[k] = clamped(column, k - half, read_top);
        }
        running.reset(window_values, SEPARATION_KERNEL);
        for (int bin = 0; bin < top; bin++) {
            const double percussive =
                bin == 0 ? running.median()
                         : running.slide(clamped(column, bin - 1 - half, read_top),
                                         clamped(column, bin + half, read_top));
            const double h = harmonic[bin][f];
            spectra[f][bin] *= (h * h) / (h * h + percussive * percussive + EPS);
        }
        for (int bin = top; bin < bins; bin++) {
            spectra[f][bin] = 0.0;
        }
    }
    timer.lap("sep medians");

    // Inverse STFT: overlap-add of the windowed inverse transforms, divided by the summed squared
    // window, which is scipy's `istft` and reconstructs the input exactly when nothing was masked.
    std::vector<double> out(padded.size(), 0.0);
    std::vector<double> norm(padded.size(), 0.0);
    for (long f = 0; f < frames; f++) {
        for (int bin = 0; bin < bins; bin++) {
            buffer[bin] = spectra[f][bin];
        }
        for (int bin = bins; bin < n; bin++) {
            buffer[bin] = std::conj(spectra[f][n - bin]);
        }
        inverse_fft_in_place(buffer);
        double* target = out.data() + f * hop;
        double* weight = norm.data() + f * hop;
        for (int i = 0; i < n; i++) {
            target[i] += buffer[i].real() * window[i];
            weight[i] += window[i] * window[i];
        }
    }
    std::vector<double> separated(static_cast<size_t>(length), 0.0);
    for (long i = 0; i < length; i++) {
        const double w = norm[i + pad];
        separated[i] = w > 1e-10 ? out[i + pad] / w : 0.0;
    }
    timer.lap("sep istft");
    std::vector<float> result = as_float(upsample(separated, factor), frame_count);
    timer.lap("sep upsample");
    return result;
}

}  // namespace gsv
