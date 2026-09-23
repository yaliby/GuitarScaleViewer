"""How sure is a reading, measured from the evidence instead of from how long it has been repeated?

The engine calls a reading confident once the live gate stops hedging, which in practice means
"the same answer four times running". Replayed over the span cache that is 74.5% precise and
arrives at a median 24 seconds. Time is a poor proxy for evidence: a clear song is as clear at
twelve seconds as at twenty-four, and a muddy one repeats its wrong answer just as faithfully.

The analyzer's own scores say much more. The *note-set margin* — the verdict's score minus the best
score of any key with a different set of notes — splits the corpus from 38% right to 87% right at
twelve seconds. This fits a small logistic model on a handful of such features, cross-validated by
song, and asks the question the product cares about: at each moment, which readings could be shown
as confident, and how often would they be wrong?

Everything a feature needs is on the wire already: the three-entry shortlist always contains the
best key with a different note set, because only one other key (the relative) shares the verdict's.

    python3 scripts/key-research/exp_confidence.py
"""
from __future__ import annotations

import sys

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

import spanlab

HOP = 4
FIRST = 4
SAME = np.array([[spanlab.NOTE_SET[a] == spanlab.NOTE_SET[b] for b in range(24)] for a in range(24)])


def shortlist(scores: np.ndarray, size: int = 3) -> np.ndarray:
    return np.argsort(-scores, kind="stable")[:size]


def features_for(data, verdicts, i: int, s: int, hop: int = HOP) -> list[float] | None:
    """What the engine could compute at span `s` from what it has already been told."""
    if not data.valid[i, s]:
        return None
    sc = data.scores[i, s]
    v = int(verdicts[i, s])
    top3 = shortlist(sc)
    others = [k for k in top3 if not SAME[k, v]]
    note_gap = float(sc[v] - max(sc[k] for k in others)) if others else 0.05
    gap12 = float(sc[top3[0]] - sc[top3[1]])
    # Agreement with the readings the engine made on the way here, on its own hop grid.
    run = 0
    t = s - hop
    while t >= FIRST and data.valid[i, t] and SAME[int(verdicts[i, t]), v]:
        run += 1
        t -= hop
    prev = s - hop
    prev_same = 1.0 if prev >= FIRST and data.valid[i, prev] and SAME[int(verdicts[i, prev]), v] else 0.0
    return [
        note_gap,
        gap12,
        float(sc[top3[0]]),
        np.log(s),
        prev_same,
        min(run, 6),
        note_gap * np.log(s),
    ]


FEATURE_NAMES = ["note_gap", "gap12", "top_score", "log_span", "prev_same", "run", "note_gap*log_span"]


def song_folds(songs: list[str], k: int, seed: int) -> list[np.ndarray]:
    unique = sorted(set(songs))
    rng = np.random.default_rng(seed)
    rng.shuffle(unique)
    fold_of = {song: f % k for f, song in enumerate(unique)}
    idx = np.array([fold_of[s] for s in songs])
    return [np.nonzero(idx == f)[0] for f in range(k)]


def main() -> int:
    data = spanlab.load()
    verdicts = spanlab.verdicts(data)
    notes, exact = spanlab.correctness(data, verdicts)
    spans = list(range(FIRST, 41, 2))
    C = len(data.clip_ids)
    X = {}
    for i in range(C):
        for s in spans:
            f = features_for(data, verdicts, i, s)
            if f is not None:
                X[(i, s)] = f
    keys = list(X)
    clips = np.array([k[0] for k in keys])
    span_of = np.array([k[1] for k in keys])
    F = np.array([X[k] for k in keys])
    y = np.array([notes[i, s] for i, s in keys])
    ye = np.array([exact[i, s] for i, s in keys])

    seeds = range(4)
    oof = np.zeros((len(seeds), len(keys)))
    for si, seed in enumerate(seeds):
        for fold in song_folds(data.songs, 6, seed):
            test = np.isin(clips, fold)
            scaler = StandardScaler().fit(F[~test])
            model = LogisticRegression(C=1.0, max_iter=2000).fit(scaler.transform(F[~test]), y[~test])
            oof[si, test] = model.predict_proba(scaler.transform(F[test]))[:, 1]
    p = oof.mean(axis=0)

    scaler = StandardScaler().fit(F)
    model = LogisticRegression(C=1.0, max_iter=2000).fit(scaler.transform(F), y)
    print("standardised weights:", ", ".join(f"{n} {w:+.2f}" for n, w in zip(FEATURE_NAMES, model.coef_[0])))

    print("\ncalibration, out of fold (all spans pooled):")
    for lo, hi in [(0, .3), (.3, .5), (.5, .7), (.7, .8), (.8, .9), (.9, 1.01)]:
        m = (p >= lo) & (p < hi)
        if m.sum():
            print(f"  p {lo:.1f}-{hi:.1f}: n={m.sum():>5}  notes right {100 * y[m].mean():5.1f}%  exact {100 * ye[m].mean():5.1f}%")

    print("\nat each span: share of clips above threshold, and how many of those are right (notes)")
    header = "".join(f"{f'p>={t:.2f}':>20}" for t in (0.7, 0.8, 0.85, 0.9))
    print(f"{'span':>6}{'base':>8}{header}")
    for s in [6, 8, 10, 12, 14, 16, 20, 24, 30, 36]:
        m = span_of == s
        row = f"{s:>5}s{100 * y[m].mean():>7.1f}%"
        for t in (0.7, 0.8, 0.85, 0.9):
            k = m & (p >= t)
            row += f"{100 * k.sum() / m.sum():>9.1f}% @{100 * y[k].mean() if k.sum() else 0:>6.1f}%  "
        print(row)

    # The policy the card would run: confident from the first reading at or above the threshold.
    print("\nfirst confident reading per clip (4s grid from 4s), threshold sweep:")
    print(f"{'threshold':>10}{'clips':>8}{'median':>8}{'right notes':>13}{'wrong notes':>13}{'precision':>11}")
    by_clip: dict[int, list[tuple[int, float, bool]]] = {}
    for (i, s), prob, right in zip(keys, p, y):
        if s % HOP == 0:
            by_clip.setdefault(i, []).append((s, prob, right))
    for t in (0.6, 0.7, 0.75, 0.8, 0.85, 0.9):
        times, right_n, wrong_n = [], 0, 0
        for i, rows in by_clip.items():
            for s, prob, right in sorted(rows):
                if prob >= t:
                    times.append(s)
                    right_n += right
                    wrong_n += not right
                    break
        n = len(by_clip)
        print(f"{t:>10.2f}{100 * len(times) / n:>7.1f}%{int(np.median(times)) if times else 0:>7}s"
              f"{100 * right_n / n:>12.1f}%{100 * wrong_n / n:>12.1f}%{100 * right_n / max(1, len(times)):>10.1f}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
