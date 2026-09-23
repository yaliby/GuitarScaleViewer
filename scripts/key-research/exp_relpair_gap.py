"""Where the profile's gap between a key and its relative stops being a coin flip.

`key_engine::RELATIVE_PAIR_COIN_FLIP_GAP` hedges the root when the analyzer's top two are a relative
pair closer than a threshold, and the threshold is a calibration of *this* profile on *this*
front end: it says below which cosine gap the leader is no better than its relative. Refit the
profile, or change what the chromagram is built from, and the gaps change scale with it — so the
calibration has to be re-derived, not carried over.

Read off the span cache, over the buffer lengths the neck is drawn from, and pooled so the buckets
hold enough readings to mean something:

    GSV_SPAN_CACHE=/tmp/gsv-span-cache-trim.jsonl python3 scripts/key-research/exp_relpair_gap.py
"""
from __future__ import annotations

import numpy as np

import spanlab

SPANS = list(range(8, 41, 4))
EDGES = [0.0, 0.001, 0.002, 0.003, 0.004, 0.006, 0.008, 0.012, 0.02, 1.0]


def main() -> int:
    data = spanlab.load()
    truth = spanlab.truth_index(data)
    rows = []
    for i in range(len(data.clip_ids)):
        for s in SPANS:
            if not data.valid[i, s]:
                continue
            sc = data.scores[i, s]
            order = np.argsort(-sc, kind="stable")
            a, b = int(order[0]), int(order[1])
            if spanlab.NOTE_SET[a] != spanlab.NOTE_SET[b]:
                continue
            rows.append((float(sc[a] - sc[b]), a == truth[i], b == truth[i]))
    total = sum(int(data.valid[i, s]) for i in range(len(data.clip_ids)) for s in SPANS)
    print(f"{spanlab.JSONL}\n{len(rows)} of {total} readings ({100 * len(rows) / total:.0f}%) "
          f"have a relative pair on top\n")
    print(f"{'gap':>16}{'n':>7}{'leader right':>15}{'runner-up right':>18}")
    gaps = np.array([r[0] for r in rows])
    lead = np.array([r[1] for r in rows])
    runner = np.array([r[2] for r in rows])
    for lo, hi in zip(EDGES[:-1], EDGES[1:]):
        m = (gaps >= lo) & (gaps < hi)
        if m.sum():
            print(f"{lo:7.3f}-{hi:<8.3f}{m.sum():>7}{100 * lead[m].mean():>14.1f}%{100 * runner[m].mean():>17.1f}%")
    print(f"\nmedian gap {np.median(gaps):.4f}; quartiles {np.quantile(gaps, 0.25):.4f} / {np.quantile(gaps, 0.75):.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
