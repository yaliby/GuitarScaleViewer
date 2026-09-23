"""The chord tie-break was fitted on whole clips. What does it do to a twelve-second buffer?

Replayed over the span cache, the shipped re-ranker costs note-set accuracy wherever the buffer is
short — 64.0% for libKeyFinder's own winner at twelve seconds against 62.8% after re-ranking — and
only pays, in tonic, past about twenty. Its eighteen chord features are shares of a duration and
counts of events: twelve seconds hold three or four chord changes, so `changes_into_tonic` and the
cadence counts are mostly zero or one, and weights fitted where they average dozens read noise.

The cache holds the chord evidence for every candidate at every second of every clip, so the
re-ranker can be refitted on the buffers it is actually applied to. Arms, all out of fold by song:

    none        libKeyFinder's winner, no tie-break
    shipped     the weights that ship, behind the shipped 0.008 gap gate
    refit       the same 21 features refitted on buffers of every length, same gate
    refit+span  as refit, plus each feature's interaction with log(span) — 42 weights
    refit/any   refit without the gap gate

    python3 scripts/key-research/exp_rerank_spans.py
"""
from __future__ import annotations

import numpy as np

import spanlab
from exp_confidence import song_folds
from exp_rerank import fit_reranker

SHORTLIST = 3
TRAIN_SPANS = list(range(8, 41, 4))
EVAL_SPANS = [6, 8, 10, 12, 16, 20, 24, 30, 36]
GATE = spanlab.CHORD_TIE_BREAK_MAX_GAP


def slot_features(scores: np.ndarray, chords: np.ndarray, span: int, with_span: bool):
    """(3, D) features for the top three candidates, or None when there is no chord evidence."""
    order = np.argsort(-scores, kind="stable")[:SHORTLIST]
    if np.isnan(chords[order]).any():
        return None, order
    rows = []
    for slot, c in enumerate(order):
        base = np.concatenate([[scores[c] - scores[order[0]], slot, 1.0 if c % 2 == 0 else 0.0], chords[c]])
        if with_span:
            base = np.concatenate([base, base * np.log(span)])
        rows.append(base)
    return np.stack(rows), order


def main() -> int:
    data = spanlab.load()
    truth = spanlab.truth_index(data)
    same = np.array([[spanlab.NOTE_SET[a] == spanlab.NOTE_SET[b] for b in range(24)] for a in range(24)])
    shipped = spanlab.verdicts(data)
    C = len(data.clip_ids)

    arms = ["none", "shipped", "refit", "refit+span", "refit/any", "refit/rel", "refit/rel/any"]
    picks = {arm: np.full((2, C, 61), -1, np.int16) for arm in arms}
    for seed in range(2):
        for fold in song_folds(data.songs, 6, seed):
            test = np.zeros(C, bool)
            test[fold] = True
            models = {}
            for with_span in (False, True):
                X, y = [], []
                for i in np.nonzero(~test)[0]:
                    for s in TRAIN_SPANS:
                        if not data.valid[i, s]:
                            continue
                        f, order = slot_features(data.scores[i, s], data.chords[i, s], s, with_span)
                        if f is None:
                            continue
                        X.append(f)
                        hit = np.nonzero(order == truth[i])[0]
                        y.append(int(hit[0]) if len(hit) else -1)
                w, mean, scale = fit_reranker(np.stack(X), np.array(y), 0.03)
                models[with_span] = (w, mean, scale)
            for i in np.nonzero(test)[0]:
                for s in EVAL_SPANS:
                    if not data.valid[i, s]:
                        continue
                    sc = data.scores[i, s]
                    top = int(np.argmax(sc))
                    order = np.argsort(-sc, kind="stable")
                    gap = sc[order[0]] - sc[order[1]]
                    picks["none"][seed, i, s] = int(data.cli_key[i, s])
                    picks["shipped"][seed, i, s] = shipped[i, s]
                    for arm, with_span, gated, relative_only in (
                        ("refit", False, True, False), ("refit+span", True, True, False),
                        ("refit/any", False, False, False), ("refit/rel", False, True, True),
                        ("refit/rel/any", False, False, True),
                    ):
                        f, order3 = slot_features(sc, data.chords[i, s], s, with_span)
                        if f is None or not data.ranking_agrees[i, s] or (gated and gap > GATE):
                            picks[arm][seed, i, s] = top
                            continue
                        w, mean, scale = models[with_span]
                        value = ((f - mean) / scale) @ w
                        if relative_only:
                            # `key_reranker.rs`: the leader or its relative, never another note set.
                            value = np.where([same[int(c), int(order3[0])] for c in order3], value, -np.inf)
                        picks[arm][seed, i, s] = int(order3[int(np.argmax(value))])

    print(f"{'span':>6}" + "".join(f"{arm:>17}" for arm in arms))
    for s in EVAL_SPANS:
        m = data.valid[:, s]
        row = f"{s:>5}s"
        for arm in arms:
            p = picks[arm][:, m, s].astype(int)
            t = np.broadcast_to(truth[m], p.shape)
            notes = 100 * same[p, t].mean()
            exact = 100 * (p == t).mean()
            row += f"{notes:>10.1f}/{exact:<5.1f} "
        print(row)
    print("\n(note-set / exact, mean over two song-wise partitions)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
