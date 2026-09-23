"""The profile was fitted on aggregations that are thirty percent silence. The app's are not.

`trim_corpus.py` found that every capture in the corpus ends in silence — a 58-second file holding
about 41 seconds of music. That is a measurement problem for anything counted in seconds, and it
is also a *fitting* problem, because `aggregate_chromagram` is not scale-invariant in the way it
looks:

```c++
const double mean = total / (hops * BANDS);     // `total` skips silent hops; `hops` counts them
out[band] = sum(log1p(scaled[hop][band] / mean)) / hops;
```

`total` accumulates over the hops that carry audio and `mean` divides by all of them, so a clip
that is 30% silence hands `log1p` an input inflated by about 1.4x. Dividing by `hops` afterwards
is harmless — cosine similarity ignores scale — but the inflation happens *before* the logarithm,
and where a compression sits on its curve is worth about two points of note-set accuracy
(`exp_aggregation2.py`). The live engine's buffer is sixty seconds of a playing song with no
silent hops at all, so the profile ships fitted at one operating point and used at another.

This measures whether that costs anything. Both arms are scored on the **trimmed** clips, which
are the ones that look like a live buffer; the only difference is which aggregation the profile
was fitted on.

    python3 trim_corpus.py && GSV_CORPUS_SUFFIX=-trim python3 cache.py
    python3 scripts/key-research/exp_trim_skew.py [seeds]
"""
from __future__ import annotations

import sys

import keylab
import pipeline
from exp_discriminative import fit_profiles, generative_fit, predict

RAW_CACHE = "/tmp/gsv-chroma-cache.npz"
TRIM_CACHE = "/tmp/gsv-chroma-cache-trim.npz"


def profiles_for(train, tag: str):
    def compute():
        return fit_profiles(
            train,
            *generative_fit(train, pipeline.SHIPPED_BLEND, *pipeline.BASE),
            **pipeline.REFINE,
        )

    return keylab.cached_fit(keylab.fold_key(train, tag), compute)


def main() -> int:
    seeds = range(int(sys.argv[1])) if len(sys.argv) > 1 else range(6)
    raw = {c.clip_id: pipeline.Aggregated(c) for c in keylab.load_clips(RAW_CACHE)}
    trim = {c.clip_id: pipeline.Aggregated(c) for c in keylab.load_clips(TRIM_CACHE)}
    shared = [i for i in trim if i in raw]
    print(
        f"{len(shared)} clips in both caches, {len(list(seeds))} random partitions\n"
        "every arm is scored on the trimmed clips — the ones shaped like a live buffer\n"
    )
    keylab.header()

    test_view = [trim[i] for i in shared]
    for tag, source in (("fit on the captures as recorded", raw), ("fit on the music only", trim)):
        def fit_predict(train, test, _source=source, _tag=tag):
            pool = [_source[c.clip_id] for c in train]
            major, minor = profiles_for(pool, f"trim-skew|{_tag}")
            return predict(test, major, minor)

        keylab.report(f"  {tag}", keylab.cross_validate(test_view, fit_predict, k=6, seeds=seeds))

    # The other diagonal, for completeness: the corpus as every published number measured it.
    print()
    raw_view = [raw[i] for i in shared]

    def fit_raw_test_raw(train, test):
        major, minor = profiles_for(
            [raw[c.clip_id] for c in train], "trim-skew|fit on the captures as recorded"
        )
        return predict(test, major, minor)

    keylab.report(
        "  fit and scored as recorded",
        keylab.cross_validate(raw_view, fit_raw_test_raw, k=6, seeds=seeds),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
