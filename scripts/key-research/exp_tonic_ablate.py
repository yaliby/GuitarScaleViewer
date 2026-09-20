"""Which of the tonic stage's twelve feature blocks is actually deciding the root.

144 features against 226 clips is not a comfortable ratio, and the stage's best setting is a very
strong L2 pull — both say most of those features are spending degrees of freedom rather than
earning them. Two passes: each block alone, so a block that carries the signal is visible; then
each block removed, so a block that the others cannot replace is visible. A feature that wins on
its own but is free to drop is redundant; one that loses alone but hurts to drop is a corrector.
"""
from __future__ import annotations

import statistics
import sys

import keylab
import pipeline
from features import FEATURE_BLOCKS


def evaluate(clips, seeds, blocks, C=pipeline.TONIC_C):
    runs = []
    for seed in seeds:
        preds = [None] * len(clips)
        for fold in keylab.song_folds(clips, 6, seed):
            test_idx = set(fold)
            train = [c for i, c in enumerate(clips) if i not in test_idx]
            out = pipeline.predict_full(train, [clips[i] for i in fold], C=C, blocks=blocks)
            for i, p in zip(fold, out):
                preds[i] = p
        runs.append(keylab.score(preds, clips))
    return runs


def main():
    clips = keylab.load_clips()
    seeds = list(range(int(sys.argv[1]))) if len(sys.argv) > 1 else list(range(4))
    sd = statistics.stdev if len(seeds) > 1 else (lambda _: 0.0)

    baseline_runs = []
    for seed in seeds:
        preds = [None] * len(clips)
        for fold in keylab.song_folds(clips, 6, seed):
            test_idx = set(fold)
            train = [c for i, c in enumerate(clips) if i not in test_idx]
            out = pipeline.predict_full(train, [clips[i] for i in fold], use_stage=False)
            for i, p in zip(fold, out):
                preds[i] = p
        baseline_runs.append(keylab.score(preds, clips))
    profile_tonic = [r[1] for r in baseline_runs]
    print(f"profile alone: {statistics.mean(profile_tonic):.1f}% tonic "
          f"(note-set {statistics.mean(r[0] for r in baseline_runs):.1f}%, fixed)\n")

    full = evaluate(clips, seeds, None)
    full_tonic = [r[1] for r in full]
    print(f"{'all 12 blocks':<24}{statistics.mean(full_tonic):6.1f}% tonic\n")

    print("each block alone:")
    scored = []
    for block in FEATURE_BLOCKS:
        t = [r[1] for r in evaluate(clips, seeds, [block])]
        scored.append((statistics.mean(t), block, sd(t)))
    for mean, block, spread in sorted(scored, reverse=True):
        print(f"  {block:<22}{mean:6.1f}% +/-{spread:4.1f}"
              f"   vs profile {mean - statistics.mean(profile_tonic):+5.2f}")

    print("\neach block removed:")
    removed = []
    for block in FEATURE_BLOCKS:
        rest = [b for b in FEATURE_BLOCKS if b != block]
        t = [r[1] for r in evaluate(clips, seeds, rest)]
        removed.append((statistics.mean(t) - statistics.mean(full_tonic), block, sd(t)))
    for delta, block, spread in sorted(removed):
        print(f"  without {block:<14}{statistics.mean(full_tonic) + delta:6.1f}% "
              f"+/-{spread:4.1f}   delta {delta:+5.2f}")


if __name__ == "__main__":
    main()
