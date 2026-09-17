#!/usr/bin/env python3
"""
Essentia-based key analyzer sidecar.

Protocol:
- argv includes `--analyze`
- stdin: JSON request
- stdout: JSON response:
  { "windows": [WindowAnalysisResult ...] }
"""

from __future__ import annotations

import json
import math
import os
import sys
import traceback
import wave
from dataclasses import dataclass
from typing import Iterable, List

np_err = None
try:
    import numpy as np
except Exception as exc:
    np = None
    np_err = str(exc)

es_err = None
try:
    import essentia.standard as es
except Exception as exc:
    es = None
    es_err = str(exc)

librosa = None
librosa_err = None

VERBOSE = os.environ.get("KEY_ANALYZER_VERBOSE", "1") not in ("0", "false", "False")


def _log(msg: str) -> None:
    if not VERBOSE:
        return
    print(f"[key_analyzer] {msg}", file=sys.stderr, flush=True)


@dataclass
class WindowResult:
    profile_type: str
    key: str
    scale: str
    display_name: str
    strength: float
    first_to_second_relative_strength: float | None
    window_start_ms: int
    window_end_ms: int
    candidates: list[dict] | None = None
    tuning_cents: float | None = None

    def to_wire(self) -> dict:
        return {
            "profileType": self.profile_type,
            "key": self.key,
            "scale": self.scale,
            "displayName": self.display_name,
            "strength": self.strength,
            "firstToSecondRelativeStrength": self.first_to_second_relative_strength,
            "windowStartMs": self.window_start_ms,
            "windowEndMs": self.window_end_ms,
            "candidates": self.candidates,
            "tuningCents": self.tuning_cents,
        }


def _iter_windows(
    samples: np.ndarray, sample_rate_hz: int, window_seconds: int, hop_seconds: int
) -> Iterable[tuple[int, int, np.ndarray]]:
    window_size = max(1, window_seconds * sample_rate_hz)
    hop_size = max(1, hop_seconds * sample_rate_hz)
    if len(samples) < window_size:
        return
    for start in range(0, len(samples) - window_size + 1, hop_size):
        end = start + window_size
        yield start, end, samples[start:end]


def _window_hpcp(window_samples: np.ndarray, sample_rate_hz: int) -> np.ndarray:
    frame_size = 4096
    hop_size = 2048
    if len(window_samples) < frame_size:
        return np.zeros(36, dtype=np.float32)

    windowing = es.Windowing(type="hann")
    spectrum = es.Spectrum(size=frame_size)
    spectral_peaks = es.SpectralPeaks(orderBy="magnitude", maxPeaks=120, sampleRate=sample_rate_hz)
    hpcp_algo = es.HPCP(
        sampleRate=sample_rate_hz,
        size=36,
        harmonics=8,
        referenceFrequency=440.0,
        minFrequency=40.0,
        maxFrequency=5000.0,
        weightType="cosine",
        windowSize=1.0,
    )

    acc = []
    for frame in es.FrameGenerator(window_samples.astype(np.float32), frameSize=frame_size, hopSize=hop_size, startFromZero=True):
        spec = spectrum(windowing(frame))
        freqs, mags = spectral_peaks(spec)
        if len(freqs) == 0:
            continue
        h = hpcp_algo(freqs, mags)
        acc.append(h)
    if not acc:
        return np.zeros(36, dtype=np.float32)
    return np.mean(np.asarray(acc), axis=0)


