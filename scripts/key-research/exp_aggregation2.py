"""Separate the two things that made every aggregation beat `sum`, then cross them.

The first pass showed two effects of similar size and no obvious relation to each other:

  * **loudness invariance** — normalise each hop before averaging, so a loud chorus does not
    outvote a quiet verse (L1 +0.8, L2 +1.8, max +1.8);
  * **amplitude compression** — sqrt or log before summing, so one distorted bar cannot dominate
    a band (sqrt +1.5, log1p +2.0).

Crossing them naively lost (`per-hop L1 then sqrt`, +1.1), but that is an artefact rather than a
finding: L1 normalisation makes every value about 1/72, and a power applied to numbers that small
compresses a completely different part of the range than the same power applied to raw magnitudes.
Compression has to be applied at a fixed scale to mean the same thing twice. This parameterises
both axes properly and runs the grid.
"""
from __future__ import annotations

import statistics
import sys

import numpy as np

import keylab
from exp_aggregation import Recast
from exp_discriminative import fit_profiles, generative_fit, predict

EPS = 1e-12
SHIPPED_BLEND = 0.80
REFINE = dict(relative_credit=0.5, pull=7.0, temperature=0.02)


def make_aggregation(scaling: str, compression):
    """Normalise each hop, compress at a fixed scale, then average.

    Rescaling to mean 1 between the two steps is what makes `compression` comparable across
    `scaling` choices — without it a power law is silently applied to a different part of the range
    for each normaliser.
    """
    def aggregate(frames: np.ndarray) -> np.ndarray:
        x = frames
        if scaling == "l1":
            d = x.sum(axis=1, keepdims=True)
        elif scaling == "l2":
            d = np.linalg.norm(x, axis=1, keepdims=True)
        elif scaling == "max":
            d = x.max(axis=1, keepdims=True)
        else:
            d = None
        if d is not None:
            x = np.divide(x, d, out=np.zeros_like(x), where=d > EPS)
        mean = x.mean()
        if mean > EPS:
            x = x / mean
        if compression == "log":
            x = np.log1p(x)
        elif compression != 1.0:
            x = np.power(x, compression)
        return x.mean(axis=0)

    return aggregate


def main():
    clips = keylab.load_clips()
    seeds = list(range(int(sys.argv[1]))) if len(sys.argv) > 1 else list(range(6))
    base = (keylab.SHAATH_MAJOR_72, keylab.SHAATH_MINOR_72)
    sd = statistics.stdev if len(seeds) > 1 else (lambda _: 0.0)

    grid = [(s, c) for s in ("none", "l1", "l2", "max") for c in (1.0, 0.75, 0.5, 0.25, "log")]
    reference = None
    rows = []

    print(f"{len(clips)} clips, {len(seeds)} partitions. compression 1.0 = none.\n")
    print(f"{'scaling':<10}{'compress':>10}{'note-set':>18}{'tonic':>18}{'vs sum':>16}")
    for scaling, compression in grid:
        view = [Recast(c, make_aggregation(scaling, compression)) for c in clips]
        runs = []
        for seed in seeds:
            preds = [None] * len(view)
            for fold in keylab.song_folds(clips, 6, seed):
                test_idx = set(fold)
                train = [c for i, c in enumerate(view) if i not in test_idx]
                major, minor = fit_profiles(train, *generative_fit(train, SHIPPED_BLEND, *base), **REFINE)
                for i, p in zip(fold, predict([view[i] for i in fold], major, minor)):
                    preds[i] = p
            runs.append(keylab.score(preds, clips))
        if reference is None:
            reference = runs
        notes = [r[0] for r in runs]
        tonics = [r[1] for r in runs]
        delta = [a[0] - b[0] for a, b in zip(runs, reference)]
        rows.append((statistics.mean(notes), scaling, compression))
        print(f"{scaling:<10}{str(compression):>10}{statistics.mean(notes):11.1f}% +/-{sd(notes):4.1f}"
              f"{statistics.mean(tonics):11.1f}% +/-{sd(tonics):4.1f}"
              f"{statistics.mean(delta):+11.2f} +/-{sd(delta):4.2f}")

    print("\nbest five by note-set:")
    for mean, scaling, compression in sorted(rows, reverse=True)[:5]:
        print(f"  {scaling} / {compression}: {mean:.1f}%")


if __name__ == "__main__":
    main()
