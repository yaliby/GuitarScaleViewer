"""The span cache as dense arrays, plus the shipped verdict re-derived from them.

`cache_spans.py` stores the CLI's `--research` output for every clip at every second of a growing
buffer. Experiments about *when* the engine can be right need that as arrays indexed
[clip, seconds heard], and they need the shipped decision rebuilt on top of it so that a change can
be measured against exactly what ships. `verdict()` is that rebuild: libKeyFinder's winner, then the
chord re-ranker over the top three when the profile's margin is under 0.008 — the same rule as
`main.cpp` plus `key_reranker.rs`, checked against the Rust replay by `check()`.

    python3 scripts/key-research/spanlab.py          # builds the .npz, prints the analyzer curve
"""
from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass

import numpy as np

import keylab

REPO = keylab.REPO
SUFFIX = os.environ.get("GSV_CORPUS_SUFFIX", "-trim")
JSONL = os.environ.get("GSV_SPAN_CACHE", f"/tmp/gsv-span-cache{SUFFIX}.jsonl")
NPZ = JSONL.replace(".jsonl", ".npz")
MAX_SPAN = 60
CHORD_FEATURES = 18
SHORTLIST = 3
CHORD_TIE_BREAK_MAX_GAP = 0.008
# key_t order, as the CLI's `scores` array is laid out: A major, A minor, A# major, ...
KEY_ORDER = keylab.KEY_ORDER


@dataclass
class SpanSet:
    clip_ids: list[str]
    songs: list[str]
    captures: list[str]
    truth_pc: np.ndarray  # (C,)
    truth_minor: np.ndarray  # (C,) bool
    music_seconds: np.ndarray  # (C,)
    valid: np.ndarray  # (C, S+1) bool — an analysis exists at this span
    cli_key: np.ndarray  # (C, S+1) candidate index of libKeyFinder's own winner, -1 if none
    scores: np.ndarray  # (C, S+1, 24)
    bands: np.ndarray  # (C, S+1, 72)
    chroma: np.ndarray  # (C, S+1, 12)
    chords: np.ndarray  # (C, S+1, 24, 18) — NaN when the chord front end had nothing
    tuning: np.ndarray  # (C, S+1)
    ranking_agrees: np.ndarray  # (C, S+1) bool


def candidate_index(pc: int, mode: str) -> int:
    return KEY_ORDER.index((pc, mode))


def build(path: str = JSONL) -> SpanSet:
    rows = [json.loads(line) for line in open(path) if line.strip()]
    ids = sorted({r["clip_id"] for r in rows})
    index = {c: i for i, c in enumerate(ids)}
    C, S = len(ids), MAX_SPAN + 1
    meta = {}
    valid = np.zeros((C, S), bool)
    cli_key = np.full((C, S), -1, np.int16)
    scores = np.full((C, S, 24), np.nan, np.float32)
    bands = np.full((C, S, 72), np.nan, np.float32)
    chroma = np.full((C, S, 12), np.nan, np.float32)
    chords = np.full((C, S, 24, CHORD_FEATURES), np.nan, np.float32)
    tuning = np.full((C, S), np.nan, np.float32)
    agrees = np.zeros((C, S), bool)
    for r in rows:
        i, s = index[r["clip_id"]], r["span"]
        meta[i] = r
        out = r["out"]
        if not out or "scores" not in out:
            continue
        key, scale = out.get("key", ""), out.get("scale", "")
        if key not in keylab.PC or scale not in ("major", "minor"):
            continue
        valid[i, s] = True
        cli_key[i, s] = candidate_index(keylab.PC[key], scale)
        scores[i, s] = out["scores"]
        bands[i, s] = out["bands"]
        chroma[i, s] = out["chroma"]
        tuning[i, s] = out.get("allTuningCents", np.nan)
        agrees[i, s] = bool(out.get("rankingAgrees"))
        feats = out.get("allChordFeatures") or []
        if out.get("allChordValid") and len(feats) == 24:
            chords[i, s] = np.asarray(feats, np.float32)
    songs = [meta[i]["song"] for i in range(C)]
    caps = [meta[i]["capture"] for i in range(C)]
    truth_pc = np.array([keylab.PC[meta[i]["key"]] for i in range(C)])
    truth_minor = np.array([meta[i]["mode"] == "minor" for i in range(C)])
    music = np.array([meta[i]["music_seconds"] for i in range(C)], np.float32)
    np.savez_compressed(
        NPZ, clip_ids=np.array(ids), songs=np.array(songs), captures=np.array(caps),
        truth_pc=truth_pc, truth_minor=truth_minor, music_seconds=music, valid=valid,
        cli_key=cli_key, scores=scores, bands=bands, chroma=chroma, chords=chords, tuning=tuning,
        ranking_agrees=agrees,
    )
    return load()