def _analyze_essentia(
    samples: np.ndarray, sample_rate_hz: int, window_seconds: int, hop_seconds: int, profiles: List[str]
) -> list[WindowResult]:
    results: list[WindowResult] = []
    total_windows = 0
    skipped_low_hpcp = 0
    for start, end, win in _iter_windows(samples, sample_rate_hz, window_seconds, hop_seconds) or []:
        total_windows += 1
        hpcp = _window_hpcp(win, sample_rate_hz)
        hpcp_peak = float(np.max(np.abs(hpcp))) if len(hpcp) else 0.0
        if hpcp_peak < 1e-6:
            skipped_low_hpcp += 1
            _log(
                f"essentia reject window={total_windows} startMs={math.floor(start * 1000 / sample_rate_hz)} "
                f"endMs={math.floor(end * 1000 / sample_rate_hz)} reason=low_hpcp peak={hpcp_peak:.8f}"
            )
            continue
        _log(
            f"essentia window={total_windows} startMs={math.floor(start * 1000 / sample_rate_hz)} "
            f"endMs={math.floor(end * 1000 / sample_rate_hz)} hpcp_peak={hpcp_peak:.6f}"
        )
        for profile in profiles:
            try:
                key_algo = es.Key(
                    profileType=profile,
                    pcpSize=36,
                    usePolyphony=True,
                    useThreeChords=True,
                )
                raw = key_algo(hpcp.astype(np.float32))
                if isinstance(raw, tuple):
                    key = raw[0]
                    scale = raw[1]
                    strength = raw[2]
                    first_to_second = float(raw[3]) if len(raw) > 3 else None
                else:
                    key = raw
                    scale = "major"
                    strength = 0.0
                    first_to_second = None
                _log(
                    f"essentia raw window={total_windows} profile={profile} key={key} "
                    f"scale={str(scale).lower()} strength={float(strength):.6f} "
                    f"firstToSecond={first_to_second}"
                )
            except Exception as exc:
                _log(
                    f"essentia reject window={total_windows} profile={profile} reason=key_exception error={exc}"
                )
                continue
            results.append(
                WindowResult(
                    profile_type=profile,
                    key=str(key),
                    scale=str(scale).lower(),
                    display_name=f"{key} {str(scale).lower()}",
                    strength=float(max(0.0, min(1.0, float(strength)))),
                    first_to_second_relative_strength=first_to_second,
                    window_start_ms=math.floor(start * 1000 / sample_rate_hz),
                    window_end_ms=math.floor(end * 1000 / sample_rate_hz),
                )
            )
    _log(
        f"essentia analyze summary total_windows={total_windows} "
        f"skipped_low_hpcp={skipped_low_hpcp} emitted={len(results)}"
    )
    return results


def _analyze(samples: np.ndarray, sample_rate_hz: int, window_seconds: int, hop_seconds: int, profiles: List[str]) -> list[WindowResult]:
    if np is None:
        return []

    # Prefer Essentia when available, otherwise fall back to pure numpy (Windows-stable).
    if es is None:
        return _analyze_numpy(samples, sample_rate_hz, window_seconds, hop_seconds, profiles)

    essentia_results = _analyze_essentia(samples, sample_rate_hz, window_seconds, hop_seconds, profiles)
    signal_peak = float(np.max(np.abs(samples))) if len(samples) else 0.0
    if not essentia_results and signal_peak > 1e-5:
        _log(
            f"essentia produced 0 windows but signal_peak={signal_peak:.6f}; using numpy chroma fallback"
        )
        return _analyze_numpy(samples, sample_rate_hz, window_seconds, hop_seconds, profiles)
    return essentia_results


def _analyze_with_backend(
    samples: np.ndarray, sample_rate_hz: int, window_seconds: int, hop_seconds: int, profiles: List[str]
) -> tuple[list[WindowResult], str, str | None]:
    if np is None:
        return [], "unavailable", "numpy_not_available"
    if es is None:
        return (
            _analyze_numpy(samples, sample_rate_hz, window_seconds, hop_seconds, profiles),
            "numpy_fallback",
            "essentia_unavailable",
        )
    essentia_results = _analyze_essentia(samples, sample_rate_hz, window_seconds, hop_seconds, profiles)
    signal_peak = float(np.max(np.abs(samples))) if len(samples) else 0.0
    if not essentia_results and signal_peak > 1e-5:
        fallback_reason = (
            f"essentia_zero_windows_with_signal_peak_{signal_peak:.6f}"
        )
        _log(f"essentia fallback_reason={fallback_reason}")
        return (
            _analyze_numpy(samples, sample_rate_hz, window_seconds, hop_seconds, profiles),
            "numpy_fallback",
            fallback_reason,
        )
    return essentia_results, "essentia", None


