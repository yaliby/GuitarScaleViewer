"""How much is left for a re-ranker, before building one.

Two models that re-decided the answer have now lost — a free 24-way model and an additive
correction to the profile's score — while the narrow binary tonic stage won. The obvious reading is
that the useful hypothesis space is small, and the next question is *how* small it can be while
still containing the right answer.

This measures the ceiling directly: how often the truth is inside the profile's top-k candidates.
A re-ranker over the top three can never beat the top-three hit rate, however good it is, and if
that rate is 80% then a 65% engine has 15 points of room. If it is 70%, re-ranking is nearly
exhausted and the work belongs upstream in the chromagram instead.

Reported for both metrics, because they have different ceilings: a note set appears twice in the
24-candidate list (a key and its relative), so it gets two chances at every k.
"""
from __future__ import annotations

import collections
import statistics
import sys

import numpy as np

import keylab
import pipeline
from keylab import KEY_ORDER


def main():
    clips = keylab.load_clips()
    view = [pipeline.Aggregated(c) for c in clips]
    seeds = list(range(int(sys.argv[1]))) if len(sys.argv) > 1 else list(range(4))
    ks = (1, 2, 3, 4, 5, 8)

    tonic_hits = {k: [] for k in ks}
    notes_hits = {k: [] for k in ks}
    rank_of_truth = collections.Counter()
    neighbour_rank = collections.Counter()

    for seed in seeds:
        tonic_run = {k: 0 for k in ks}
        notes_run = {k: 0 for k in ks}
        for fold in keylab.song_folds(clips, 6, seed):
            idx = set(fold)
            train = [view[i] for i in range(len(clips)) if i not in idx]
            major, minor = pipeline.refined_profiles(train)
            bands = np.array([view[i].bands for i in fold])
            scores = keylab.cosine_scores(bands, major, minor)
            order = np.argsort(-scores, axis=1)
            for row, i in zip(order, fold):
                truth = clips[i].truth
                ranked = [KEY_ORDER[c] for c in row]
                where = next((r for r, cand in enumerate(ranked) if cand == truth), 99)
                rank_of_truth[min(where, 9)] += 1
                where_notes = next(
                    (r for r, cand in enumerate(ranked)
                     if keylab.pitch_classes(*cand) == keylab.pitch_classes(*truth)),
                    99,
                )
                neighbour_rank[min(where_notes, 9)] += 1
                for k in ks:
                    tonic_run[k] += where < k
                    notes_run[k] += where_notes < k
        for k in ks:
            tonic_hits[k].append(100 * tonic_run[k] / len(clips))
            notes_hits[k].append(100 * notes_run[k] / len(clips))

    print(f"{len(clips)} clips, {len(seeds)} partitions, refined profile + log aggregation\n")
    print(f"{'k':>3}{'note set in top k':>22}{'exact key in top k':>22}")
    for k in ks:
        print(f"{k:>3}{statistics.mean(notes_hits[k]):19.1f}%{statistics.mean(tonic_hits[k]):21.1f}%")

    total = sum(rank_of_truth.values())
    print("\nwhere the true key actually sits in the ranking:")
    for rank in range(10):
        share = 100 * rank_of_truth[rank] / total
        bar = "#" * int(share)
        label = f"{rank + 1}" if rank < 9 else "10+"
        print(f"  rank {label:>3}  {share:5.1f}%  {bar}")


if __name__ == "__main__":
    main()
