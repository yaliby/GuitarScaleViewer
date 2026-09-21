"""A chord-resolution chromagram, independent of libKeyFinder.

Why this exists. `headroom.py` says the true key is in the profile's top three for 82.2% of clips
but the engine keeps only 63.8% of them, and three different models have now failed to close that
gap using features derived from libKeyFinder's chromagram. They fail for the same reason: what
separates C major from G major is not *which* notes are present — they share six of seven — but
*which chord the music rests on and resolves to*, and libKeyFinder's FFT frame is 16384 samples at
a 4410 Hz working rate. That is a **3.7-second window**, which smears three or four chords into one
observation. No amount of modelling recovers information the front end averaged away.

The project has been here before: a chord-sequence key detector was built and scored 55.0/38.3,
losing badly to the plain profile. This is deliberately not that. Chords are not being asked to
name the key; they are being asked to break a tie between three candidates the profile has already
shortlisted, which is a far easier question and one where a noisy chord reading can still carry
useful evidence.

The pipeline:

  * decimate to 11025 Hz, which is well above the top of the pitch range that matters and makes
    everything downstream four times cheaper;
  * STFT at 8192/2048 — a 0.74 s window, five times sharper in time than libKeyFinder's, and still
    1.35 Hz per bin, enough to separate semitones down to the bottom of a bass guitar;
  * **harmonic-percussive separation** by median filtering. Drums are broadband and brief, so they
    survive a median across frequency and vanish under a median across time; pitched material does
    the opposite. This is the one thing the project has never tried, and the measured failure of
    the tonic-evidence gate on real audio was blamed on exactly this: "drums, distortion, vocals
    and reverb put energy in all twelve chroma bins";
  * per-song **tuning estimation**, because a global pitch offset was tested and lost but a
    per-recording one has not been;
  * a log-frequency filterbank to semitones, folded to twelve pitch classes.
"""
from __future__ import annotations

import wave

import numpy as np
from scipy import ndimage, signal

TARGET_RATE = 11025
N_FFT = 8192
HOP = 2048
MIN_MIDI = 28   # E1, below a five-string bass
MAX_MIDI = 96   # C7
EPS = 1e-12


def read_wav_mono(path: str) -> tuple[np.ndarray, int]:
    with wave.open(path) as w:
        rate = w.getframerate()
        channels = w.getnchannels()
        width = w.getsampwidth()
        raw = w.readframes(w.getnframes())
    if width != 2:
        raise ValueError(f"{path}: expected 16-bit PCM, got {width * 8}-bit")
    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    return samples, rate


def lowpass_kernel(taps: int, cutoff: float) -> np.ndarray:
    """Hamming-windowed sinc, written out rather than taken from a library.

    The C++ front end in `src-tauri/sidecars/libkeyfinder_cli/chord_frontend.cpp` has to produce
    the same features as this file, because the weights fitted here are applied there. A library
    decimator would be a different filter with a different phase response on each side, so the
    filter is specified rather than chosen — and being symmetric, a `same`-mode convolution against
    it is identical whichever way the two implementations index it.
    """
    n = np.arange(taps)
    centre = (taps - 1) / 2.0
    x = n - centre
    with np.errstate(invalid="ignore", divide="ignore"):
        sinc = np.where(np.abs(x) < 1e-9, 2.0 * cutoff, np.sin(2.0 * np.pi * cutoff * x) / (np.pi * x))
    window = 0.54 - 0.46 * np.cos(2.0 * np.pi * n / (taps - 1))
    kernel = sinc * window
    return kernel / kernel.sum()


def to_target_rate(samples: np.ndarray, rate: int) -> np.ndarray:
    if rate == TARGET_RATE:
        return samples
    if rate % TARGET_RATE != 0:
        duration = len(samples) / rate
        return signal.resample(samples, int(duration * TARGET_RATE))
    factor = rate // TARGET_RATE
    # Two stages at factor 4, which is the 44.1 kHz case every corpus clip takes: an 81-tap filter
    # doing the whole job at once leaves a stopband that folds audible energy back under 2 kHz.
    while factor > 1:
        step = 2 if factor % 2 == 0 else factor
        kernel = lowpass_kernel(81, 0.5 / step)
        samples = np.convolve(samples, kernel, mode="same")[::step]
        factor //= step
    return samples


