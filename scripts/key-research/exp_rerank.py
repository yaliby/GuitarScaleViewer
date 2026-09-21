"""Re-rank only the profile's top few candidates, instead of refitting the whole ranking.

`headroom.py` says the true key sits in the profile's top three for **82.2%** of clips against
63.8% at the top, so a re-ranker has eighteen points to play for. Two attempts at claiming it have
lost, and they failed the same way: `exp_unified.py` refit all 24 candidates from scratch and
`exp_correction.py` added a free correction to all 24, and both spent their capacity learning to
suppress twenty-one candidates that the profile had already ruled out.

Restricting the decision to the top k is the obvious repair and the one that matches the only model
here that has ever won — the tonic stage, which succeeds precisely because it chooses between two
candidates rather than twenty-four.

The scoring features are all *relative to the profile's own first choice*, which is what makes this
a re-ranking rather than a second opinion: how far behind the leader a candidate is, what interval
it stands at, whether it changes mode, and what the time-resolved chroma says about it.
"""
from __future__ import annotations

import statistics
import sys

import numpy as np
from scipy.optimize import minimize

import keylab
import pipeline
from keylab import KEY_ORDER
from exp_unified import clip_features

EPS = 1e-12


def extra_matrix(frames: np.ndarray, bands72: np.ndarray) -> np.ndarray:
    _, twelves = clip_features(frames, bands72)
    return np.stack([np.concatenate([np.roll(v, -t) for v in twelves]) for t in range(12)])


def candidate_features(extra, scores, order, k, top_gap):
    """(k, D) for one clip: the extra chroma features plus the profile's own context.

    Splitting the chroma block by mode is what lets one weight vector mean different things for a
    major and a minor candidate without doubling every other feature too.
    """
    leader = KEY_ORDER[order[0]]
    width = extra.shape[1]
    out = np.zeros((k, 2 * width + 17))
    for slot in range(k):
        cand = order[slot]
        root, mode = KEY_ORDER[cand]
        block = 0 if mode == "major" else 1
        out[slot, block * width:(block + 1) * width] = extra[root]
        tail = 2 * width
        out[slot, tail + 0] = scores[cand] - scores[order[0]]
        out[slot, tail + 1] = slot
        out[slot, tail + 2] = 1.0 if mode == "major" else 0.0
        out[slot, tail + 3] = 1.0 if mode == leader[1] else 0.0
        out[slot, tail + 4] = top_gap
        out[slot, tail + 5 + (root - leader[0]) % 12] = 1.0
    return out


def fit_reranker(X, y, l2: float, iterations: int = 300):
    """Softmax over the k slots of each clip; y is the slot holding the truth (or -1)."""
    n, k, D = X.shape
    flat = X.reshape(-1, D)
    mean, std = flat.mean(axis=0), flat.std(axis=0)
    std = np.where(std > EPS, std, 1.0)
    Z = (X - mean) / std
    usable = y >= 0
    Zu, yu = Z[usable], y[usable]

    def loss_and_grad(w):
        z = Zu @ w
        z = z - z.max(axis=1, keepdims=True)
        e = np.exp(z)
        p = e / e.sum(axis=1, keepdims=True)
        m = len(yu)
        loss = -np.log(p[np.arange(m), yu] + 1e-300).sum() / m + l2 * float(w @ w)
        d = p.copy()
        d[np.arange(m), yu] -= 1.0
        grad = np.einsum("nk,nkd->d", d, Zu) / m + 2 * l2 * w
        return loss, grad

    result = minimize(loss_and_grad, np.zeros(D), jac=True, method="L-BFGS-B",
                      options=dict(maxiter=iterations))
    return result.x, mean, std


def main():
    clips = keylab.load_clips()
    view = [pipeline.Aggregated(c) for c in clips]
    seeds = list(range(int(sys.argv[1]))) if len(sys.argv) > 1 else list(range(4))
    sd = statistics.stdev if len(seeds) > 1 else (lambda _: 0.0)
    extra = np.stack([extra_matrix(c.frames, v.bands) for c, v in zip(clips, view)])

    print(f"{len(clips)} clips, {len(seeds)} partitions\n")
    results = {}

    for k in (2, 3, 4):
        for l2 in (0.3, 1.0, 3.0, 10.0):
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
                        gaps = scores[np.arange(len(indices)), order[:, 0]] - \
                            scores[np.arange(len(indices)), order[:, 1]]
                        X, slots = [], []
                        for row, (i, gap) in enumerate(zip(indices, gaps)):
                            X.append(candidate_features(extra[i], scores[row], order[row], k, gap))
                            truth = clips[i].truth
                            slot = next((s for s in range(k)
                                         if KEY_ORDER[order[row][s]] == truth), -1)
                            slots.append(slot)
                        return np.stack(X), np.array(slots), order

                    Xtr, ytr, _ = build(train_idx)
                    w, mean, std = fit_reranker(Xtr, ytr, l2)
                    Xte, _, order_te = build(fold)
                    chosen = ((Xte - mean) / std @ w).argmax(axis=1)
                    for row, i in enumerate(fold):
                        preds[i] = KEY_ORDER[order_te[row][chosen[row]]]
                runs.append(keylab.score(preds, clips))
            notes = [r[0] for r in runs]
            tonics = [r[1] for r in runs]
            results[(k, l2)] = (statistics.mean(notes), statistics.mean(tonics))
            print(f"{'top-' + str(k) + ' rerank l2=' + str(l2):<28}"
                  f"{statistics.mean(notes):6.1f}% +/-{sd(notes):4.1f}"
                  f"{statistics.mean(tonics):8.1f}% +/-{sd(tonics):4.1f}")

    print("\nfor reference: profile alone 74.6% / 63.8%, + tonic stage 74.6% / 64.8%")
    best = max(results.items(), key=lambda kv: kv[1][0])
    print(f"best note-set: top-{best[0][0]} l2={best[0][1]} -> {best[1][0]:.1f}% / {best[1][1]:.1f}%")


if __name__ == "__main__":
    main()
