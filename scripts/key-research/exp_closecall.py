"""Only run the chord tie-break when the profile is actually torn.

Two reasons to ask this, one practical and one about trust.

**Practical.** The chord front end is an STFT, a median-filter pass and a filterbank over the whole
buffer, and the engine re-analyses every `ANALYSIS_HOP_SECONDS` = 4 seconds. Whatever it costs, it
costs every four seconds forever. If the tie-break only changes the answer when the profile's top
two are close together, then running it only then buys the whole gain for a fraction of the work.

**Trust.** A re-ranker that overrules a confident profile is doing something different from one that
breaks ties, and the second is much easier to believe. If the gain survives the restriction, the
model is reading genuine ambiguity; if it needs to overrule confident calls to win, that is worth
knowing before shipping it.

The gate is the cosine gap between the profile's first and second choice.
"""
from __future__ import annotations

import statistics
import sys

import numpy as np

import keylab
import pipeline
from keylab import KEY_ORDER
from emit_reranker import load_aligned
from exp_rerank import fit_reranker


def evaluate(clips, view, chord_features, k, l2, seeds, gate_quantile):
    """`gate_quantile` is the share of clips (by smallest top-two gap) the re-ranker may touch."""
    runs = []
    touched = []
    for seed in seeds:
        preds = [None] * len(clips)
        changed = 0
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
                    for slot in range(k):
                        cand = order[row][slot]
                        _, mode = KEY_ORDER[cand]
                        stack.append(np.concatenate([
                            np.array([
                                scores[row][cand] - scores[row][order[row][0]],
                                float(slot),
                                1.0 if mode == "major" else 0.0,
                            ]),
                            chord_features[i][cand],
                        ]))
                    X.append(np.stack(stack))
                    slots.append(next(
                        (s for s in range(k) if KEY_ORDER[order[row][s]] == clips[i].truth), -1
                    ))
                return np.stack(X), np.array(slots), order, gaps

            Xtr, ytr, _, gaps_tr = build(train_idx)
            w, mean, std = fit_reranker(Xtr, ytr, l2)
            Xte, _, order_te, gaps_te = build(fold)
            chosen = ((Xte - mean) / std @ w).argmax(axis=1)
            # The threshold comes from the training fold, so the test fold never sets its own gate.
            threshold = (np.quantile(gaps_tr, gate_quantile) if gate_quantile < 1.0 else np.inf)
            for row, i in enumerate(fold):
                if gaps_te[row] <= threshold:
                    preds[i] = KEY_ORDER[order_te[row][chosen[row]]]
                    changed += chosen[row] != 0
                else:
                    preds[i] = KEY_ORDER[order_te[row][0]]
        runs.append(keylab.score(preds, clips))
        touched.append(100 * changed / len(clips))
    return runs, touched


def main():
    clips, chord_features = load_aligned()
    view = [pipeline.Aggregated(c) for c in clips]
    seeds = list(range(int(sys.argv[1]))) if len(sys.argv) > 1 else list(range(6))
    sd = statistics.stdev if len(seeds) > 1 else (lambda _: 0.0)

    print(f"{len(clips)} clips, {len(seeds)} partitions, top-4 shortlist\n")
    print(f"{'gate':<34}{'note-set':>18}{'tonic':>18}{'answers moved':>16}")
    for quantile in (0.25, 0.5, 0.75, 1.0):
        runs, touched = evaluate(clips, view, chord_features, 4, 0.3, seeds, quantile)
        n = [r[0] for r in runs]
        t = [r[1] for r in runs]
        label = "always" if quantile == 1.0 else f"closest {int(quantile * 100)}% of calls"
        print(f"{label:<34}{statistics.mean(n):11.1f}% +/-{sd(n):4.1f}"
              f"{statistics.mean(t):11.1f}% +/-{sd(t):4.1f}{statistics.mean(touched):13.1f}%")


if __name__ == "__main__":
    main()