def load(path: str = NPZ) -> SpanSet:
    if not os.path.exists(path):
        return build()
    z = np.load(path, allow_pickle=False)
    return SpanSet(
        clip_ids=list(z["clip_ids"]), songs=list(z["songs"]), captures=list(z["captures"]),
        truth_pc=z["truth_pc"], truth_minor=z["truth_minor"], music_seconds=z["music_seconds"],
        valid=z["valid"], cli_key=z["cli_key"], scores=z["scores"], bands=z["bands"],
        chroma=z["chroma"], chords=z["chords"], tuning=z["tuning"], ranking_agrees=z["ranking_agrees"],
    )


def reranker_weights() -> np.ndarray:
    """`WEIGHTS` from src-tauri/src/key_reranker.rs, parsed so it can never go stale."""
    source = open(os.path.join(REPO, "src-tauri/src/key_reranker.rs")).read()
    block = re.search(r"const WEIGHTS: \[f32; FEATURE_COUNT\] = \[(.*?)\];", source, re.S).group(1)
    return np.array([float(v) for v in re.findall(r"(-?\d+\.\d+)", block)])


W = reranker_weights()


def note_set_of(candidate: int) -> frozenset:
    pc, mode = KEY_ORDER[candidate]
    return keylab.pitch_classes(pc, mode)


NOTE_SET = [note_set_of(k) for k in range(24)]


def rerank(scores24: np.ndarray, chords24: np.ndarray, agrees: bool) -> int:
    """The shipped verdict for one analysis: candidate index in key_t order."""
    order = np.argsort(-scores24, kind="stable")
    gap = scores24[order[0]] - scores24[order[1]]
    if not agrees or gap > CHORD_TIE_BREAK_MAX_GAP or np.isnan(chords24).any():
        return int(order[0])
    best, best_score = int(order[0]), -np.inf
    for position in range(SHORTLIST):
        c = int(order[position])
        # `key_reranker.rs`: the tie-break may pick the leader's relative, never another note set.
        if position > 0 and NOTE_SET[c] != NOTE_SET[int(order[0])]:
            continue
        context = [scores24[c] - scores24[order[0]], position, 1.0 if c % 2 == 0 else 0.0]
        value = float(np.dot(W, np.concatenate([context, chords24[c]])))
        if value > best_score:
            best, best_score = c, value
    return best


def verdicts(data: SpanSet) -> np.ndarray:
    """(C, S+1) shipped verdict per analysis, -1 where there is none."""
    out = np.full(data.valid.shape, -1, np.int16)
    for i, s in zip(*np.nonzero(data.valid)):
        out[i, s] = rerank(data.scores[i, s], data.chords[i, s], data.ranking_agrees[i, s])
    return out


def truth_index(data: SpanSet) -> np.ndarray:
    return np.array([
        candidate_index(int(pc), "minor" if minor else "major")
        for pc, minor in zip(data.truth_pc, data.truth_minor)
    ])


def correctness(data: SpanSet, picks: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(notes_right, exact_right) as (C, S+1) bool arrays; False where there is no pick."""
    truth = truth_index(data)
    same_notes = np.array([[NOTE_SET[a] == NOTE_SET[b] for b in range(24)] for a in range(24)])
    notes = np.zeros(picks.shape, bool)
    exact = np.zeros(picks.shape, bool)
    has = picks >= 0
    rows, cols = np.nonzero(has)
    notes[rows, cols] = same_notes[picks[rows, cols], truth[rows]]
    exact[rows, cols] = picks[rows, cols] == truth[rows]
    return notes, exact


def curve(data: SpanSet, picks: np.ndarray, spans=(4, 6, 8, 10, 12, 16, 20, 24, 30, 36, 40)) -> None:
    notes, exact = correctness(data, picks)
    print(f"{'heard':>6}{'notes':>9}{'exact':>9}{'n':>6}")
    for s in spans:
        m = data.valid[:, s]
        if m.sum():
            print(f"{s:>5}s{100 * notes[m, s].mean():>8.1f}%{100 * exact[m, s].mean():>8.1f}%{m.sum():>6}")


if __name__ == "__main__":
    data = build() if "--rebuild" in sys.argv or not os.path.exists(NPZ) else load()
    print(f"{len(data.clip_ids)} clips, {data.valid.sum()} analyses")
    print("\nlibKeyFinder's own winner:")
    curve(data, data.cli_key)
    print("\nshipped verdict (winner, then the chord tie-break):")
    curve(data, verdicts(data))
