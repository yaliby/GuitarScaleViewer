"""Are the chord features worth anything — alone, and as a tie-break for the profile?

Two questions, and the second is the one that matters.

**Alone**: a linear model over the eighteen chord features, scored across all 24 candidates. The
project has a number to beat here: a previous chord-sequence key detector scored 55.0 note-set /
38.3 tonic against the profile's 71.7/65.0. If this lands near that, the front end is no better
than the last one and the idea is dead a second time.

**As a tie-break**: the same features added to the top-3 re-ranker, which is where they should
actually pay. A chord reading does not have to be good enough to name the key from nothing; it has
to be good enough to say which of three shortlisted keys the music keeps landing on. Everything
that has failed so far failed by being asked the harder question.
"""
from __future__ import annotations

import statistics
import sys

import numpy as np
from scipy.optimize import minimize

import cache_chords
import chords as chordlib
import keylab
import pipeline
from keylab import KEY_ORDER
from exp_rerank import extra_matrix, fit_reranker

EPS = 1e-12


def load_aligned():
    """Clips present in both caches, so the two feature sets always describe the same audio."""
    clips = keylab.load_clips()
    chord_features, _ = cache_chords.load()
    keep = [c for c in clips if c.clip_id in chord_features]
    missing = len(clips) - len(keep)
    if missing:
        print(f"  ({missing} clips have no chord features and are excluded)")
    return keep, np.stack([chord_features[c.clip_id] for c in keep])


def fit_flat(X, y, l2: float, iterations: int = 300):
    """Softmax over 24 candidates from a per-candidate feature vector, one weight set per mode."""
    n, k, D = X.shape
    flat = X.reshape(-1, D)
    mean, std = flat.mean(axis=0), flat.std(axis=0)
    std = np.where(std > EPS, std, 1.0)
    Z = (X - mean) / std
    is_major = np.array([m == "major" for _, m in KEY_ORDER])

    def loss_and_grad(w):
        W = w[: 2 * D].reshape(2, D)
        b = w[2 * D:]
        z = np.where(is_major, Z @ W[0] + b[0], Z @ W[1] + b[1])
        z = z - z.max(axis=1, keepdims=True)
        e = np.exp(z)
        p = e / e.sum(axis=1, keepdims=True)
        loss = -np.log(p[np.arange(n), y] + 1e-300).mean() + l2 * float(w[: 2 * D] @ w[: 2 * D])
        d = p.copy()
        d[np.arange(n), y] -= 1.0
        d /= n
        gW = np.stack([
            np.einsum("nk,nkd->d", d * is_major, Z),
            np.einsum("nk,nkd->d", d * ~is_major, Z),
        ])
        gb = np.array([(d * is_major).sum(), (d * ~is_major).sum()])
        return loss, np.concatenate([(gW + 2 * l2 * W).ravel(), gb])

    result = minimize(loss_and_grad, np.zeros(2 * D + 2), jac=True, method="L-BFGS-B",
                      options=dict(maxiter=iterations))
    W = result.x[: 2 * D].reshape(2, D)
    b = result.x[2 * D:]
    return W, b, mean, std


def predict_flat(model, X):
    W, b, mean, std = model
    Z = (X - mean) / std
    is_major = np.array([m == "major" for _, m in KEY_ORDER])
    z = np.where(is_major, Z @ W[0] + b[0], Z @ W[1] + b[1])
    return [KEY_ORDER[k] for k in z.argmax(axis=1)]


def main():
    clips, chord_features = load_aligned()
    view = [pipeline.Aggregated(c) for c in clips]
    seeds = list(range(int(sys.argv[1]))) if len(sys.argv) > 1 else list(range(6))
    sd = statistics.stdev if len(seeds) > 1 else (lambda _: 0.0)
    index = {kv: i for i, kv in enumerate(KEY_ORDER)}
    y = np.array([index[c.truth] for c in clips])

    print(f"{len(clips)} clips / {len(set(c.song for c in clips))} songs, "
          f"{len(seeds)} partitions\n")

    # --- the profile, for reference on exactly these clips ---
    base = []
    for seed in seeds:
        preds = [None] * len(clips)
        for fold in keylab.song_folds(clips, 6, seed):
            idx = set(fold)
            train = [view[i] for i in range(len(clips)) if i not in idx]
            for i, p in zip(fold, pipeline.predict_full(train, [view[i] for i in fold])):
                preds[i] = p
        base.append(keylab.score(preds, clips))
    print(f"{'profile + tonic stage':<34}{statistics.mean(r[0] for r in base):6.1f}% note-set"
          f"{statistics.mean(r[1] for r in base):8.1f}% tonic")

    # --- chords alone ---
    print()
    for l2 in (0.01, 0.1, 1.0):
        runs = []
        for seed in seeds:
            preds = [None] * len(clips)
            for fold in keylab.song_folds(clips, 6, seed):
                idx = set(fold)
                train = [i for i in range(len(clips)) if i not in idx]
                model = fit_flat(chord_features[train], y[train], l2)
                for i, p in zip(fold, predict_flat(model, chord_features[fold])):
                    preds[i] = p
            runs.append(keylab.score(preds, clips))
        n = [r[0] for r in runs]
        t = [r[1] for r in runs]
        print(f"{'chords alone, l2=' + str(l2):<34}{statistics.mean(n):6.1f}% +/-{sd(n):4.1f}"
              f"{statistics.mean(t):8.1f}% +/-{sd(t):4.1f}")

    # --- chords as a tie-break in the top-k re-ranker ---
    print()
    extra = np.stack([extra_matrix(c.frames, v.bands) for c, v in zip(clips, view)])
    for k in (2, 3, 4):
        for l2 in (0.1, 0.3, 1.0):
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
                            rows = []
                            for slot in range(k):
                                cand = order[row][slot]
                                root, mode = KEY_ORDER[cand]
                                block = np.zeros(2 * extra.shape[2])
                                half = extra.shape[2]
                                offset = 0 if mode == "major" else half
                                block[offset:offset + half] = extra[i][root]
                                context = np.array([
                                    scores[row][cand] - scores[row][order[row][0]],
                                    float(slot),
                                    1.0 if mode == "major" else 0.0,
                                ])
                                rows.append(np.concatenate(
                                    [block, context, chord_features[i][cand]]
                                ))
                            X.append(np.stack(rows))
                            slots.append(next(
                                (s for s in range(k) if KEY_ORDER[order[row][s]] == clips[i].truth),
                                -1,
                            ))
                        return np.stack(X), np.array(slots), order

                    Xtr, ytr, _ = build(train_idx)
                    w, mean, std = fit_reranker(Xtr, ytr, l2)
                    Xte, _, order_te = build(fold)
                    chosen = ((Xte - mean) / std @ w).argmax(axis=1)
                    for row, i in enumerate(fold):
                        preds[i] = KEY_ORDER[order_te[row][chosen[row]]]
                runs.append(keylab.score(preds, clips))
            n = [r[0] for r in runs]
            t = [r[1] for r in runs]
            print(f"{'top-' + str(k) + ' + chords, l2=' + str(l2):<34}"
                  f"{statistics.mean(n):6.1f}% +/-{sd(n):4.1f}"
                  f"{statistics.mean(t):8.1f}% +/-{sd(t):4.1f}")


if __name__ == "__main__":
    main()
