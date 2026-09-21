"""One 24-way model over every feature, instead of a tone profile with a patch bolted on.

The engine is currently two stages that do not talk to each other: a cosine match against a 72-band
profile picks the note set, and a logistic model over time-resolved features re-decides which end
of it is home. That split exists for a historical reason — the profile is what libKeyFinder
classifies with — not a principled one, and it costs twice.

  * The cosine form cannot express a prior. Cosine similarity normalises each profile by its own
    norm, so the relative scale of the major and minor profiles cancels exactly, and "this corpus
    is 52% minor" is a fact the classifier is structurally unable to use.
  * The second stage only ever sees two of the 24 candidates. It cannot say "not that note set at
    all", so every IV and V error — 8.5% of clips — is out of its reach by construction.

This replaces both with a single linear model scored over all 24 candidates at once: one weight
vector per mode, applied to a feature vector rotated into each candidate's frame, plus a bias per
mode. A tone profile is the special case where the only features are the 72 bands and the bias is
absent, so this can only do better in sample; the question is entirely whether the extra freedom
survives cross-validation on 167 songs.
"""
from __future__ import annotations

import statistics
import sys

import numpy as np
from scipy.optimize import minimize

import keylab
import pipeline
from keylab import KEY_ORDER

EPS = 1e-12


def _norm(v: np.ndarray) -> np.ndarray:
    total = v.sum()
    return v / total if total > EPS else np.zeros_like(v)


def clip_features(frames: np.ndarray, bands72: np.ndarray) -> tuple[np.ndarray, list[np.ndarray]]:
    """The un-rotated pieces: the 72 octave-resolved bands, and a set of 12-vectors.

    Splitting them this way is what makes rotation cheap — a 12-vector rotates with one `np.roll`
    and the 72 bands rotate as six independent rolls.
    """
    by_octave = frames.reshape(frames.shape[0], 6, 12)
    full = by_octave.sum(axis=1)
    bass = by_octave[:, 0:2, :].sum(axis=1)
    treble = by_octave[:, 4:6, :].sum(axis=1)

    def timeavg(x):
        totals = x.sum(axis=1, keepdims=True)
        return np.divide(x, totals, out=np.zeros_like(x), where=totals > EPS).mean(axis=0)

    def argmax_hist(x):
        hist = np.zeros(12)
        live = x.sum(axis=1) > EPS
        if live.any():
            for p in x[live].argmax(axis=1):
                hist[p] += 1
            hist /= live.sum()
        return hist

    dest = np.zeros(12)
    if frames.shape[0] > 1:
        winners = full.argmax(axis=1)
        moves = 0
        for a, b in zip(winners[:-1], winners[1:]):
            if a != b:
                dest[b] += 1
                moves += 1
        if moves:
            dest /= moves

    twelves = [
        _norm(bands72.reshape(6, 12).sum(axis=0)),
        timeavg(full),
        timeavg(bass),
        timeavg(treble),
        argmax_hist(full),
        argmax_hist(bass),
        dest,
    ]
    return _norm(bands72), twelves


def rotated_matrix(frames: np.ndarray, bands72: np.ndarray) -> np.ndarray:
    """(12, D): row t is every feature expressed with pitch class t at the origin."""
    b72, twelves = clip_features(frames, bands72)
    grid = b72.reshape(6, 12)
    rows = []
    for t in range(12):
        parts = [np.roll(grid, -t, axis=1).reshape(72)]
        parts += [np.roll(v, -t) for v in twelves]
        rows.append(np.concatenate(parts))
    return np.stack(rows)


def targets(clips, relative_credit: float) -> np.ndarray:
    index = {kv: i for i, kv in enumerate(KEY_ORDER)}
    out = np.zeros((len(clips), 24))
    for i, c in enumerate(clips):
        out[i, index[(c.root, c.mode)]] = 1.0 - relative_credit
        if relative_credit > 0:
            rel = ((c.root + 9) % 12, "minor") if c.mode == "major" else ((c.root + 3) % 12, "major")
            out[i, index[rel]] = relative_credit
    return out


