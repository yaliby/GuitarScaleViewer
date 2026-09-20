"""Narrow the discriminative fit down, and compare it to the shipped one *paired*.

The first pass showed the discriminative objective ahead on both metrics. Two things were wrong
with how it was measured and one option was untried:

  * The comparison quoted two independent means and their spreads. Both arms see the identical
    fold partitions, so the difference can be measured per partition and quoted with its own error
    bar, which is far tighter than differencing two noisy means.
  * Temperature was fixed at a guess. Cosine similarities in this space sit above 0.9 and the
    gaps between candidates are small, so the softmax temperature decides whether the loss sees
    near-misses at all.
  * The discriminative fit started from Sha'ath. Starting it from the generative fit of the same
    training fold asks a different question: is the discriminative objective a *replacement* for
    the averaging, or a *refinement* of it?
"""
from __future__ import annotations

import statistics
import sys

import numpy as np

import keylab
from keylab import KEY_ORDER
from exp_discriminative import fit_profiles, generative_fit, predict

SHIPPED_BLEND = 0.80


def paired(clips, arms: dict, k: int = 6, seeds=range(8)) -> dict:
    """Run every arm on the identical fold partitions and keep each partition's scores.

    `arms` maps a label to `fit_predict(train, test)`. Returns per-arm lists of (note-set, tonic),
    one entry per seed, so any two arms can be differenced partition by partition.
    """
    out = {label: [] for label in arms}
    for seed in seeds:
        folds = keylab.song_folds(clips, k, seed)
        for label, fn in arms.items():
            preds = [None] * len(clips)
            for fold in folds:
                test_idx = set(fold)
                train = [c for i, c in enumerate(clips) if i not in test_idx]
                for i, p in zip(fold, fn(train, [clips[i] for i in fold])):
                    preds[i] = p
            out[label].append(keylab.score(preds, clips))
    return out


def summarise(results: dict, reference: str) -> None:
    ref = results[reference]
    width = max(len(l) for l in results)
    print(f"{'':<{width}}{'note-set':>18}{'tonic':>18}{'vs shipped (note-set)':>26}")
    for label, runs in results.items():
        notes = [r[0] for r in runs]
        tonics = [r[1] for r in runs]
        sd = statistics.stdev if len(notes) > 1 else (lambda _: 0.0)
        line = (f"{label:<{width}}{statistics.mean(notes):11.1f}% +/-{sd(notes):4.1f}"
                f"{statistics.mean(tonics):11.1f}% +/-{sd(tonics):4.1f}")
        if label != reference:
            delta = [a[0] - b[0] for a, b in zip(runs, ref)]
            line += f"{statistics.mean(delta):+18.2f} +/-{sd(delta):4.2f}"
        print(line)


def main():
    clips = keylab.load_clips()
    seeds = range(int(sys.argv[1])) if len(sys.argv) > 1 else range(8)
    base = (keylab.SHAATH_MAJOR_72, keylab.SHAATH_MINOR_72)

    def shipped(tr, te):
        return predict(te, *generative_fit(tr, SHIPPED_BLEND, *base))

    arms = {"generative 0.80 (shipped)": shipped}

    for temp in (0.005, 0.01, 0.02, 0.04):
        def run(tr, te, temp=temp):
            return predict(te, *fit_profiles(tr, *base, relative_credit=0.25, pull=3.0,
                                             temperature=temp))
        arms[f"discriminative T={temp}"] = run

    # Refinement rather than replacement: start where the averaging ends up.
    for pull in (3.0, 10.0):
        def run(tr, te, pull=pull):
            init = generative_fit(tr, SHIPPED_BLEND, *base)
            return predict(te, *fit_profiles(tr, *init, relative_credit=0.25, pull=pull,
                                             temperature=0.02))
        arms[f"generative then discriminative pull={pull}"] = run

    summarise(paired(clips, arms, seeds=seeds), "generative 0.80 (shipped)")


if __name__ == "__main__":
    main()
