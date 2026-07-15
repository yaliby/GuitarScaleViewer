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


def _estimate_key_from_chroma(chroma12: np.ndarray, profile_type: str) -> tuple[str, str, float]:
    profiles = _key_profiles()
    p = profiles.get(profile_type, None) or profiles.get("krumhansl")
    major = p.get("major") if isinstance(p, dict) else None
    minor = p.get("minor") if isinstance(p, dict) else None
    if major is None or minor is None:
        p = profiles.get("krumhansl")
        major, minor = p["major"], p["minor"]

    c = _normalize_vec(chroma12)
    best = ("C", "major", -1.0)
    for tonic in range(12):
        maj = float(np.dot(c, _normalize_vec(_rotate(major, tonic))))
        if maj > best[2]:
            best = (NOTE_NAMES[tonic], "major", maj)
        minv = float(np.dot(c, _normalize_vec(_rotate(minor, tonic))))
        if minv > best[2]:
            best = (NOTE_NAMES[tonic], "minor", minv)
    # Map cosine similarity [-1..1] to [0..1] as strength.
    strength = max(0.0, min(1.0, (best[2] + 1.0) * 0.5))
    return best[0], best[1], strength


def _chroma_from_window_numpy(window: np.ndarray, sample_rate_hz: int) -> np.ndarray:
    frame_size = 4096
    hop = 2048
    if len(window) < frame_size:
        return np.zeros(12, dtype=np.float32)
    win_fn = np.hanning(frame_size).astype(np.float32)
    chroma_acc = np.zeros(12, dtype=np.float32)
    frame_count = 0
    for start in range(0, len(window) - frame_size + 1, hop):
        frame = window[start : start + frame_size] * win_fn
        spectrum = np.fft.rfft(frame)
        mags = np.abs(spectrum)
        freqs = np.fft.rfftfreq(frame_size, d=1.0 / sample_rate_hz)
        # 40Hz..5kHz capture tonal range.
        mask = (freqs >= 40.0) & (freqs <= 5000.0)
        if not np.any(mask):
            continue
        sel_freqs = freqs[mask]
        sel_mags = mags[mask]
        # MIDI note mapping -> pitch class.
        midi = 69.0 + 12.0 * np.log2(np.maximum(sel_freqs, 1e-9) / 440.0)
        pcs = np.mod(np.round(midi).astype(np.int32), 12)
        for pc, mag in zip(pcs, sel_mags):
            chroma_acc[int(pc)] += float(mag)
        frame_count += 1
    if frame_count == 0:
        return np.zeros(12, dtype=np.float32)
    return chroma_acc / (np.max(chroma_acc) + 1e-9)


def _analyze_numpy(samples: np.ndarray, sample_rate_hz: int, window_seconds: int, hop_seconds: int, profiles: List[str]) -> list[WindowResult]:
    results: list[WindowResult] = []
    total_windows = 0
    skipped_low_chroma = 0
    for start, end, win in _iter_windows(samples, sample_rate_hz, window_seconds, hop_seconds) or []:
        total_windows += 1
        y = win.astype(np.float32)
        chroma12 = _chroma_from_window_numpy(y, sample_rate_hz)
        if float(np.max(np.abs(chroma12))) < 1e-6:
            skipped_low_chroma += 1
            continue
        for profile in profiles:
            key, scale, strength = _estimate_key_from_chroma(chroma12, profile)
            results.append(
                WindowResult(
                    profile_type=profile,
                    key=key,
                    scale=scale,
                    display_name=f"{key} {scale}",
                    strength=float(strength),
                    first_to_second_relative_strength=None,
                    window_start_ms=math.floor(start * 1000 / sample_rate_hz),
                    window_end_ms=math.floor(end * 1000 / sample_rate_hz),
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
