"""How the per-hop chromagram is collapsed into the 72 numbers the classifier sees.

libKeyFinder's `collapseToOneHop` sums the magnitude of every hop, so a loud chorus counts for
several times a quiet verse, and one distorted bar can outweigh a whole intro. Nothing about that
is a decision anybody made for *this* application — it is what a DJ tool needs, where the loudest
section is the one being mixed.

The tonic-stage ablation gave the hint: its `timeavg` block (each hop normalised before averaging)
scored better alone than the `sum` block did, on the same audio. If loudness-invariance is worth
something to the second stage it may be worth something to the first, and the first is where
note-set accuracy — the number the fretboard is drawn from — is decided.

This is not window voting, which was measured and lost (see the project memory): every variant here
still produces exactly one 72-band vector and hands it to exactly one classification. Only the
arithmetic that builds the vector changes.
"""
from __future__ import annotations

import statistics
import sys

import numpy as np

import keylab
from exp_discriminative import fit_profiles, generative_fit, predict

EPS = 1e-12
SHIPPED_BLEND = 0.80
REFINE = dict(relative_credit=0.5, pull=7.0, temperature=0.02)


def agg_sum(frames):
    return frames.sum(axis=0)


def agg_hop_l1(frames):
    totals = frames.sum(axis=1, keepdims=True)
    return np.divide(frames, totals, out=np.zeros_like(frames), where=totals > EPS).mean(axis=0)


def agg_hop_l2(frames):
    norms = np.linalg.norm(frames, axis=1, keepdims=True)
    return np.divide(frames, norms, out=np.zeros_like(frames), where=norms > EPS).mean(axis=0)


def agg_hop_max(frames):
    peaks = frames.max(axis=1, keepdims=True)
    return np.divide(frames, peaks, out=np.zeros_like(frames), where=peaks > EPS).mean(axis=0)


def agg_sqrt(frames):
    return np.sqrt(frames).sum(axis=0)


def agg_log(frames):
    scale = frames.mean()
    return np.log1p(frames / max(scale, EPS)).sum(axis=0)


def agg_median(frames):
    return np.median(frames, axis=0)


def agg_sum_then_sqrt(frames):
    return np.sqrt(frames.sum(axis=0))


def agg_hop_l1_sqrt(frames):
    """Loudness-invariant, then compressed: the two ideas are independent and may add."""
    totals = frames.sum(axis=1, keepdims=True)
    unit = np.divide(frames, totals, out=np.zeros_like(frames), where=totals > EPS)
    return np.sqrt(unit).mean(axis=0)


def agg_trimmed(frames):
    """Drop the loudest and quietest eighth of hops, then sum.

    An excerpt is not uniform: an ad, a breakdown or a cymbal crash is a hop whose chroma is not
    about the key. This is the cheapest possible robustness against that.
    """
    if frames.shape[0] < 8:
        return frames.sum(axis=0)
    energy = frames.sum(axis=1)
    order = np.argsort(energy)
    cut = max(1, frames.shape[0] // 8)
    return frames[order[cut:-cut]].sum(axis=0)


AGGREGATIONS = {
    "sum (shipped)": agg_sum,
    "per-hop L1 then mean": agg_hop_l1,
    "per-hop L2 then mean": agg_hop_l2,
    "per-hop max then mean": agg_hop_max,
    "sqrt then sum": agg_sqrt,
    "log1p then sum": agg_log,
    "median over hops": agg_median,
    "sum then sqrt": agg_sum_then_sqrt,
    "per-hop L1 then sqrt": agg_hop_l1_sqrt,
    "trimmed sum": agg_trimmed,
}


class Recast:
    """A clip view whose `bands` come from a chosen aggregation, leaving everything else alone."""

    def __init__(self, clip, aggregate):
        self._clip = clip
        self._bands = aggregate(clip.frames)

    def __getattr__(self, name):
        return getattr(self._clip, name)

    @property
    def bands(self):
        return self._bands


def main():
    clips = keylab.load_clips()
    seeds = list(range(int(sys.argv[1]))) if len(sys.argv) > 1 else list(range(6))
    base = (keylab.SHAATH_MAJOR_72, keylab.SHAATH_MINOR_72)
    sd = statistics.stdev if len(seeds) > 1 else (lambda _: 0.0)

    results = {}
    for label, aggregate in AGGREGATIONS.items():
        view = [Recast(c, aggregate) for c in clips]
        runs = []
        for seed in seeds:
            preds = [None] * len(view)
            for fold in keylab.song_folds(clips, 6, seed):
                test_idx = set(fold)
                train = [c for i, c in enumerate(view) if i not in test_idx]
                init = generative_fit(train, SHIPPED_BLEND, *base)
                major, minor = fit_profiles(train, *init, **REFINE)
                for i, p in zip(fold, predict([view[i] for i in fold], major, minor)):
                    preds[i] = p
            runs.append(keylab.score(preds, clips))
        results[label] = runs

    reference = results["sum (shipped)"]
    width = max(len(l) for l in results)
    print(f"{len(clips)} clips, {len(seeds)} partitions, refined profile fitted per aggregation\n")
    print(f"{'':<{width}}{'note-set':>18}{'tonic':>18}{'note-set delta':>20}")
    for label, runs in results.items():
        notes = [r[0] for r in runs]
        tonics = [r[1] for r in runs]
        line = (f"{label:<{width}}{statistics.mean(notes):11.1f}% +/-{sd(notes):4.1f}"
                f"{statistics.mean(tonics):11.1f}% +/-{sd(tonics):4.1f}")
        if label != "sum (shipped)":
            delta = [a[0] - b[0] for a, b in zip(runs, reference)]
            line += f"{statistics.mean(delta):+13.2f} +/-{sd(delta):4.2f}"
        print(line)


if __name__ == "__main__":
    main()
