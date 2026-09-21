"""How far the chord tie-break goes, and which parts of it are earning their place.

The first pass gained +2.4 note-set and +4.3 tonic with the shortlist at four candidates, which was
the widest tried. Three things to settle:

  * **how wide the shortlist should be.** It was still improving at the edge. A wider shortlist has
    more chance of containing the truth (89.3% at five, 92.0% at eight) and more chance of the
    re-ranker picking something silly, so there is an optimum rather than a trend.
  * **whether the chroma features are still pulling their weight.** They were carrying the
    re-ranker before the chord features arrived and may now be redundant — and dropping 168
    parameters would matter a great deal at this corpus size.
  * **whether the front end's two new ideas are the reason it works.** Harmonic-percussive
    separation and per-song tuning have never been tested in this project; a global pitch offset
    was, and lost. Both are switched off by environment variable so the caches can be rebuilt
    without them.
"""
from __future__ import annotations

import statistics
import sys

import numpy as np

import keylab
import pipeline
from keylab import KEY_ORDER
from emit_reranker import load_aligned
from exp_rerank import extra_matrix, fit_reranker


def evaluate(clips, view, extra, chord_features, k, l2, seeds, use_chroma=True, use_chords=True):
    runs = []
    for seed in seeds:
        preds = [None] * len(clips)
        for fold in keylab.song_folds(clips, 6, seed):
            idx = set(fold)
            train_idx = [i for i in range(len(clips)) if i not in idx]
            major, minor = pipeline.refined_profiles([view[i] for i in train_idx])

            def build(indices):
                bands = np.array([view[i].bands for i in indices])
                scores = keylab.cosine_scores(bands, major, minor)
                order = np.argsort(-scores, axis=1)
                X, slots = [], []
                for row, i in enumerate(indices):
                    stack = []
                    for slot in range(k):
                        cand = order[row][slot]
                        root, mode = KEY_ORDER[cand]
                        parts = []
                        if use_chroma:
                            half = extra.shape[2]
                            block = np.zeros(2 * half)
                            block[(0 if mode == "major" else half):][:half] = extra[i][root]
                            parts.append(block)
                        parts.append(np.array([
                            scores[row][cand] - scores[row][order[row][0]],
                            float(slot),
                            1.0 if mode == "major" else 0.0,
                        ]))
                        if use_chords:
                            parts.append(chord_features[i][cand])
                        stack.append(np.concatenate(parts))
                    X.append(np.stack(stack))
                    slots.append(next(
                        (s for s in range(k) if KEY_ORDER[order[row][s]] == clips[i].truth), -1
                    ))
                return np.stack(X), np.array(slots), order

            Xtr, ytr, _ = build(train_idx)
            w, mean, std = fit_reranker(Xtr, ytr, l2)
            Xte, _, order_te = build(fold)
            chosen = ((Xte - mean) / std @ w).argmax(axis=1)
            for row, i in enumerate(fold):
                preds[i] = KEY_ORDER[order_te[row][chosen[row]]]
        runs.append(keylab.score(preds, clips))
    return runs


def main():
    clips, chord_features = load_aligned()
    view = [pipeline.Aggregated(c) for c in clips]
    seeds = list(range(int(sys.argv[1]))) if len(sys.argv) > 1 else list(range(6))
    sd = statistics.stdev if len(seeds) > 1 else (lambda _: 0.0)
    extra = np.stack([extra_matrix(c.frames, v.bands) for c, v in zip(clips, view)])

    print(f"{len(clips)} clips / {len(set(c.song for c in clips))} songs, "
          f"{len(seeds)} partitions\n")

    def show(label, runs):
        n = [r[0] for r in runs]
        t = [r[1] for r in runs]
        print(f"{label:<38}{statistics.mean(n):6.1f}% +/-{sd(n):4.1f}"
              f"{statistics.mean(t):8.1f}% +/-{sd(t):4.1f}")

    for k in (3, 4, 5, 6, 8):
        show(f"top-{k}, chroma + chords",
             evaluate(clips, view, extra, chord_features, k, 0.3, seeds))

    print()
    best_k = 5
    show(f"top-{best_k}, chords only (no chroma)",
         evaluate(clips, view, extra, chord_features, best_k, 0.3, seeds, use_chroma=False))
    show(f"top-{best_k}, chroma only (no chords)",
         evaluate(clips, view, extra, chord_features, best_k, 0.3, seeds, use_chords=False))

    print()
    for l2 in (0.1, 0.3, 1.0, 3.0):
        show(f"top-{best_k}, chords only, l2={l2}",
             evaluate(clips, view, extra, chord_features, best_k, l2, seeds, use_chroma=False))


if __name__ == "__main__":
    main()
