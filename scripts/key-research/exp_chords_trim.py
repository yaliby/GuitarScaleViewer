"""The chord tie-break's features are shares of a duration that was 30% silence.

`trim_corpus.py` found that every capture in the corpus ends in about seventeen seconds of digital
silence. The tone profile does not care (`exp_trim_skew.py`: identical to the clip), because
`aggregate_chromagram`'s silent hops contribute `log1p(0)` and what is left is a rescaling cosine
similarity ignores.

The chord front end is a different shape. Its features are shares of *time* —

    time_on_tonic       how much of the clip that chord is sounding
    time_diatonic       how much of it is spent in the key at all
    changes_into_tonic  how often a chord change lands on the tonic chord

— and a denominator that is 30% silence deflates the first two for every candidate. The weights
that ship were fitted on those numbers and are applied live to a buffer with no silence in it,
which is a train/serve skew rather than noise.

Both arms use the trimmed chromagram and the same folds, so the only thing moving is which chord
cache the 18 features per candidate came from.

    python3 scripts/key-research/exp_chords_trim.py [seeds]
"""
from __future__ import annotations

import statistics
import sys

import numpy as np

import cache_chords_cpp
import keylab
import pipeline
from exp_chords2 import evaluate, extra_matrix

SHORTLIST = 3
L2 = 0.03
RAW_CHORDS = "/tmp/gsv-chord-cpp-cache.npz"
TRIM_CHORDS = "/tmp/gsv-chord-cpp-cache-trim.npz"


def main() -> int:
    seeds = list(range(int(sys.argv[1]))) if len(sys.argv) > 1 else list(range(6))
    clips = keylab.load_clips()  # GSV_CORPUS_SUFFIX decides which; use -trim
    raw = cache_chords_cpp.load(RAW_CHORDS)
    trim = cache_chords_cpp.load(TRIM_CHORDS)
    keep = [c for c in clips if c.clip_id in raw and c.clip_id in trim]
    view = [pipeline.Aggregated(c) for c in keep]
    extra = np.stack([extra_matrix(c.frames, v.bands) for c, v in zip(keep, view)])
    sd = statistics.stdev if len(seeds) > 1 else (lambda _: 0.0)

    print(f"{len(keep)} clips, {len(seeds)} partitions, shortlist {SHORTLIST}, l2 {L2}\n")
    keylab.header()

    def show(label, runs):
        n, t = [r[0] for r in runs], [r[1] for r in runs]
        print(f"{label:<34}{statistics.mean(n):6.1f}% +/-{sd(n):4.1f}"
              f"{statistics.mean(t):8.1f}% +/-{sd(t):4.1f}")

    show("  profile alone (no tie-break)",
         evaluate(keep, view, extra, None, SHORTLIST, L2, seeds,
                  use_chroma=False, use_chords=False))
    for tag, source in (("chords from the captures", raw), ("chords from the music only", trim)):
        features = np.stack([source[c.clip_id] for c in keep])
        show(f"  + tie-break, {tag}",
             evaluate(keep, view, extra, features, SHORTLIST, L2, seeds,
                      use_chroma=False, use_chords=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
