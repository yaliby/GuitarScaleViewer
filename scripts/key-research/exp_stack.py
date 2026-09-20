"""The whole stack against the shipped engine, one change at a time.

Three changes have been measured separately and each one beat what it replaced:

  1. **aggregation** — per-hop peak normalisation and a log, instead of summing raw magnitudes;
  2. **discriminative refinement** — the fitted profile nudged to separate keys rather than only to
     describe them;
  3. **the tonic stage** — a second model that re-decides which end of the note set is home.

Separate gains do not add. The aggregation and the tonic stage both help tonic accuracy and may be
reading the same thing twice; the refinement is fitted on whatever the aggregation produced, so its
gain is not even defined independently of it. This runs them cumulatively on identical folds so
each line is the marginal value of the change on that line, given everything above it.
"""
from __future__ import annotations

import statistics
import sys

import keylab
import pipeline
from exp_discriminative import fit_profiles, generative_fit, predict

BASE = pipeline.BASE


def run(clips, view, seeds, use_refine: bool, use_stage: bool, tag: str):
    runs = []
    for seed in seeds:
        preds = [None] * len(view)
        for fold in keylab.song_folds(clips, 6, seed):
            test_idx = set(fold)
            train = [c for i, c in enumerate(view) if i not in test_idx]
            test = [view[i] for i in fold]

            def compute():
                init = generative_fit(train, pipeline.SHIPPED_BLEND, *BASE)
                return fit_profiles(train, *init, **pipeline.REFINE) if use_refine else init

            major, minor = keylab.cached_fit(
                keylab.fold_key(train, f"stack|{tag}|{use_refine}"), compute
            )
            out = predict(test, major, minor)
            if use_stage:
                roots = [pipeline.major_end(*p) for p in out]
                stage = pipeline.tonic_model(train)
                probability = pipeline.tonic_probability(stage, test, roots)
                out = [
                    (r, "major") if p >= 0.5 else ((r + 9) % 12, "minor")
                    for r, p in zip(roots, probability)
                ]
            for i, p in zip(fold, out):
                preds[i] = p
        runs.append(keylab.score(preds, clips))
    return runs


def main():
    clips = keylab.load_clips()
    seeds = list(range(int(sys.argv[1]))) if len(sys.argv) > 1 else list(range(10))
    sd = statistics.stdev if len(seeds) > 1 else (lambda _: 0.0)
    raw = clips
    agg = [pipeline.Aggregated(c) for c in clips]

    arms = [
        ("shipped: sum + generative 0.80", raw, False, False, "sum"),
        ("+ discriminative refinement", raw, True, False, "sum"),
        ("+ log aggregation", agg, True, False, "agg"),
        ("+ tonic stage", agg, True, True, "agg"),
        ("(tonic stage without aggregation)", raw, True, True, "sum"),
        ("(log aggregation, no refinement)", agg, False, False, "agg"),
    ]

    print(f"{len(clips)} clips / {len(set(c.song for c in clips))} songs, {len(seeds)} partitions, "
          f"6-fold split by song\n")
    width = max(len(a[0]) for a in arms)
    print(f"{'':<{width}}{'note-set':>18}{'tonic':>18}{'step':>20}")
    previous = None
    for label, view, refine, stage, tag in arms:
        runs = run(clips, view, seeds, refine, stage, tag)
        notes = [r[0] for r in runs]
        tonics = [r[1] for r in runs]
        line = (f"{label:<{width}}{statistics.mean(notes):11.1f}% +/-{sd(notes):4.1f}"
                f"{statistics.mean(tonics):11.1f}% +/-{sd(tonics):4.1f}")
        if previous is not None and not label.startswith("("):
            dn = [a[0] - b[0] for a, b in zip(runs, previous)]
            dt = [a[1] - b[1] for a, b in zip(runs, previous)]
            line += f"  {statistics.mean(dn):+5.2f} / {statistics.mean(dt):+5.2f}"
        print(line)
        if not label.startswith("("):
            previous = runs


if __name__ == "__main__":
    main()
