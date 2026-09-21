"""Re-sweep and refit every fitted constant, in the order they depend on each other.

Run this when the corpus changes. It is not just a refit: with more songs the regularisation optima
*move*, and they have moved every time so far — the profile blend went from 0.50 to 0.80 when the
corpus went from 64 songs to 167, because 144 free numbers need much less holding back once there
is data to support them. Refitting at the old settings would leave most of the gain on the table.

The order matters. The aggregation feeds the profile, the profile's ranking decides the shortlist,
and the shortlist decides what the re-ranker sees, so each stage has to be settled before the next
one is measured.

    python3 cache.py && python3 cache_chords_cpp.py && python3 refit_all.py

Then paste the two printed blocks into `main.cpp` and `key_reranker.rs`, rebuild, and re-run
`verify_classifier.py` and the Rust scoreboard.
"""
from __future__ import annotations

import statistics
import subprocess
import sys

import numpy as np

import cache_chords_cpp
import keylab
import pipeline
from exp_chords2 import evaluate
from exp_discriminative import fit_profiles, generative_fit, predict


def header(title: str) -> None:
    print(f"\n{'=' * 72}\n{title}\n{'=' * 72}")


def profile_scores(clips, view, seeds, blend, pull, temperature):
    runs = []
    for seed in seeds:
        preds = [None] * len(view)
        for fold in keylab.song_folds(clips, 6, seed):
            idx = set(fold)
            train = [c for i, c in enumerate(view) if i not in idx]
            init = generative_fit(train, blend, *pipeline.BASE)
            major, minor = (init if pull is None else
                            fit_profiles(train, *init, relative_credit=0.5, pull=pull,
                                         temperature=temperature))
            for i, p in zip(fold, predict([view[i] for i in fold], major, minor)):
                preds[i] = p
        runs.append(keylab.score(preds, clips))
    return runs


def show(label, runs, sd):
    n = [r[0] for r in runs]
    t = [r[1] for r in runs]
    print(f"  {label:<32}{statistics.mean(n):6.1f}% +/-{sd(n):4.1f}"
          f"{statistics.mean(t):8.1f}% +/-{sd(t):4.1f}")
    return statistics.mean(n)


def main():
    seeds = list(range(int(sys.argv[1]))) if len(sys.argv) > 1 else list(range(8))
    sd = statistics.stdev if len(seeds) > 1 else (lambda _: 0.0)
    clips = keylab.load_clips()
    view = [pipeline.Aggregated(c) for c in clips]
    songs = len(set(c.song for c in clips))
    print(f"{len(clips)} clips / {songs} songs, {len(seeds)} partitions, 6-fold split by song")

    header("1. the profile: generative blend, then discriminative pull")
    print("  (aggregation is fixed at per-hop peak + log1p; re-sweep it in exp_aggregation2.py)")
    best = (None, -1.0)
    for blend in (0.7, 0.8, 0.9, 1.0):
        score = show(f"generative blend={blend}",
                     profile_scores(clips, view, seeds, blend, None, None), sd)
        if score > best[1]:
            best = (blend, score)
    blend = best[0]
    print(f"\n  best blend {blend}; now the discriminative refinement on top\n")
    best = (None, -1.0)
    for pull in (3.0, 5.0, 7.0, 10.0, 14.0):
        score = show(f"refine pull={pull}",
                     profile_scores(clips, view, seeds, blend, pull, 0.02), sd)
        if score > best[1]:
            best = (pull, score)
    pull = best[0]
    print(f"\n  best pull {pull}")

    header("2. the re-ranker: shortlist width and regularisation")
    _, chord_features = cache_chords_cpp.load_aligned()
    aligned = cache_chords_cpp.load()
    keep = [i for i, c in enumerate(clips) if c.clip_id in aligned]
    sub = [clips[i] for i in keep]
    sub_view = [view[i] for i in keep]
    sub_chords = np.stack([aligned[c.clip_id] for c in sub])
    if len(sub) != len(clips):
        print(f"  ({len(clips) - len(sub)} clips have no chord features)")

    best = (None, None, -1.0)
    for k in (3, 4, 5):
        for l2 in (0.03, 0.1, 0.3, 1.0):
            score = show(f"top-{k} l2={l2}",
                         evaluate(sub, sub_view, None, sub_chords, k, l2, seeds, use_chroma=False),
                         sd)
            if score > best[2]:
                best = (k, l2, score)
    print(f"\n  best shortlist {best[0]}, l2 {best[1]}")

    header("3. the constants to paste")
    print(f"  main.cpp        SHIPPED_BLEND (emit_profiles.py) = {blend}")
    print(f"  main.cpp        REFINE pull                      = {pull}")
    print(f"  main.cpp        SHORTLIST_SIZE                   = {best[0]}")
    print(f"  emit_reranker   L2                               = {best[1]}")
    print("\n  Set those in pipeline.py / emit_reranker.py, then:")
    print("    python3 emit_profiles.py && python3 cache_chords_cpp.py && python3 emit_reranker.py")
    print("  The chord cache must be rebuilt in between: the profile decides the shortlist, and")
    print("  the shortlist decides which candidates the re-ranker is fitted over.")


if __name__ == "__main__":
    main()