def _window_winners(results: list[WindowResult]) -> list[WindowResult]:
    by_window: dict[int, WindowResult] = {}
    for r in results:
        score = float(r.strength) * 0.7 + float(r.first_to_second_relative_strength or 0.0) * 0.3
        existing = by_window.get(r.window_start_ms)
        if existing is None:
            by_window[r.window_start_ms] = r
            continue
        existing_score = float(existing.strength) * 0.7 + float(
            existing.first_to_second_relative_strength or 0.0
        ) * 0.3
        if score > existing_score:
            by_window[r.window_start_ms] = r
    return [by_window[k] for k in sorted(by_window.keys())]


def _dominant_from_winners(winners: list[WindowResult], recent_count: int = 9) -> tuple[str, dict[str, int]]:
    if not winners:
        return "none", {}
    horizon = winners[-recent_count:] if len(winners) > recent_count else winners
    votes: dict[str, int] = {}
    for w in horizon:
        key = f"{w.key}:{w.scale}"
        votes[key] = votes.get(key, 0) + 1
    dominant = max(votes.items(), key=lambda kv: kv[1])[0]
    return dominant, votes


def _key_profiles() -> dict:
    # Classic key profiles (12-bin). We compute chroma (12) from audio and compare.
    # Values are normalized internally.
    return {
        "krumhansl": {
            "major": np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88], dtype=np.float32),
            "minor": np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17], dtype=np.float32),
        },
        "temperley": {
            "major": np.array([0.748, 0.060, 0.488, 0.082, 0.670, 0.460, 0.096, 0.715, 0.104, 0.366, 0.057, 0.400], dtype=np.float32),
            "minor": np.array([0.712, 0.084, 0.474, 0.618, 0.049, 0.460, 0.105, 0.747, 0.404, 0.067, 0.133, 0.330], dtype=np.float32),
        },
        # Fallback mapping: if requested profile isn't explicitly defined, use krumhansl.
        "default": {},
    }


def _rotate(v: np.ndarray, n: int) -> np.ndarray:
    n = int(n) % len(v)
    return np.concatenate([v[-n:], v[:-n]]) if n else v.copy()


NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _normalize_vec(v: np.ndarray) -> np.ndarray:
    v = v.astype(np.float32)
    s = float(np.linalg.norm(v) + 1e-9)
    return v / s


def _rank_keys(chroma12: np.ndarray, profile_type: str) -> list[dict]:
    profiles = _key_profiles()
    p = profiles.get(profile_type, None) or profiles.get("krumhansl")
    major = p.get("major") if isinstance(p, dict) else None
    minor = p.get("minor") if isinstance(p, dict) else None
    if major is None or minor is None:
        p = profiles.get("krumhansl")
        major, minor = p["major"], p["minor"]

    # Center both vectors: unpitched, flat chroma must not score ~98% merely
    # because all bins and profile weights are positive. This is correlation,
    # a descriptive fit score, not a calibrated probability of the song key.
    c = _normalize_vec(chroma12 - np.mean(chroma12))
    ranked = []
    for tonic in range(12):
        for mode, profile in (("major", major), ("minor", minor)):
            score = float(np.dot(c, _normalize_vec(_rotate(profile - np.mean(profile), tonic))))
            ranked.append({"key": NOTE_NAMES[tonic], "scale": mode,
                           "score": max(0.0, min(1.0, score))})
    return sorted(ranked, key=lambda candidate: candidate["score"], reverse=True)


def _estimate_key_from_chroma(chroma12: np.ndarray, profile_type: str) -> tuple[str, str, float]:
    top = _rank_keys(chroma12, profile_type)[0]
    return top["key"], top["scale"], top["score"]


def _chroma_from_window_numpy(window: np.ndarray, sample_rate_hz: int) -> np.ndarray:
    return _tonal_features_numpy(window, sample_rate_hz)[0]


