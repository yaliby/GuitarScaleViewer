"""The current best engine, assembled in one place so experiments extend it instead of rebuilding it.

Two stages, both fitted, both measured:

  1. a tone profile fitted generatively and then refined discriminatively (`exp_discriminative.py`),
     which decides the note set;
  2. a logistic model over time-resolved chroma features (`features.py`) which re-decides which end
     of that note set is home.

Everything here is fold-aware: `refined_profiles` and `tonic_model` take the *training* clips and
nothing else, so a caller doing song-wise cross-validation cannot accidentally leak.
"""
from __future__ import annotations

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

import keylab
from features import relative_pair_features
from exp_discriminative import fit_profiles, generative_fit, predict

SHIPPED_BLEND = 0.80
REFINE = dict(relative_credit=0.5, pull=7.0, temperature=0.02)
TONIC_C = 0.003
BASE = (keylab.SHAATH_MAJOR_72, keylab.SHAATH_MINOR_72)
EPS = 1e-12


def aggregate(frames: np.ndarray) -> np.ndarray:
    """Collapse the per-hop chromagram to the 72 numbers the classifier matches.

    libKeyFinder sums raw magnitudes, which lets the loudest bars of an excerpt decide the key.
    Two corrections, measured independently in `exp_aggregation2.py`: normalise each hop by its
    peak so a chorus does not outvote a verse, and take a logarithm so one distorted band cannot
    dominate. Together +2.1 note-set and +3.3 tonic over the sum, on a surface with a clear
    optimum rather than a tuned point — every compression between 0.5 and log gains, and only the
    very aggressive 0.25 turns negative.
    """
    peaks = frames.max(axis=1, keepdims=True)
    x = np.divide(frames, peaks, out=np.zeros_like(frames), where=peaks > EPS)
    mean = x.mean()
    if mean > EPS:
        x = x / mean
    return np.log1p(x).mean(axis=0)


class Aggregated:
    """A clip whose `bands` come from `aggregate` instead of a raw sum."""

    def __init__(self, clip):
        self._clip = clip
        self._bands = aggregate(clip.frames)

    def __getattr__(self, name):
        return getattr(self._clip, name)

    @property
    def bands(self):
        return self._bands


def major_end(root: int, mode: str) -> int:
    """The major tonic of the note set this key belongs to."""
    return root if mode == "major" else (root + 3) % 12


def refined_profiles(train, tag: str = "refine-v1"):
    def compute():
        return fit_profiles(train, *generative_fit(train, SHIPPED_BLEND, *BASE), **REFINE)

    return keylab.cached_fit(keylab.fold_key(train, f"{tag}|{REFINE}|{SHIPPED_BLEND}"), compute)


def tonic_model(train, C: float = TONIC_C, blocks=None):
    X = np.array([
        relative_pair_features(c.frames, major_end(c.root, c.mode), blocks=blocks) for c in train
    ])
    y = np.array([1 if c.mode == "major" else 0 for c in train])
    scaler = StandardScaler().fit(X)
    model = LogisticRegression(C=C, max_iter=4000, class_weight="balanced").fit(
        scaler.transform(X), y
    )
    return scaler, model


def tonic_probability(stage, clips, roots, blocks=None) -> np.ndarray:
    scaler, model = stage
    X = np.array([relative_pair_features(c.frames, r, blocks=blocks) for c, r in zip(clips, roots)])
    return model.predict_proba(scaler.transform(X))[:, 1]


def predict_full(train, test, use_stage: bool = True, C: float = TONIC_C, blocks=None):
    """The whole engine, out of fold: note set from the profile, root from the stage."""
    major, minor = refined_profiles(train)
    preds = predict(test, major, minor)
    if not use_stage:
        return preds
    roots = [major_end(*p) for p in preds]
    stage = tonic_model(train, C, blocks)
    probability = tonic_probability(stage, test, roots, blocks)
    return [
        (r, "major") if p >= 0.5 else ((r + 9) % 12, "minor")
        for r, p in zip(roots, probability)
    ]
