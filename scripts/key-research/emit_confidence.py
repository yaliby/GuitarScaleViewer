"""Fit the note-set confidence model on the whole span cache and print it as Rust.

`exp_confidence.py` is the measurement — out of fold, split by song — and this is the fit that
ships: the same six features and the same regularisation, trained on every clip, with the
standardiser folded into the weights so the Rust side is one dot product and a logistic.

It also prints a handful of reference inputs with the probability this fit gives them, which
`key_confidence.rs` pins in a unit test. If the Rust feature order or arithmetic ever drifts from
this file, that test is what says so.

    python3 scripts/key-research/emit_confidence.py
"""
from __future__ import annotations

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

import spanlab
from exp_confidence import FIRST, HOP, SAME, shortlist

FEATURES = ["note_set_margin", "top_score", "log_span", "prev_same", "run", "note_set_margin_x_log_span"]
RUN_CAP = 6


def features(margin: float, top_score: float, span: float, prev_same: bool, run: int) -> list[float]:
    log_span = float(np.log(span))
    return [margin, top_score, log_span, 1.0 if prev_same else 0.0, float(min(run, RUN_CAP)), margin * log_span]


def row(data, verdicts, i: int, s: int):
    if not data.valid[i, s]:
        return None
    sc = data.scores[i, s]
    v = int(verdicts[i, s])
    top3 = shortlist(sc)
    others = [k for k in top3 if not SAME[k, v]]
    margin = float(sc[v] - max(sc[k] for k in others))
    run = 0
    t = s - HOP
    while t >= FIRST and data.valid[i, t] and SAME[int(verdicts[i, t]), v]:
        run += 1
        t -= HOP
    return features(margin, float(sc[top3[0]]), float(s), run >= 1, run)


def main() -> int:
    data = spanlab.load()
    verdicts = spanlab.verdicts(data)
    notes, _ = spanlab.correctness(data, verdicts)
    X, y = [], []
    for i in range(len(data.clip_ids)):
        for s in range(FIRST, 41, 2):
            f = row(data, verdicts, i, s)
            if f is not None:
                X.append(f)
                y.append(notes[i, s])
    X, y = np.array(X), np.array(y)
    scaler = StandardScaler().fit(X)
    model = LogisticRegression(C=1.0, max_iter=4000).fit(scaler.transform(X), y)
    w = model.coef_[0] / scaler.scale_
    b = float(model.intercept_[0] - np.sum(model.coef_[0] * scaler.mean_ / scaler.scale_))
    print(f"// fitted on {len(y)} readings from {len(data.clip_ids)} clips")
    print("const WEIGHTS: [f32; FEATURE_COUNT] = [")
    for name, value in zip(FEATURES, w):
        print(f"    {value:>12.6f},  // {name}")
    print("];")
    print(f"const INTERCEPT: f32 = {b:.6f};")
    print("\n// reference inputs: (margin, top_score, span, prev_same, run) -> p")
    for margin, top, span, prev, run in [
        (0.002, 0.95, 8, False, 0),
        (0.015, 0.95, 12, True, 2),
        (0.030, 0.96, 20, True, 4),
        (0.008, 0.93, 16, False, 0),
        (-0.004, 0.95, 24, True, 1),
    ]:
        x = np.array(features(margin, top, span, prev, run))
        p = 1.0 / (1.0 + np.exp(-(float(x @ w) + b)))
        print(f"//   ({margin}, {top}, {span}, {str(prev).lower()}, {run}) -> {p:.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