def _tonal_features_numpy(window: np.ndarray, sample_rate_hz: int) -> tuple[np.ndarray, float]:
    # ~370ms gives bass notes enough frequency resolution. Scale the FFT with
    # sample rate so capture format does not change the musical resolution.
    frame_size = 2 ** int(round(math.log2(max(1024, sample_rate_hz * 0.37))))
    hop = frame_size // 4
    if len(window) < frame_size:
        return np.zeros(12, dtype=np.float32), 0.0
    frames = np.lib.stride_tricks.sliding_window_view(window, frame_size)[::hop]
    magnitudes = np.abs(np.fft.rfft(frames * np.hanning(frame_size), axis=1))
    frequencies = np.fft.rfftfreq(frame_size, 1.0 / sample_rate_hz)
    band = (frequencies >= 40) & (frequencies <= min(5000, sample_rate_hz * 0.45))
    pitches, weights, frame_ids = [], [], []
    for frame_id, mags in enumerate(magnitudes):
        band_mags = mags[band]
        if not len(band_mags) or float(np.max(band_mags)) < 1e-5:
            continue
        flatness = np.exp(np.mean(np.log(np.maximum(band_mags, 1e-12)))) / (np.mean(band_mags) + 1e-12)
        if flatness > 0.55:  # unpitched frames contribute no key evidence
            continue
        peaks = np.flatnonzero((mags[1:-1] > mags[:-2]) & (mags[1:-1] >= mags[2:])) + 1
        peaks = peaks[band[peaks] & (mags[peaks] > np.max(band_mags) * 0.015)]
        if not len(peaks):
            continue
        peaks = peaks[np.argsort(mags[peaks])[-80:]]
        # Parabolic interpolation of log magnitude removes FFT-bin pitch bias.
        left, middle, right = [np.log(np.maximum(mags[peaks + offset], 1e-12)) for offset in (-1, 0, 1)]
        curvature = left - 2 * middle + right
        offset = np.divide(0.5 * (left - right), curvature,
                           out=np.zeros_like(middle), where=np.abs(curvature) > 1e-12)
        peak_hz = (peaks + np.clip(offset, -0.5, 0.5)) * sample_rate_hz / frame_size
        midi = 69 + 12 * np.log2(peak_hz / 440)
        # Broad spectral envelope whitening reduces timbre/bass dominance without
        # inventing subharmonic pitches. Compression retains softer chord tones.
        envelope = np.convolve(mags, np.ones(81) / 81, mode="same")
        amplitude = mags[peaks] ** 0.7 / np.maximum(envelope[peaks], np.max(mags) * 0.001) ** 0.3
        amplitude /= np.sum(amplitude) + 1e-12
        pitches.append(midi)
        weights.append(amplitude)
        frame_ids.append(np.full(len(midi), frame_id, dtype=np.int32))
    # A short chord surrounded by silence must not masquerade as a full window
    # of stable tonal evidence after chroma normalization discards its duration.
    if not pitches or len(pitches) / len(magnitudes) < 0.2:
        return np.zeros(12, dtype=np.float32), 0.0
    midi, amplitude, frame_ids = map(np.concatenate, (pitches, weights, frame_ids))
    # Circular fractional-semitone statistics estimate detuning independently of
    # root. Correction is bounded to less than half a semitone; a true transpose
    # remains a transpose. Diffuse tuning evidence does not trigger correction.
    residual = midi - np.round(midi)
    vector = np.sum(amplitude * np.exp(2j * np.pi * residual)) / (np.sum(amplitude) + 1e-12)
    tuning = float(np.angle(vector) / (2 * np.pi)) if abs(vector) >= 0.5 else 0.0
    tuning = float(np.clip(tuning, -0.4, 0.4))
    positions = np.mod((midi - tuning) * 3, 36)
    hpcp = np.zeros((len(magnitudes), 36), dtype=np.float64)
    # Cosine weighting on 36 bins preserves sub-semitone resolution until after
    # tuning correction. Each frame has equal influence, not each loud FFT bin.
    for delta in (-1, 0, 1, 2):
        bins = np.floor(positions).astype(np.int32) + delta
        distance = np.abs(positions - bins) / 3
        contribution = amplitude * np.where(distance < 0.5, np.cos(np.pi * distance) ** 2, 0)
        np.add.at(hpcp, (frame_ids, bins % 36), contribution)
    chroma = (hpcp[:, ::3] + 0.5 * (hpcp[:, 1::3] + np.roll(hpcp, 1, axis=1)[:, ::3])).sum(axis=0)
    return (chroma / (np.max(chroma) + 1e-12)).astype(np.float32), tuning * 100


