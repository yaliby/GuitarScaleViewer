"""Chords from the high-resolution chromagram, and the handful of numbers a key depends on.

The feature set here is deliberately small — eighteen numbers per candidate key, not a few hundred.
Every previous model that lost in this project lost by having more parameters than songs, and the
one that won (the tonic stage) works inside a two-way decision. These are chosen because a musician
would name them when asked how they know what key something is in:

  * how much of the time the tonic chord is sounding;
  * whether phrases *land* on it — the fraction of chord changes whose destination it is;
  * whether the dominant resolves to it, which is the single strongest cue in tonal music and
    exactly what the synthetic corpus showed the engine relies on ("give the engine a functional
    dominant resolving to the tonic and it is never wrong");
  * whether the excerpt opens and closes on it;
  * how much of the time is spent on chords that belong to the key at all.

A key and its relative share all seven notes *and* all seven diatonic chords, so only the features
about which chord is home can separate them. A key and its dominant share six notes and five
chords, and there the discriminating features are the cadence ones.
"""
from __future__ import annotations

import numpy as np

EPS = 1e-12

# 24 triads: index 2*p is p major, 2*p+1 is p minor. Matching the classifier's own convention here
# would gain nothing — nothing in this file talks to libKeyFinder.
TRIAD_INTERVALS = {"major": (0, 4, 7), "minor": (0, 3, 7)}


def triad_templates() -> np.ndarray:
    """(24, 12) unit-norm chord templates."""
    out = np.zeros((24, 12))
    for pitch in range(12):
        for offset, quality in ((0, "major"), (1, "minor")):
            row = np.zeros(12)
            for interval in TRIAD_INTERVALS[quality]:
                row[(pitch + interval) % 12] = 1.0
            out[2 * pitch + offset] = row / np.linalg.norm(row)
    return out


TEMPLATES = triad_templates()


def chord_sequence(chroma: np.ndarray, bass: np.ndarray | None = None,
                   smooth_frames: int = 8, bass_weight: float = 0.3) -> np.ndarray:
    """One chord index per frame.

    Scores are smoothed before the decision rather than the labels after it: a chord index is a
    categorical label with no order, so a median filter over indices would happily average C major
    and B major into something in between. Smoothing the evidence and then deciding once keeps the
    decision honest.

    `bass_weight` mixes in a match against the *root* of each triad in the low register. A chord's
    root in the bass is what makes it that chord rather than its own third-inversion neighbour, and
    it is the cue a collapsed chroma loses.
    """
    frames = chroma.shape[1]
    norms = np.linalg.norm(chroma, axis=0)
    unit = np.divide(chroma, norms, out=np.zeros_like(chroma), where=norms > EPS)
    scores = TEMPLATES @ unit                        # (24, frames)

    if bass is not None and bass_weight > 0:
        bass_norms = bass.sum(axis=0)
        bass_unit = np.divide(bass, bass_norms, out=np.zeros_like(bass), where=bass_norms > EPS)
        root_match = np.zeros((24, frames))
        for pitch in range(12):
            root_match[2 * pitch] = bass_unit[pitch]
            root_match[2 * pitch + 1] = bass_unit[pitch]
        scores = scores + bass_weight * root_match

    if smooth_frames > 1:
        kernel = np.ones(smooth_frames) / smooth_frames
        scores = np.apply_along_axis(lambda r: np.convolve(r, kernel, mode="same"), 1, scores)
    return scores.argmax(axis=0)


def runs(sequence: np.ndarray) -> list[tuple[int, int]]:
    """(chord, length) for each maximal run, which is what a chord *change* is defined against."""
    out: list[tuple[int, int]] = []
    for chord in sequence:
        if out and out[-1][0] == chord:
            out[-1] = (chord, out[-1][1] + 1)
        else:
            out.append((int(chord), 1))
    return out


MAJOR_DEGREES = [(0, 0), (2, 1), (4, 1), (5, 0), (7, 0), (9, 1)]   # I ii iii IV V vi
MINOR_DEGREES = [(0, 1), (3, 0), (5, 1), (7, 1), (7, 0), (8, 0), (10, 0)]  # i III iv v V VI VII

FEATURE_NAMES = [
    "time_on_tonic", "time_on_relative_tonic", "time_on_V_major", "time_on_IV_major",
    "time_on_iv_minor", "time_on_ii_minor", "time_on_vi_minor", "time_on_III_major",
    "time_on_VII_major", "time_diatonic", "changes_into_tonic", "cadence_V_to_tonic",
    "cadence_IV_to_tonic", "cadence_VII_to_tonic", "opens_on_tonic", "closes_on_tonic",
    "most_common_is_tonic", "longest_run_is_tonic",
]


def key_features(sequence: np.ndarray, root: int, mode: str) -> np.ndarray:
    """The eighteen numbers, for one candidate key."""
    frames = len(sequence)
    if frames == 0:
        return np.zeros(len(FEATURE_NAMES))

    def index(interval: int, quality: str) -> int:
        return 2 * ((root + interval) % 12) + (0 if quality == "major" else 1)

    occupancy = np.bincount(sequence, minlength=24) / frames
    tonic = index(0, mode)
    relative = index(9, "minor") if mode == "major" else index(3, "major")

    segments = runs(sequence)
    changes = [(a[0], b[0]) for a, b in zip(segments[:-1], segments[1:])]
    into_tonic = sum(1 for _, dst in changes if dst == tonic)
    from_to = lambda interval, quality: sum(
        1 for src, dst in changes if src == index(interval, quality) and dst == tonic
    )
    change_count = max(len(changes), 1)

    degrees = MAJOR_DEGREES if mode == "major" else MINOR_DEGREES
    diatonic = sum(occupancy[index(i, "major" if q == 0 else "minor")] for i, q in degrees)

    longest = max(segments, key=lambda s: s[1])[0] if segments else -1

    return np.array([
        occupancy[tonic],
        occupancy[relative],
        occupancy[index(7, "major")],
        occupancy[index(5, "major")],
        occupancy[index(5, "minor")],
        occupancy[index(2, "minor")],
        occupancy[index(9, "minor")],
        occupancy[index(3, "major")],
        occupancy[index(10, "major")],
        diatonic,
        into_tonic / change_count,
        from_to(7, "major") / change_count,
        from_to(5, "major") / change_count,
        from_to(10, "major") / change_count,
        1.0 if segments and segments[0][0] == tonic else 0.0,
        1.0 if segments and segments[-1][0] == tonic else 0.0,
        1.0 if int(occupancy.argmax()) == tonic else 0.0,
        1.0 if longest == tonic else 0.0,
    ])


def all_key_features(sequence: np.ndarray) -> np.ndarray:
    """(24, 18) indexed the same way as `keylab.KEY_ORDER`."""
    from keylab import KEY_ORDER

    return np.stack([key_features(sequence, root, mode) for root, mode in KEY_ORDER])
