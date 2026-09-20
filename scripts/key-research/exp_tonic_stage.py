"""A second stage that decides which end of the note set is home.

The error decomposition says 12.8% of clips land on the right seven notes and the wrong root, and
that bucket is invisible to the tone profile by construction: a key and its relative have identical
pitch content, so the classifier is choosing between two candidates it cannot tell apart except
through the shape of the profile's *weighting*. It gets that right about 82% of the time, and the
remaining 18% is the single largest addressable block of tonic error left.

So: keep the profile classifier's note set, and re-decide the root with a model that reads the
things the profile never sees — octave split and time structure (`features.py`).

Two evaluations, because they answer different questions:

  * **oracle note set** — given the right seven notes, how well can the end be called at all?
    This is the ceiling, and it is what says whether the idea has any life in it.
  * **end to end** — the profile picks the note set, the stage re-decides the root. This is the
    number that would ship, and it can be *worse* than the ceiling suggests, because on a clip
    whose note set is already wrong the stage is being asked a meaningless question.
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

SHIPPED_BLEND = 0.80
REFINE = dict(relative_credit=0.5, pull=7.0, temperature=0.02)


def major_end(root: int, mode: str) -> int:
    """The major tonic of the note set this key belongs to."""
    return root if mode == "major" else (root + 3) % 12


def build_xy(clips, roots=None):
    """Features against the given major end (default: each clip's true one) and major/minor label."""
    if roots is None:
        roots = [major_end(c.root, c.mode) for c in clips]
    X = np.array([relative_pair_features(c.frames, r) for c, r in zip(clips, roots)])
    y = np.array([1 if c.mode == "major" else 0 for c in clips])
    return X, y


def train_stage(clips, C: float):
    X, y = build_xy(clips)
    scaler = StandardScaler().fit(X)
    model = LogisticRegression(C=C, max_iter=2000, class_weight="balanced")
    model.fit(scaler.transform(X), y)
    return scaler, model


def apply_stage(stage, clips, roots):
    scaler, model = stage
    X = np.array([relative_pair_features(c.frames, r) for c, r in zip(clips, roots)])
    probability_major = model.predict_proba(scaler.transform(X))[:, 1]
    return probability_major


def main():
    clips = keylab.load_clips()
    seeds = range(int(sys.argv[1])) if len(sys.argv) > 1 else range(6)
    base = (keylab.SHAATH_MAJOR_72, keylab.SHAATH_MINOR_72)
    Cs = [0.003, 0.01, 0.03, 0.1, 0.3]

    oracle = {C: [] for C in Cs}
    oracle_profile = []
    end_to_end = {C: [] for C in Cs}
    shipped_scores = []

    for seed in seeds:
        folds = keylab.song_folds(clips, 6, seed)
        profile_pred = [None] * len(clips)
        oracle_hits = {C: 0 for C in Cs}
        profile_oracle_hits = 0
        stage_pred = {C: [None] * len(clips) for C in Cs}

        for fold in folds:
            test_idx = set(fold)
            train = [c for i, c in enumerate(clips) if i not in test_idx]
            test = [clips[i] for i in fold]

            major, minor = fit_profiles(train, *generative_fit(train, SHIPPED_BLEND, *base), **REFINE)
            preds = predict(test, major, minor)
            for i, p in zip(fold, preds):
                profile_pred[i] = p

            # Ceiling: the true note set is handed over, only the end is in question.
            true_roots = [major_end(c.root, c.mode) for c in test]
            for C in Cs:
                stage = train_stage(train, C)
                p_major = apply_stage(stage, test, true_roots)
                for c, pm in zip(test, p_major):
                    oracle_hits[C] += (pm >= 0.5) == (c.mode == "major")

            # What would ship: the profile's note set, the stage's root.
            predicted_roots = [major_end(*p) for p in preds]
            for C in Cs:
                stage = train_stage(train, C)
                p_major = apply_stage(stage, test, predicted_roots)
                for i, r, pm in zip(fold, predicted_roots, p_major):
                    stage_pred[C][i] = (r, "major") if pm >= 0.5 else ((r + 9) % 12, "minor")

            # And how often the profile alone gets the end right when the notes are right.
            for c, p in zip(test, preds):
                if keylab.pitch_classes(*p) == keylab.pitch_classes(*c.truth):
                    profile_oracle_hits += p == c.truth

        notes_right = sum(
            keylab.pitch_classes(*p) == keylab.pitch_classes(*c.truth)
            for p, c in zip(profile_pred, clips)
        )
        oracle_profile.append(100 * profile_oracle_hits / max(notes_right, 1))
        shipped_scores.append(keylab.score(profile_pred, clips))
        for C in Cs:
            oracle[C].append(100 * oracle_hits[C] / len(clips))
            end_to_end[C].append(keylab.score(stage_pred[C], clips))

    sd = statistics.stdev if len(list(seeds)) > 1 else (lambda _: 0.0)
    print(f"{len(clips)} clips / {len(set(c.song for c in clips))} songs, "
          f"{len(list(seeds))} partitions\n")

    print("ceiling: given the true note set, how often is the end called right?")
    print(f"  {'profile alone':<24}{statistics.mean(oracle_profile):6.1f}% "
          f"+/-{sd(oracle_profile):4.1f}")
    for C in Cs:
        print(f"  {'tonic stage C=' + str(C):<24}{statistics.mean(oracle[C]):6.1f}% "
              f"+/-{sd(oracle[C]):4.1f}")

    print("\nend to end (profile note set, stage root):")
    notes = [s[0] for s in shipped_scores]
    tonics = [s[1] for s in shipped_scores]
    print(f"  {'refined profile alone':<24}{statistics.mean(notes):6.1f}% note-set  "
          f"{statistics.mean(tonics):6.1f}% tonic +/-{sd(tonics):4.1f}")
    for C in Cs:
        n = [s[0] for s in end_to_end[C]]
        t = [s[1] for s in end_to_end[C]]
        delta = [a - b for a, b in zip(t, tonics)]
        print(f"  {'+ tonic stage C=' + str(C):<24}{statistics.mean(n):6.1f}% note-set  "
              f"{statistics.mean(t):6.1f}% tonic +/-{sd(t):4.1f}   "
              f"tonic delta {statistics.mean(delta):+5.2f} +/-{sd(delta):4.2f}")


if __name__ == "__main__":
    main()