def _analyze_numpy(samples: np.ndarray, sample_rate_hz: int, window_seconds: int, hop_seconds: int, profiles: List[str]) -> list[WindowResult]:
    results: list[WindowResult] = []
    # Only two independent profiles exist here. Unknown Essentia profiles map
    # to Krumhansl once; counting them repeatedly fabricates consensus.
    profiles = list(dict.fromkeys(p if p in ("krumhansl", "temperley") else "krumhansl" for p in profiles))
    total_windows = 0
    skipped_low_chroma = 0
    for start, end, win in _iter_windows(samples, sample_rate_hz, window_seconds, hop_seconds) or []:
        total_windows += 1
        y = win.astype(np.float32)
        chroma12, tuning_cents = _tonal_features_numpy(y, sample_rate_hz)
        if float(np.max(np.abs(chroma12))) < 1e-6:
            skipped_low_chroma += 1
            continue
        for profile in profiles:
            candidates = _rank_keys(chroma12, profile)
            top = candidates[0]
            key, scale, strength = top["key"], top["scale"], top["score"]
            margin = (strength - candidates[1]["score"]) / max(strength, 1e-9)
            results.append(
                WindowResult(
                    profile_type=profile,
                    key=key,
                    scale=scale,
                    display_name=f"{key} {scale}",
                    strength=float(strength),
                    first_to_second_relative_strength=float(margin),
                    window_start_ms=math.floor(start * 1000 / sample_rate_hz),
                    window_end_ms=math.floor(end * 1000 / sample_rate_hz),
                    candidates=candidates,
                    tuning_cents=tuning_cents,
                )
            )
    _log(
        f"numpy analyze summary total_windows={total_windows} "
        f"skipped_low_chroma={skipped_low_chroma} emitted={len(results)}"
    )
    return results


def _load_wav_mono(path: str, target_sr: int) -> tuple[np.ndarray, int]:
    _log(f"load_wav start path={path} target_sr={target_sr}")
    with wave.open(path, "rb") as wf:
        channels = wf.getnchannels()
        sr = wf.getframerate()
        sampwidth = wf.getsampwidth()
        nframes = wf.getnframes()
        raw = wf.readframes(nframes)
    _log(
        f"load_wav metadata channels={channels} sr={sr} sampwidth={sampwidth} frames={nframes}"
    )

    if sampwidth == 1:
        data = np.frombuffer(raw, dtype=np.uint8).astype(np.float32)
        data = (data - 128.0) / 128.0
    elif sampwidth == 2:
        data = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif sampwidth == 4:
        # Fallback assumption for our Rust writer (float32 WAV)
        data = np.frombuffer(raw, dtype=np.float32).astype(np.float32)
    else:
        raise ValueError(f"unsupported wav sample width: {sampwidth}")

    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1).astype(np.float32)

    if sr != target_sr and len(data) > 1:
        x_old = np.linspace(0.0, 1.0, num=len(data), dtype=np.float64)
        new_len = max(1, int(round(len(data) * float(target_sr) / float(sr))))
        x_new = np.linspace(0.0, 1.0, num=new_len, dtype=np.float64)
        data = np.interp(x_new, x_old, data).astype(np.float32)
        sr = target_sr

    _log(f"load_wav done samples={len(data)} effective_sr={sr}")
    return data, sr


