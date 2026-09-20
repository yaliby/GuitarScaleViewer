"""Features for the relative-pair decision, built from the per-hop chromagram.

A key and its relative contain the identical seven pitch classes, so *nothing* computed from a
chroma vector summed over a whole clip can separate them — the two candidates differ only in which
of those seven the music treats as home. Every feature here therefore comes from something the sum
throws away: where the energy sits in the octave stack, and where it sits in time.

M2 (see the project memory) tested hand-picked scalars of this kind on synthetic clips and found a
coin flip. That is not evidence against the idea: a synthetic four-chord loop with equal chord
durations and no melody genuinely has no tonal centre, and a musician could not call it either.
Real recordings have an arrangement — an intro, a hook, a last bar — and this asks whether a
*fitted* reader of the whole time-resolved picture can hear it.

Everything is expressed relative to the major end of the pair, so the features are transposition
invariant and one model serves all twelve pairs.
"""
from __future__ import annotations

import numpy as np

EPS = 1e-12


def _norm(v: np.ndarray) -> np.ndarray:
    total = v.sum()
    return v / total if total > EPS else np.zeros_like(v)


def _collapse(frames: np.ndarray, octaves: slice = slice(0, 6)) -> np.ndarray:
    """(hops, 12) pitch-class energy over the chosen octave range."""
    return frames.reshape(frames.shape[0], 6, 12)[:, octaves, :].sum(axis=1)


def relative_pair_features(frames: np.ndarray, major_root: int, blocks=None) -> np.ndarray:
    """One feature vector for the decision "major on `major_root`, or minor on `major_root`+9".

    `frames` is (hops, 72) as libKeyFinder produced it, band 0 = C. `blocks` restricts the output to
    the named groups in `FEATURE_BLOCKS`, which is how the ablation finds out which of them is
    carrying the result and which is just spending degrees of freedom.
    """
    hops = frames.shape[0]
    wanted = FEATURE_BLOCKS if blocks is None else list(blocks)
    if hops == 0:
        return np.zeros(12 * len(wanted))

    def rot(v: np.ndarray) -> np.ndarray:
        return np.roll(v, -major_root, axis=-1)

    full = _collapse(frames)
    bass = _collapse(frames, slice(0, 2))
    mid = _collapse(frames, slice(2, 4))
    treble = _collapse(frames, slice(4, 6))

    # Per-hop L1 normalisation before averaging, so a loud chorus does not outvote a quiet verse.
    def timeavg(x: np.ndarray) -> np.ndarray:
        totals = x.sum(axis=1, keepdims=True)
        return np.divide(x, totals, out=np.zeros_like(x), where=totals > EPS).mean(axis=0)

    edge = max(1, hops // 8)
    computed = {
        "sum": lambda: rot(_norm(full.sum(axis=0))),        # overall pitch-class profile
        "timeavg": lambda: rot(timeavg(full)),              # the same, unweighted by loudness
        "bass": lambda: rot(timeavg(bass)),                 # which note the bass treats as home
        "mid": lambda: rot(timeavg(mid)),
        "treble": lambda: rot(timeavg(treble)),             # the tune resolves where the key is
        "open": lambda: rot(_norm(full[:edge].sum(axis=0))),    # how the excerpt opens
        "close": lambda: rot(_norm(full[-edge:].sum(axis=0))),  # and how it closes
        "bass_open": lambda: rot(_norm(bass[:edge].sum(axis=0))),
        "bass_close": lambda: rot(_norm(bass[-edge:].sum(axis=0))),
    }

    # Which pitch class *wins* each hop, rather than how much of it there is. A root can be
    # present throughout and still never be the loudest thing in the bar.
    def argmax_hist(x: np.ndarray) -> np.ndarray:
        hist = np.zeros(12)
        live = x.sum(axis=1) > EPS
        if live.any():
            for p in x[live].argmax(axis=1):
                hist[p] += 1
            hist /= live.sum()
        return hist

    computed["argmax"] = lambda: rot(argmax_hist(full))
    computed["bass_argmax"] = lambda: rot(argmax_hist(bass))

    # Where a hop's winner *goes next*: a tonic is the note other notes resolve to, so the
    # destination of a change carries more than its frequency. Collapsed to "how often does each
    # pitch class end a move", which keeps this 12 numbers instead of 144.
    def resolves_to() -> np.ndarray:
        dest = np.zeros(12)
        if hops > 1:
            winners = full.argmax(axis=1)
            moves = 0
            for a, b in zip(winners[:-1], winners[1:]):
                if a != b:
                    dest[b] += 1
                    moves += 1
            if moves:
                dest /= moves
        return rot(dest)

    computed["resolves_to"] = resolves_to

    return np.concatenate([computed[name]() for name in wanted])


FEATURE_BLOCKS = [
    "sum", "timeavg", "bass", "mid", "treble",
    "open", "close", "bass_open", "bass_close",
    "argmax", "bass_argmax", "resolves_to",
]
FEATURE_COUNT = 12 * len(FEATURE_BLOCKS)


def feature_names() -> list[str]:
    from keylab import NAMES
    # Degrees of the major end, which is the frame everything is rotated into.
    degrees = ["1", "b2", "2", "b3", "3", "4", "b5", "5", "b6", "6", "b7", "7"]
    return [f"{block}:{d}" for block in FEATURE_BLOCKS for d in degrees]
