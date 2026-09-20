"""Three things the first tonic stage left on the table.

It gained +2.9 tonic at the most heavily regularised setting in the sweep, which is the signature of
a model with more features than data: 144 features against 226 clips. Each of these attacks that
from a different side.

  1. **Push the regularisation further.** C was pinned at the low edge; if the optimum is past it,
     the first run was reading the wrong end of the curve.
  2. **Augment with segments.** A 60-second clip is one training example but four overlapping
     20-second stretches of music, each of which has the same tonic. At test time the segments vote.
     This is honest under song-wise cross-validation — the extra examples come from songs already
     in the training fold, never from the test fold.
  3. **Let it see the profile's opinion.** The stage currently throws away what the classifier
     thought, which is the one piece of evidence already known to be worth something. Handing it
     the cosine similarity of both ends lets it learn when to overrule and when to defer.
"""
from __future__ import annotations

import statistics
import sys

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

import keylab
from features import relative_pair_features
from exp_discriminative import fit_profiles, generative_fit, predict
from exp_tonic_stage import major_end

SHIPPED_BLEND = 0.80
REFINE = dict(relative_credit=0.5, pull=7.0, temperature=0.02)


def segments(frames: np.ndarray, count: int) -> list[np.ndarray]:
    """`count` overlapping stretches of a clip, each long enough to hold a phrase."""
    hops = frames.shape[0]
    if count <= 1 or hops < 8:
        return [frames]
    length = max(8, int(hops * 0.55))
    starts = np.linspace(0, max(hops - length, 0), count).astype(int)
    return [frames[s:s + length] for s in starts]


def profile_opinion(clip_frames: np.ndarray, major_root: int, major72, minor72) -> np.ndarray:
    """What the tone-profile classifier thinks of the two ends, as three numbers."""
    bands = clip_frames.sum(axis=0)
    scores = keylab.cosine_scores(bands[None, :], major72, minor72)[0]
    index = {kv: i for i, kv in enumerate(keylab.KEY_ORDER)}
    cos_major = scores[index[(major_root, "major")]]
    cos_minor = scores[index[((major_root + 9) % 12, "minor")]]
    return np.array([cos_major - cos_minor, cos_major - scores.mean(), cos_minor - scores.mean()])


def featurise(frames, root, profiles, seg_count):
    out = []
    for seg in segments(frames, seg_count):
        vector = relative_pair_features(seg, root)
        if profiles is not None:
            vector = np.concatenate([vector, profile_opinion(seg, root, *profiles)])
        out.append(vector)
    return out


def train_stage(clips, C, profiles, seg_count):
    X, y = [], []
    for c in clips:
        root = major_end(c.root, c.mode)
        label = 1 if c.mode == "major" else 0
        for vector in featurise(c.frames, root, profiles, seg_count):
            X.append(vector)
            y.append(label)
    X = np.array(X)
    scaler = StandardScaler().fit(X)
    model = LogisticRegression(C=C, max_iter=4000, class_weight="balanced")
    model.fit(scaler.transform(X), np.array(y))
    return scaler, model


def stage_probability(stage, frames, root, profiles, seg_count) -> float:
    """Average the segment votes, which is what makes the augmentation pay at test time too."""
    scaler, model = stage
    X = np.array(featurise(frames, root, profiles, seg_count))
    return float(model.predict_proba(scaler.transform(X))[:, 1].mean())


def main():
    clips = keylab.load_clips()
    seeds = range(int(sys.argv[1])) if len(sys.argv) > 1 else range(4)
    base = (keylab.SHAATH_MAJOR_72, keylab.SHAATH_MINOR_72)

    variants = []
    for C in (0.0003, 0.001, 0.003):
        variants.append((f"C={C} plain", C, 1, False))
    for C in (0.001, 0.003, 0.01):
        variants.append((f"C={C} 4 segments", C, 4, False))
    for C in (0.001, 0.003, 0.01):
        variants.append((f"C={C} 4 seg + profile", C, 4, True))

    results = {label: [] for label, *_ in variants}
    profile_only = []

    for seed in seeds:
        folds = keylab.song_folds(clips, 6, seed)
        profile_pred = [None] * len(clips)
        stage_pred = {label: [None] * len(clips) for label, *_ in variants}

        for fold in folds:
            test_idx = set(fold)
            train = [c for i, c in enumerate(clips) if i not in test_idx]
            test = [clips[i] for i in fold]

            major, minor = fit_profiles(train, *generative_fit(train, SHIPPED_BLEND, *base), **REFINE)
            preds = predict(test, major, minor)
            for i, p in zip(fold, preds):
                profile_pred[i] = p
            predicted_roots = [major_end(*p) for p in preds]

            for label, C, seg_count, use_profile in variants:
                profiles = (major, minor) if use_profile else None
                stage = train_stage(train, C, profiles, seg_count)
                for i, clip, root in zip(fold, test, predicted_roots):
                    p_major = stage_probability(stage, clip.frames, root, profiles, seg_count)
                    stage_pred[label][i] = (root, "major") if p_major >= 0.5 else ((root + 9) % 12, "minor")

        profile_only.append(keylab.score(profile_pred, clips))
        for label, *_ in variants:
            results[label].append(keylab.score(stage_pred[label], clips))

    sd = statistics.stdev if len(list(seeds)) > 1 else (lambda _: 0.0)
    tonics = [s[1] for s in profile_only]
    print(f"{len(clips)} clips, {len(list(seeds))} partitions. "
          f"note-set is fixed at {statistics.mean(s[0] for s in profile_only):.1f}% "
          f"— the stage only moves the root.\n")
    print(f"  {'refined profile alone':<26}{statistics.mean(tonics):6.1f}% tonic")
    for label, *_ in variants:
        t = [s[1] for s in results[label]]
        delta = [a - b for a, b in zip(t, tonics)]
        print(f"  {'+ ' + label:<26}{statistics.mean(t):6.1f}% tonic +/-{sd(t):4.1f}"
              f"   delta {statistics.mean(delta):+5.2f} +/-{sd(delta):4.2f}")


if __name__ == "__main__":
    main()