def main() -> int:
    if "--serve" in sys.argv:
        # One-time readiness line so the parent can confirm the process is alive.
        ready = {
            "ready": True,
            "essentiaAvailable": es is not None,
            "numpyAvailable": np is not None,
            "librosaAvailable": False,
            "numpyError": np_err,
            "librosaError": librosa_err,
            "essentiaError": es_err,
        }
        _log(
            f"ready essentiaAvailable={ready['essentiaAvailable']} numpyAvailable={ready['numpyAvailable']} "
            f"essentiaError={ready['essentiaError']}"
        )
        print(json.dumps(ready), flush=True)

        while True:
            line = sys.stdin.readline()
            if line == "":
                return 0
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
                _log(
                    "request "
                    f"sampleRateHz={req.get('sampleRateHz')} windowSeconds={req.get('windowSeconds')} "
                    f"hopSeconds={req.get('hopSeconds')} profiles={req.get('profileTypes')} "
                    f"hasWavPath={bool(req.get('wavPath'))}"
                )
                if np is None:
                    _log("numpy backend unavailable")
                    print(json.dumps({"windows": [], "error": "numpy_not_available"}), flush=True)
                    continue
                # Essentia is preferred, but on Windows it may be unavailable.
                if es is None and np is None:
                    _log("no analyzer backend available")
                    print(json.dumps({"windows": [], "error": "no_analyzer_backend_available"}), flush=True)
                    continue
                sample_rate_hz = int(req.get("sampleRateHz", 44100))
                window_seconds = int(req.get("windowSeconds", 12))
                hop_seconds = int(req.get("hopSeconds", 4))
                profiles = [str(p) for p in req.get("profileTypes", ["bgate", "krumhansl", "shaath"])]
                wav_path = req.get("wavPath", None)
                if wav_path:
                    _log(f"wav_path received path={wav_path} exists={os.path.exists(wav_path)}")
                    samples, sr = _load_wav_mono(wav_path, sample_rate_hz)
                    if sr != sample_rate_hz:
                        sample_rate_hz = sr
                else:
                    samples = np.asarray(req.get("samplesMonoF32", []), dtype=np.float32)
                sample_peak = float(np.max(np.abs(samples))) if len(samples) else 0.0
                sample_rms = (
                    float(np.sqrt(np.mean(np.square(samples.astype(np.float64)))))
                    if len(samples)
                    else 0.0
                )
                _log(
                    f"analysis start backend={'essentia' if es is not None else 'numpy'} "
                    f"samples={len(samples)} sr={sample_rate_hz} peak={sample_peak:.6f} rms={sample_rms:.6f}"
                )
                windows, backend_used, fallback_reason = _analyze_with_backend(
                    samples, sample_rate_hz, window_seconds, hop_seconds, profiles
                )
                if windows:
                    preview_raw_first = ", ".join(
                        [f"{w.profile_type}:{w.key} {w.scale}({w.strength:.2f})" for w in windows[:3]]
                    )
                    winners = _window_winners(windows)
                    dominant_recent, vote_counts = _dominant_from_winners(winners, 9)
                    preview_recent_winners = ", ".join(
                        [f"{w.window_start_ms}-{w.window_end_ms}:{w.key} {w.scale}" for w in winners[-4:]]
                    )
                else:
                    preview_raw_first = "<none>"
                    preview_recent_winners = "<none>"
                    dominant_recent = "none"
                    vote_counts = {}
                _log(
                    f"analysis done backend={backend_used} fallback_reason={fallback_reason} "
                    f"windows={len(windows)} previewRawFirst={preview_raw_first} "
                    f"previewRecentWinners={preview_recent_winners} dominantRecent={dominant_recent} "
                    f"recentVoteCounts={vote_counts}"
                )
                print(
                    json.dumps(
                        {
                            "windows": [w.to_wire() for w in windows],
                            "backendUsed": backend_used,
                            "fallbackReason": fallback_reason,
                        }
                    ),
                    flush=True,
                )
            except Exception as exc:
                _log(f"analysis exception: {exc}")
                _log(traceback.format_exc().strip())
                print(
                    json.dumps(
                        {
                            "windows": [],
                            "error": str(exc),
                            "backendUsed": "unavailable",
                            "fallbackReason": "analysis_exception",
                        }
                    ),
                    flush=True,
                )
        return 0

    if "--analyze" in sys.argv:
        raw = sys.stdin.buffer.read()
        if not raw:
            print(json.dumps({"windows": [], "backendUsed": "unavailable", "fallbackReason": "empty_request"}))
            return 0
        req = json.loads(raw.decode("utf-8"))
        sample_rate_hz = int(req.get("sampleRateHz", 44100))
        window_seconds = int(req.get("windowSeconds", 12))
        hop_seconds = int(req.get("hopSeconds", 4))
        profiles = [str(p) for p in req.get("profileTypes", ["bgate", "krumhansl", "shaath"])]
        samples = np.asarray(req.get("samplesMonoF32", []), dtype=np.float32)
        windows, backend_used, fallback_reason = _analyze_with_backend(
            samples, sample_rate_hz, window_seconds, hop_seconds, profiles
        )
        print(
            json.dumps(
                {
                    "windows": [w.to_wire() for w in windows],
                    "backendUsed": backend_used,
                    "fallbackReason": fallback_reason,
                }
            )
        )
        return 0

    print(json.dumps({"windows": []}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
