"""Fit the shipping re-ranker weights and print them as Rust.

Cross-validation says what the re-ranker is worth on unseen songs; the weights that ship are then
fitted on the whole corpus, because there is no reason to hold data back from the final fit. The
numbers to quote are always the cross-validated ones.

The standardiser does not need to ship. The score is `w . ((x - mean) / scale)`, and the
`- sum(w_i * mean_i / scale_i)` term is identical for every candidate on the shortlist, so it
cancels in the argmax. Folding `1/scale` into the weights leaves one array of 21 numbers as the
entire model.
"""
from __future__ import annotations

import sys

import numpy as np

import chords as chordlib
import keylab
import pipeline
from cache_chords_cpp import load_aligned
from exp_rerank import fit_reranker
from keylab import KEY_ORDER

SHORTLIST = 3
L2 = 0.03
CONTEXT_NAMES = ["score_gap_to_leader", "shortlist_position", "is_major"]


def build(clips, view, chord_features, indices, major, minor):
    bands = np.array([view[i].bands for i in indices])
    scores = keylab.cosine_scores(bands, major, minor)
    order = np.argsort(-scores, axis=1)
    X, slots = [], []
    for row, i in enumerate(indices):
        stack = []
        for slot in range(SHORTLIST):
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
            (s for s in range(SHORTLIST) if KEY_ORDER[order[row][s]] == clips[i].truth), -1
        ))
    return np.stack(X), np.array(slots)


def main():
    clips, chord_features = load_aligned()
    view = [pipeline.Aggregated(c) for c in clips]
    major, minor = pipeline.refined_profiles(view)
    X, y = build(clips, view, chord_features, list(range(len(clips))), major, minor)
    w, mean, scale = fit_reranker(X, y, L2)

    folded = w / scale
    names = CONTEXT_NAMES + list(chordlib.FEATURE_NAMES)
    assert len(folded) == len(names), (len(folded), len(names))

    usable = int((y >= 0).sum())
    lines = [
        "/// The re-ranker's weights, in the order the feature vector is built.",
        "///",
        f"/// Fitted on {len(clips)} clips from {len(set(c.song for c in clips))} songs "
        f"({usable} of which have the",
        "/// true key somewhere on the shortlist and so contribute a gradient).",
        "const WEIGHTS: [f32; FEATURE_COUNT] = [",
    ]
    for value, name in zip(folded, names):
        lines.append(f"    {value:>12.6f},  // {name}")
    lines.append("];")
    text = "\n".join(lines)

    out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/gsv-reranker-weights.txt"
    open(out, "w").write(text + "\n")
    print(text)
    print(f"\nwritten to {out}")

    ranked = sorted(zip(np.abs(w), names, w), reverse=True)
    print("\nwhat the model leans on (standardised weight, largest first):")
    for magnitude, name, signed in ranked[:10]:
        print(f"  {name:<24}{signed:+8.3f}")


if __name__ == "__main__":
    main()
