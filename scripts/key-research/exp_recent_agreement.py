"""Does the buffer agreeing with its own recent tail predict whether it is right?

The engine currently decides *when* to stop hedging by counting cycles: the same answer six times
running. That is a proxy for confidence made of time, and it costs the player thirty-two seconds
whether or not the reading was ever in doubt. A signal that separated right answers from wrong
ones directly would be worth more than any number of repeats.

`KEY_ACCURACY_BASELINE.md` already records one that works, and never built anything on it:
analysing two different sixty-second stretches of the same song and comparing them separates 74.4%
correct from 37.5%. The app cannot do that — it has one buffer — but it can compare the whole
buffer against its own last twenty seconds, which is one classification of an already-computed
chromagram and therefore free.

Three things are measured here, because a gate needs all three:

  1. how often the two agree;
  2. how much more often the whole-buffer answer is right when they do;
  3. whether the recent tail ever knows better, which would make it a correction rather than a gate.

Everything is out of fold: the profile is fitted on the training songs of each partition and both
readings use it.

    GSV_CORPUS_SUFFIX=-trim python3 scripts/key-research/exp_recent_agreement.py [seeds]
"""
from __future__ import annotations

import statistics
import sys

import numpy as np

import keylab
import pipeline
from exp_span import HOPS_PER_SECOND, Truncated
from exp_discriminative import predict

TAILS = [12, 16, 20, 24, 30]


def note_set(root: int, mode: str) -> frozenset:
    return keylab.pitch_classes(root, mode)


def main() -> int:
    seeds = list(range(int(sys.argv[1]))) if len(sys.argv) > 1 else list(range(6))
    clips = keylab.load_clips()
    whole = [pipeline.Aggregated(c) for c in clips]
    tails = {t: [pipeline.Aggregated(Truncated(c, t)) for c in clips] for t in TAILS}

    print(f"{len(clips)} clips / {len(set(c.song for c in clips))} songs, "
          f"{len(seeds)} partitions\n")
    print(f"{'tail':>6}{'agree':>9}{'right | agree':>16}{'right | differ':>16}"
          f"{'tail right | differ':>22}{'both note sets':>17}")

    for tail in TAILS:
        stats = {k: [] for k in ("agree", "right_agree", "right_differ", "tail_differ", "notes")}
        for seed in seeds:
            rows = []
            for fold in keylab.song_folds(clips, 6, seed):
                idx = set(fold)
                train = [c for i, c in enumerate(whole) if i not in idx]
                major, minor = pipeline.refined_profiles(train)
                w = predict([whole[i] for i in fold], major, minor)
                r = predict([tails[tail][i] for i in fold], major, minor)
                for i, wp, rp in zip(fold, w, r):
                    truth = clips[i].truth
                    rows.append((wp == rp, wp == truth, rp == truth,
                                 note_set(*wp) == note_set(*truth)))
            agree = [x for x in rows if x[0]]
            differ = [x for x in rows if not x[0]]
            stats["agree"].append(100.0 * len(agree) / len(rows))
            stats["right_agree"].append(100.0 * sum(x[1] for x in agree) / max(len(agree), 1))
            stats["right_differ"].append(100.0 * sum(x[1] for x in differ) / max(len(differ), 1))
            stats["tail_differ"].append(100.0 * sum(x[2] for x in differ) / max(len(differ), 1))
            stats["notes"].append(100.0 * sum(x[3] for x in agree) / max(len(agree), 1))
        m = {k: statistics.mean(v) for k, v in stats.items()}
        print(f"{tail:>5}s{m['agree']:>8.1f}%{m['right_agree']:>15.1f}%"
              f"{m['right_differ']:>15.1f}%{m['tail_differ']:>21.1f}%{m['notes']:>16.1f}%")

    print("\n`right` is the exact key from the whole buffer; `both note sets` is the note-set "
          "accuracy of\nthe whole-buffer answer on the clips where the two agree — what the neck "
          "would be drawn from.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
