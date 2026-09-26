from __future__ import annotations

from dataclasses import asdict, dataclass
from math import gcd

import numpy as np
from scipy.signal import resample_poly


@dataclass(frozen=True)
class FeatureConfig:
    sample_rate: int = 22_050
    n_fft: int = 2048
    hop_length: int = 512
    version: str = "chroma-bass-v1"

    def to_dict(self) -> dict[str, int | str]:
        return asdict(self)


@dataclass(frozen=True)
class FeatureFrames:
    values: np.ndarray
    times: np.ndarray
    names: tuple[str, ...]


def _resample(audio: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
    if source_rate == target_rate:
        return audio.astype(np.float32, copy=False)
    divisor = gcd(source_rate, target_rate)
    return resample_poly(audio, target_rate // divisor, source_rate // divisor).astype(np.float32)


def extract_features(
    audio: np.ndarray,
    source_rate: int,
    config: FeatureConfig | None = None,
) -> FeatureFrames:
    config = config or FeatureConfig()
    signal = np.asarray(audio, dtype=np.float32)
    if signal.ndim == 2:
        signal = signal.mean(axis=1)
    if signal.ndim != 1:
        raise ValueError("Audio must be mono or samples-by-channels")
    signal = _resample(signal, source_rate, config.sample_rate)
    if len(signal) < config.n_fft:
        signal = np.pad(signal, (0, config.n_fft - len(signal)))
    frames = np.lib.stride_tricks.sliding_window_view(signal, config.n_fft)[:: config.hop_length]
    frames = frames * np.hanning(config.n_fft).astype(np.float32)
    magnitude = np.abs(np.fft.rfft(frames, axis=1)).astype(np.float32)
    frequencies = np.fft.rfftfreq(config.n_fft, 1 / config.sample_rate)
    valid = frequencies >= 27.5
    midi = np.rint(69 + 12 * np.log2(frequencies[valid] / 440)).astype(np.int64)
    pitch_classes = midi % 12
    chroma = np.zeros((len(frames), 12), dtype=np.float32)
    bass = np.zeros_like(chroma)
    for pitch_class in range(12):
        selected = valid.copy()
        selected[valid] = pitch_classes == pitch_class
        chroma[:, pitch_class] = magnitude[:, selected].sum(axis=1)
        bass_selected = selected & (frequencies <= 330.0)
        bass[:, pitch_class] = magnitude[:, bass_selected].sum(axis=1)
    chroma /= np.maximum(chroma.sum(axis=1, keepdims=True), 1e-8)
    bass /= np.maximum(bass.sum(axis=1, keepdims=True), 1e-8)
    rms = np.sqrt(np.mean(frames**2, axis=1))
    log_rms = np.log1p(100 * rms).astype(np.float32)
    normalized_magnitude = magnitude / np.maximum(magnitude.sum(axis=1, keepdims=True), 1e-8)
    flux = np.zeros(len(frames), dtype=np.float32)
    if len(frames) > 1:
        flux[1:] = np.maximum(normalized_magnitude[1:] - normalized_magnitude[:-1], 0).sum(axis=1)
    values = np.concatenate((chroma, bass, log_rms[:, None], flux[:, None]), axis=1)
    times = (np.arange(len(frames)) * config.hop_length + config.n_fft / 2) / config.sample_rate
    names = tuple(
        [
            *(f"chroma_{index}" for index in range(12)),
            *(f"bass_chroma_{index}" for index in range(12)),
            "log_rms",
            "spectral_flux",
        ]
    )
    return FeatureFrames(values.astype(np.float32), times.astype(np.float64), names)
