"""Deterministic musical signals, independent of the estimator's key profiles.

All fixtures transpose by construction. No artist, title, or preferred tonic is
part of the generator. These are DSP regressions, not a real-song accuracy claim.
"""
import numpy as np


def progression(root, mode, sample_rate=22050, style="clean", cents=0.0, gain=0.4):
    third = 4 if mode == "major" else 3
    # Tonic / subdominant / dominant / tonic; dominant has a leading tone in
    # both modes. Different durations/inversions in the evaluation arrangement.
    degrees = [(0, third, 3.0), (5, third, 2.0), (7, 4, 2.0), (0, third, 5.0)]
    if style == "evaluation":
        degrees = [(0, third, 2.0), (7, 4, 1.5), (5, third, 2.0),
                   (7, 4, 1.5), (0, third, 5.0)]
    rng = np.random.default_rng(781)
    parts = []
    for index, (degree, quality, duration) in enumerate(degrees):
        t = np.arange(round(sample_rate * duration)) / sample_rate
        signal = np.zeros_like(t)
        notes = [(36 + root + degree, 0.8), (48 + root + degree, 1.0),
                 (48 + root + degree + quality, 0.7), (55 + root + degree, 0.7)]
        for voice, (midi, amplitude) in enumerate(notes):
            if style == "evaluation" and voice == 2:
                midi += 12  # open voicing rather than the development triad
            frequency = 440 * 2 ** ((midi - 69 + cents / 100) / 12)
            harmonics = [1.0] if style == "clean" else [1.0, 0.5, 0.25, 0.12]
            for harmonic, weight in enumerate(harmonics, 1):
                signal += amplitude * weight * np.sin(2 * np.pi * frequency * harmonic * t + voice * 0.23)
        envelope = np.minimum(t / 0.025, 1) * np.minimum((duration - t) / 0.08, 1)
        if style != "clean":
            envelope *= 0.35 + 0.65 * np.exp(-2 * (t % 0.5))
            # Transient percussion and low noise independent of key.
            signal += rng.normal(0, 0.22, len(t)) * np.exp(-30 * (t % 0.5))
        parts.append(signal * envelope)
    audio = np.concatenate(parts)
    return (gain * audio / max(1, np.max(np.abs(audio)))).astype(np.float32)
