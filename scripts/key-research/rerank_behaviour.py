"""What the re-ranker actually does: how often it overrules, and whether it should have.

A cross-validated total says the model is worth +1.7 note-set and +3.3 tonic. It does not say
whether that is one good decision in ten or a hundred aggressive ones that mostly cancel, and those
two would need very different things said about them in the app. The distinction also decides
whether the Rust unit tests are describing real behaviour or a fantasy — the first draft asserted
that a "wide lead" survives strong chord evidence, using a lead three times larger than any that
occurs.

Reported out of fold, so these are decisions the model made about songs it had not seen.
"""
from __future__ import annotations

import statistics
import sys

import numpy as np

import cache_chords_cpp
import keylab
import pipeline
from keylab import KEY_ORDER
from exp_rerank import fit_reranker

SHORTLIST = 4
L2 = 0.3


def main():
    clips = keylab.load_clips()
    features = cache_chords_cpp.load()
    clips = [c for c in clips if c.clip_id in features]
    chord = np.stack([features[c.clip_id] for c in clips])
    view = [pipeline.Aggregated(c) for c in clips]
    seeds = list(range(int(sys.argv[1]))) if len(sys.argv) > 1 else list(range(6))

    moved_right = moved_wrong = kept_right = kept_wrong = 0
    gaps_moved, gaps_kept = [], []
    feature_rows = []

    for seed in seeds:
        for fold in keylab.song_folds(clips, 6, seed):
            idx = set(fold)
            train_idx = [i for i in range(len(clips)) if i not in idx]
            major, minor = pipeline.refined_profiles([view[i] for i in train_idx])

            def build(indices):
                bands = np.array([view[i].bands for i in indices])
                scores = keylab.cosine_scores(bands, major, minor)
                order = np.argsort(-scores, axis=1)
                rows = np.arange(len(indices))
                gaps = scores[rows, order[:, 0]] - scores[rows, order[:, 1]]
                X, slots = [], []
                for row, i in enumerate(indices):
                    stack = []
                    for slot in range(SHORTLIST):
                        cand = order[row][slot]
                        _, mode = KEY_ORDER[cand]
                        stack.append(np.concatenate([
                            np.array([
                                scores[row][cand] - scores[row][order[row][0]],
                                float(slot),
                                1.0 if mode == "major" else 0.0,
                            ]),
                            chord[i][cand],
                        ]))
                    X.append(np.stack(stack))
                    slots.append(next(
                        (s for s in range(SHORTLIST) if KEY_ORDER[order[row][s]] == clips[i].truth),
                        -1,
                    ))
                return np.stack(X), np.array(slots), order, gaps

            Xtr, ytr, _, _ = build(train_idx)
            w, mean, std = fit_reranker(Xtr, ytr, L2)
            Xte, _, order_te, gaps_te = build(fold)
            chosen = ((Xte - mean) / std @ w).argmax(axis=1)
            for row, i in enumerate(fold):
                picked = KEY_ORDER[order_te[row][chosen[row]]]
                leader = KEY_ORDER[order_te[row][0]]
                correct = picked == clips[i].truth
                if chosen[row] == 0:
                    kept_right += correct
                    kept_wrong += not correct
                    gaps_kept.append(gaps_te[row])
                else:
                    was_right = leader == clips[i].truth
                    moved_right += correct and not was_right
                    moved_wrong += was_right and not correct
                    gaps_moved.append(gaps_te[row])
                if seed == seeds[0]:
                    feature_rows.append(chord[i][order_te[row][0]])

    total = kept_right + kept_wrong + len(gaps_moved)
    print(f"{len(clips)} clips x {len(seeds)} partitions = {total} out-of-fold decisions\n")
    moved = len(gaps_moved)
    print(f"  kept the analyzer's answer   {100 * len(gaps_kept) / total:5.1f}%")
    print(f"  overruled it                 {100 * moved / total:5.1f}%")
    print(f"    of those, fixed a wrong answer   {moved_right:4d}  ({100 * moved_right / max(moved, 1):.0f}%)")
    print(f"    broke a right one                {moved_wrong:4d}  ({100 * moved_wrong / max(moved, 1):.0f}%)")
    print(f"    net                              {moved_right - moved_wrong:+4d} clips")
    print(f"\n  top-two gap when it overrules   median {statistics.median(gaps_moved):.4f}")
    print(f"  top-two gap when it defers      median {statistics.median(gaps_kept):.4f}")

    rows = np.stack(feature_rows)
    print("\nrealistic chord-feature values for the leader (for writing honest unit tests):")
    from chords import FEATURE_NAMES
    for j, name in enumerate(FEATURE_NAMES):
        print(f"  {name:<24} p10 {np.percentile(rows[:, j], 10):6.3f}"
              f"  median {np.median(rows[:, j]):6.3f}  p90 {np.percentile(rows[:, j], 90):6.3f}")


if __name__ == "__main__":
    main()