def spectrogram(samples: np.ndarray) -> np.ndarray:
    """(bins, frames) magnitude, Hann windowed."""
    _, _, Z = signal.stft(
        samples, fs=TARGET_RATE, window="hann", nperseg=N_FFT, noverlap=N_FFT - HOP,
        boundary=None, padded=False,
    )
    return np.abs(Z)


def harmonic_part(magnitude: np.ndarray, time_kernel: int = 17, freq_kernel: int = 17) -> np.ndarray:
    """Soft-mask out percussion.

    A drum hit is wide in frequency and short in time, so a median along the time axis erases it
    while leaving sustained pitches intact; a median along the frequency axis does the reverse. The
    ratio of the two gives a soft mask rather than a hard decision, which matters because most
    real frames are a mixture rather than one or the other.
    """
    harmonic = ndimage.median_filter(magnitude, size=(1, time_kernel), mode="nearest")
    percussive = ndimage.median_filter(magnitude, size=(freq_kernel, 1), mode="nearest")
    mask = harmonic**2 / (harmonic**2 + percussive**2 + EPS)
    return magnitude * mask


def pitch_filterbank(offset_cents: float = 0.0, bins_per_semitone: int = 1) -> np.ndarray:
    """(pitches, fft_bins) triangular weights centred on equal-tempered pitches."""
    freqs = np.fft.rfftfreq(N_FFT, 1.0 / TARGET_RATE)
    steps = np.arange(
        MIN_MIDI * bins_per_semitone, MAX_MIDI * bins_per_semitone
    ) / bins_per_semitone
    centres = 440.0 * 2 ** ((steps - 69.0) / 12.0) * 2 ** (offset_cents / 1200.0)
    # A half-semitone half-width makes adjacent filters meet at their -0 point, so energy is
    # assigned to one semitone or split between two neighbours and never counted twice.
    lower = centres * 2 ** (-0.5 / 12.0)
    upper = centres * 2 ** (0.5 / 12.0)
    bank = np.zeros((len(centres), len(freqs)))
    for i, (lo, mid, hi) in enumerate(zip(lower, centres, upper)):
        left = (freqs - lo) / max(mid - lo, EPS)
        right = (hi - freqs) / max(hi - mid, EPS)
        bank[i] = np.clip(np.minimum(left, right), 0.0, None)
    return bank


def estimate_tuning_cents(magnitude: np.ndarray) -> float:
    """How far this recording sits from A440, in cents, by trying a grid of offsets.

    A recording that is 30 cents sharp puts every partial between two filterbank bins, which halves
    the contrast of the chromagram. Picking the offset whose pitch spectrum is *peakiest* finds the
    alignment without needing to identify a single note.
    """
    best_offset, best_score = 0.0, -np.inf
    average = magnitude.mean(axis=1)
    for offset in np.arange(-50, 51, 10.0):
        bank = pitch_filterbank(offset)
        energy = bank @ average
        total = energy.sum()
        if total <= EPS:
            continue
        # Peakiness: normalised sum of squares, maximal when energy concentrates on few pitches.
        score = float(((energy / total) ** 2).sum())
        if score > best_score:
            best_offset, best_score = float(offset), score
    return best_offset


def chromagram(path: str, remove_percussion: bool = True, tune: bool = True) -> dict:
    """Pitch-class energy over time, at chord resolution."""
    samples, rate = read_wav_mono(path)
    samples = to_target_rate(samples, rate)
    magnitude = spectrogram(samples)
    if remove_percussion:
        magnitude = harmonic_part(magnitude)
    offset = estimate_tuning_cents(magnitude) if tune else 0.0
    bank = pitch_filterbank(offset)
    pitches = bank @ magnitude                       # (semitones, frames)
    chroma = np.zeros((12, pitches.shape[1]))
    for i in range(pitches.shape[0]):
        chroma[(MIN_MIDI + i) % 12] += pitches[i]
    bass = np.zeros((12, pitches.shape[1]))
    for i in range(pitches.shape[0]):
        midi = MIN_MIDI + i
        if midi < 55:                                # below G3: where a bass line lives
            bass[midi % 12] += pitches[i]
    return dict(
        chroma=chroma, bass=bass, pitches=pitches,
        tuning_cents=offset, frame_seconds=HOP / TARGET_RATE,
    )