# Candidate i in KEY_ORDER has tonic (9 + i//2) % 12 and is major when i is even.
CANDIDATE_TONIC = np.array([(9 + i // 2) % 12 for i in range(24)])
CANDIDATE_MAJOR = np.array([i % 2 == 0 for i in range(24)])


def fit(features: np.ndarray, T: np.ndarray, l2: float, iterations: int = 300):
    """features is (n, 12, D); returns weights (2, D), bias (2,) and the standardiser."""
    n, _, D = features.shape
    # Standardise over the whole rotation orbit, which keeps the model equivariant: pooling across
    # all twelve rotations means no pitch class gets its own scale.
    flat = features.reshape(-1, D)
    mean, std = flat.mean(axis=0), flat.std(axis=0)
    std = np.where(std > EPS, std, 1.0)
    X = (features - mean) / std

    def unpack(x):
        return x[: 2 * D].reshape(2, D), x[2 * D:]

    def loss_and_grad(x):
        W, b = unpack(x)
        # scores[i, k] = W[mode(k)] . X[i, tonic(k)] + b[mode(k)]
        per_rotation = np.einsum("ntd,md->ntm", X, W)  # (n, 12, 2)
        z = per_rotation[:, CANDIDATE_TONIC, np.where(CANDIDATE_MAJOR, 0, 1)] + \
            b[np.where(CANDIDATE_MAJOR, 0, 1)]
        z = z - z.max(axis=1, keepdims=True)
        e = np.exp(z)
        p = e / e.sum(axis=1, keepdims=True)
        loss = -(T * np.log(p + 1e-300)).sum() / n + l2 * float(W.ravel() @ W.ravel())

        d = (p - T) / n  # (n, 24)
        gW = np.zeros((2, D))
        gb = np.zeros(2)
        for mode_index, is_major in ((0, True), (1, False)):
            picks = np.where(CANDIDATE_MAJOR == is_major)[0]
            contrib = d[:, picks]                       # (n, 12)
            rows = X[:, CANDIDATE_TONIC[picks], :]      # (n, 12, D)
            gW[mode_index] = np.einsum("nt,ntd->d", contrib, rows)
            gb[mode_index] = contrib.sum()
        gW += 2 * l2 * W
        return loss, np.concatenate([gW.ravel(), gb])

    start = np.zeros(2 * D + 2)
    result = minimize(loss_and_grad, start, jac=True, method="L-BFGS-B",
                      options=dict(maxiter=iterations))
    W, b = unpack(result.x)
    return W, b, mean, std


def predict(model, features: np.ndarray):
    W, b, mean, std = model
    X = (features - mean) / std
    per_rotation = np.einsum("ntd,md->ntm", X, W)
    z = per_rotation[:, CANDIDATE_TONIC, np.where(CANDIDATE_MAJOR, 0, 1)] + \
        b[np.where(CANDIDATE_MAJOR, 0, 1)]
    return [KEY_ORDER[k] for k in z.argmax(axis=1)]


def main():
    clips = keylab.load_clips()
    seeds = list(range(int(sys.argv[1]))) if len(sys.argv) > 1 else list(range(6))
    sd = statistics.stdev if len(seeds) > 1 else (lambda _: 0.0)

    print("building features...", flush=True)
    features = np.stack([rotated_matrix(c.frames, pipeline.aggregate(c.frames)) for c in clips])
    print(f"{len(clips)} clips, {features.shape[2]} features per rotation, {len(seeds)} partitions\n")

    # The two-stage engine as it stands, for reference.
    reference = []
    for seed in seeds:
        preds = [None] * len(clips)
        for fold in keylab.song_folds(clips, 6, seed):
            idx = set(fold)
            train = [pipeline.Aggregated(c) for i, c in enumerate(clips) if i not in idx]
            test = [pipeline.Aggregated(clips[i]) for i in fold]
            for i, p in zip(fold, pipeline.predict_full(train, test)):
                preds[i] = p
        reference.append(keylab.score(preds, clips))
    print(f"{'two-stage (current)':<30}{statistics.mean(r[0] for r in reference):6.1f}% note-set"
          f"{statistics.mean(r[1] for r in reference):8.1f}% tonic")

    for credit in (0.25, 0.5):
        for l2 in (0.003, 0.01, 0.03, 0.1):
            runs = []
            for seed in seeds:
                preds = [None] * len(clips)
                for fold in keylab.song_folds(clips, 6, seed):
                    idx = set(fold)
                    train = [i for i in range(len(clips)) if i not in idx]
                    model = fit(features[train], targets([clips[i] for i in train], credit), l2)
                    for i, p in zip(fold, predict(model, features[fold])):
                        preds[i] = p
                runs.append(keylab.score(preds, clips))
            notes = [r[0] for r in runs]
            tonics = [r[1] for r in runs]
            print(f"{'unified credit=' + str(credit) + ' l2=' + str(l2):<30}"
                  f"{statistics.mean(notes):6.1f}% +/-{sd(notes):4.1f}"
                  f"{statistics.mean(tonics):8.1f}% +/-{sd(tonics):4.1f}")


if __name__ == "__main__":
    main()
