"""Keep the profile's verdict as a score, and learn a correction to it over all 24 candidates.

Replacing the profile outright lost by 2.6 points (`exp_unified.py`): a free linear model over the
same features, fitted from zero, cannot rediscover from 167 songs what the profile already encodes.
That is the same lesson the discriminative refinement taught — start from what works.

So this keeps the profile exactly as it is and adds to it:

    score(candidate) = cosine(bands, profile) + w[mode] . extra_features(candidate) + b[mode]

with the profile frozen and only the correction fitted. Three things follow from that shape:

  * it degenerates to the current classifier when the correction is zero, so heavy regularisation
    can only return the status quo rather than something worse;
  * unlike the tonic stage it sees all 24 candidates, so it can move a IV or V error — 8.5% of
    clips, and out of the second stage's reach by construction;
  * the bias finally expresses a major/minor prior, which cosine similarity cancels out.

The extra features deliberately exclude the 72 bands. Those are what the cosine term already reads,
and handing them over twice is how the previous attempt spent its budget.
"""
from __future__ import annotations

import statistics
import sys

import numpy as np
from scipy.optimize import minimize

import keylab
import pipeline
from keylab import KEY_ORDER
from exp_unified import CANDIDATE_MAJOR, CANDIDATE_TONIC, clip_features, targets

EPS = 1e-12


def extra_matrix(frames: np.ndarray, bands72: np.ndarray) -> np.ndarray:
    """(12, D) of everything the cosine term does *not* already see."""
    _, twelves = clip_features(frames, bands72)
    return np.stack([np.concatenate([np.roll(v, -t) for v in twelves]) for t in range(12)])


def cosine_matrix(clips, major72, minor72) -> np.ndarray:
    bands = np.array([c.bands for c in clips])
    return keylab.cosine_scores(bands, major72, minor72)


def fit_correction(extra, cosines, T, l2: float, iterations: int = 300):
    n, _, D = extra.shape
    flat = extra.reshape(-1, D)
    mean, std = flat.mean(axis=0), flat.std(axis=0)
    std = np.where(std > EPS, std, 1.0)
    X = (extra - mean) / std
    mode_index = np.where(CANDIDATE_MAJOR, 0, 1)

    # Cosine similarities here sit above 0.9 and differ between candidates in the third decimal, so
    # the correction must be measured on the same scale or it will simply overwhelm them.
    spread = float(np.std(cosines.max(axis=1) - cosines.min(axis=1))) or 1.0

    def unpack(x):
        return x[: 2 * D].reshape(2, D), x[2 * D:]

    def loss_and_grad(x):
        W, b = unpack(x)
        per_rotation = np.einsum("ntd,md->ntm", X, W)
        correction = per_rotation[:, CANDIDATE_TONIC, mode_index] + b[mode_index]
        z = (cosines + spread * correction) / spread
        z = z - z.max(axis=1, keepdims=True)
        e = np.exp(z)
        p = e / e.sum(axis=1, keepdims=True)
        loss = -(T * np.log(p + 1e-300)).sum() / n + l2 * float(W.ravel() @ W.ravel())

        d = (p - T) / n
        gW = np.zeros((2, D))
        gb = np.zeros(2)
        for m, is_major in ((0, True), (1, False)):
            picks = np.where(CANDIDATE_MAJOR == is_major)[0]
            contrib = d[:, picks]
            gW[m] = np.einsum("nt,ntd->d", contrib, X[:, CANDIDATE_TONIC[picks], :])
            gb[m] = contrib.sum()
        gW += 2 * l2 * W
        return loss, np.concatenate([gW.ravel(), gb])

    result = minimize(loss_and_grad, np.zeros(2 * D + 2), jac=True, method="L-BFGS-B",
                      options=dict(maxiter=iterations))
    W, b = unpack(result.x)
    return W, b, mean, std, spread


def apply_correction(model, extra, cosines):
    W, b, mean, std, spread = model
    X = (extra - mean) / std
    per_rotation = np.einsum("ntd,md->ntm", X, W)
    mode_index = np.where(CANDIDATE_MAJOR, 0, 1)
    z = cosines + spread * (per_rotation[:, CANDIDATE_TONIC, mode_index] + b[mode_index])
    return [KEY_ORDER[k] for k in z.argmax(axis=1)]


def main():
    clips = keylab.load_clips()
    view = [pipeline.Aggregated(c) for c in clips]
    seeds = list(range(int(sys.argv[1]))) if len(sys.argv) > 1 else list(range(6))
    sd = statistics.stdev if len(seeds) > 1 else (lambda _: 0.0)

    extra = np.stack([extra_matrix(c.frames, v.bands) for c, v in zip(clips, view)])
    print(f"{len(clips)} clips, {extra.shape[2]} correction features, {len(seeds)} partitions\n")

    reference = []
    two_stage = []
    for seed in seeds:
        base_preds = [None] * len(clips)
        stage_preds = [None] * len(clips)
        for fold in keylab.song_folds(clips, 6, seed):
            idx = set(fold)
            train = [c for i, c in enumerate(view) if i not in idx]
            test = [view[i] for i in fold]
            for i, p in zip(fold, pipeline.predict_full(train, test, use_stage=False)):
                base_preds[i] = p
            for i, p in zip(fold, pipeline.predict_full(train, test)):
                stage_preds[i] = p
        reference.append(keylab.score(base_preds, clips))
        two_stage.append(keylab.score(stage_preds, clips))

    print(f"{'profile only':<32}{statistics.mean(r[0] for r in reference):6.1f}% note-set"
          f"{statistics.mean(r[1] for r in reference):8.1f}% tonic")
    print(f"{'+ tonic stage (current)':<32}{statistics.mean(r[0] for r in two_stage):6.1f}% note-set"
          f"{statistics.mean(r[1] for r in two_stage):8.1f}% tonic\n")

    for credit in (0.25, 0.5):
        for l2 in (0.03, 0.1, 0.3, 1.0):
            runs = []
            for seed in seeds:
                preds = [None] * len(clips)
                for fold in keylab.song_folds(clips, 6, seed):
                    idx = set(fold)
                    train = [i for i in range(len(clips)) if i not in idx]
                    major, minor = pipeline.refined_profiles([view[i] for i in train])
                    cos_train = cosine_matrix([view[i] for i in train], major, minor)
                    model = fit_correction(extra[train], cos_train,
                                           targets([clips[i] for i in train], credit), l2)
                    cos_test = cosine_matrix([view[i] for i in fold], major, minor)
                    for i, p in zip(fold, apply_correction(model, extra[fold], cos_test)):
                        preds[i] = p
                runs.append(keylab.score(preds, clips))
            notes = [r[0] for r in runs]
            tonics = [r[1] for r in runs]
            print(f"{'correction credit=' + str(credit) + ' l2=' + str(l2):<32}"
                  f"{statistics.mean(notes):6.1f}% +/-{sd(notes):4.1f}"
                  f"{statistics.mean(tonics):8.1f}% +/-{sd(tonics):4.1f}")


if __name__ == "__main__":
    main()
