"""Extended chord evidence: what the bass is doing, and how long chords are held.

`chords.py` reads the chord sequence and nothing else. Two kinds of evidence it throws away are
exactly the kinds that separate the pairs the engine still confuses.

**The bass line, independently of the chord.** A chord symbol says which three notes are sounding;
it does not say which one the bass is on, and that is what makes a chord feel like home. For a key
and its relative — identical notes, identical diatonic chords — the bass is close to the only
evidence there is. The chord recogniser already uses the bass as a hint, but folds it into a single
label and loses the rest.

**How long each chord is held.** Occupancy counts frames, so four bars of the tonic and four
one-bar passes through it are the same number. A tonic is typically *dwelt on*; a passing chord is
not. Mean duration and longest run separate those where a frame count cannot.

The dominant seventh is here for a different reason: it is the one chord quality that is unambiguous
about its function. A G7 in a piece is nearly always the V of C, whereas a plain G major is equally
at home in G, C and D. Detecting sevenths gives the cadence features something much sharper to
work with than triads alone.
"""
from __future__ import annotations

import numpy as np

from chords import FEATURE_NAMES as BASE_FEATURE_NAMES, key_features, runs

EPS = 1e-12

EXTRA_FEATURE_NAMES = [
    "bass_share_tonic", "bass_share_fifth", "bass_share_relative", "bass_share_fourth",
    "bass_opens_tonic", "bass_closes_tonic",
    "tonic_mean_duration", "tonic_longest_run", "chord_variety",
    "seventh_on_V", "seventh_on_tonic", "cadence_tonic_to_V",
]
FEATURE_NAMES = BASE_FEATURE_NAMES + EXTRA_FEATURE_NAMES


def bass_pitch_classes(bass: np.ndarray, smooth_frames: int = 8) -> np.ndarray:
    """The dominant bass pitch class per frame, smoothed the same way chords are."""
    totals = bass.sum(axis=0)
    unit = np.divide(bass, totals, out=np.zeros_like(bass), where=totals > EPS)
    if smooth_frames > 1:
        kernel = np.ones(smooth_frames) / smooth_frames
        unit = np.apply_along_axis(lambda r: np.convolve(r, kernel, mode="same"), 1, unit)
    return unit.argmax(axis=0)


def seventh_strength(chroma: np.ndarray, sequence: np.ndarray) -> np.ndarray:
    """(12,) how seventh-flavoured each major triad root sounds while it is playing.

    Measured only over the frames where that triad is the detected chord, so it reads "when G major
    is sounding, is there an F in it" rather than "is there an F anywhere in the song".
    """
    totals = chroma.sum(axis=0)
    unit = np.divide(chroma, totals, out=np.zeros_like(chroma), where=totals > EPS)
    out = np.zeros(12)
    for pitch in range(12):
        frames = sequence == 2 * pitch          # that root's major triad
        if frames.sum() == 0:
            continue
        out[pitch] = float(unit[(pitch + 10) % 12, frames].mean())
    return out


def key_features_extended(sequence: np.ndarray, bass_classes: np.ndarray,
                          sevenths: np.ndarray, root: int, mode: str) -> np.ndarray:
    base = key_features(sequence, root, mode)
    frames = len(sequence)
    if frames == 0:
        return np.concatenate([base, np.zeros(len(EXTRA_FEATURE_NAMES))])

    def index(interval: int, quality: str) -> int:
        return 2 * ((root + interval) % 12) + (0 if quality == "major" else 1)

    tonic = index(0, mode)
    relative_root = (root + 9) % 12 if mode == "major" else (root + 3) % 12

    bass_hist = np.bincount(bass_classes, minlength=12) / max(len(bass_classes), 1)
    edge = max(1, len(bass_classes) // 8)
    opens = float((bass_classes[:edge] == root).mean())
    closes = float((bass_classes[-edge:] == root).mean())

    segments = runs(sequence)
    tonic_runs = [length for chord, length in segments if chord == tonic]
    mean_length = frames / max(len(segments), 1)
    tonic_mean = (sum(tonic_runs) / len(tonic_runs) / mean_length) if tonic_runs else 0.0
    longest_tonic = (max(tonic_runs) / frames) if tonic_runs else 0.0

    changes = [(a[0], b[0]) for a, b in zip(segments[:-1], segments[1:])]
    to_dominant = sum(1 for src, dst in changes if src == tonic and dst == index(7, "major"))

    return np.concatenate([base, np.array([
        bass_hist[root],
        bass_hist[(root + 7) % 12],
        bass_hist[relative_root],
        bass_hist[(root + 5) % 12],
        opens,
        closes,
        tonic_mean,
        longest_tonic,
        len({chord for chord, _ in segments}) / 24.0,
        sevenths[(root + 7) % 12],
        sevenths[root],
        to_dominant / max(len(changes), 1),
    ])])


def all_key_features(sequence: np.ndarray, chroma: np.ndarray, bass: np.ndarray,
                     smooth_frames: int = 8) -> np.ndarray:
    """(24, len(FEATURE_NAMES)) indexed the same way as `keylab.KEY_ORDER`."""
    from keylab import KEY_ORDER

    bass_classes = bass_pitch_classes(bass, smooth_frames)
    sevenths = seventh_strength(chroma, sequence)
    return np.stack([
        key_features_extended(sequence, bass_classes, sevenths, root, mode)
        for root, mode in KEY_ORDER
    ])
