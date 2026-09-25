"""Fit the ChordSync chart-key model and print its constants for ``key_detect.py``.

The chords a site shows are the only evidence the sidecar has about a song's key before the
engine has heard any of it, so it scores the 24 keys with a linear model over the chart's
features (``key_detect.FEATURES``). Both the chord-role tables and the weights come from the
McGill Billboard chord annotations — 739 songs with an expert tonic, phrase-segmented lines and
labelled sections:

    curl -L -o /tmp/bb.tar.gz https://ddmal.music.mcgill.ca/billboard/billboard-2.0-salami_chords.tar.gz
    mkdir -p /tmp/bb && tar -xzf /tmp/bb.tar.gz -C /tmp/bb
    python3 emit_chart_key.py /tmp/bb/McGill-Billboard

Cross-validation (by song, role tables re-estimated inside every fold) is what to quote; the
constants that ship are then fitted on every song. As in ``emit_reranker.py``, the standardiser
folds into the weights: its offset is the same for all 24 candidates and cancels in the argmax.
"""
from __future__ import annotations

import math
import re
import sys
from collections import Counter
from pathlib import Path

import numpy as np

SIDECAR = Path(__file__).resolve().parents[2] / "src-tauri" / "sidecars" / "chordsync"
sys.path.insert(0, str(SIDECAR))

from chordsync.core import key_detect  # noqa: E402

PC = {"C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5, "F#": 6, "Gb": 6, "G": 7,
      "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11, "Cb": 11, "Fb": 4, "E#": 5, "B#": 0}
TOKEN = re.compile(r"([A-G][b#]?):([^\s|]+)|(?<![A-Za-z])([NX])(?![A-Za-z])|(\.)")
SECTION = re.compile(r"^[A-Z]'*, ")
QUALITIES = ("M", "m", "d", "a")
ALPHA = 2.0
L2 = 1e-3
FOLDS = 5


def suffix(q: str) -> str:
    """Billboard's Harte shorthand as the chord suffix a chart would print."""
    q = q.split("/")[0]
    for prefix, out in (("hdim", "m7b5"), ("dim", "dim"), ("aug", "aug"), ("min", "m"), ("1(b3", "m"),
                        ("maj7", "maj7"), ("maj9", "maj7"), ("maj13", "maj7"), ("maj", ""), ("sus", "sus4"),
                        ("5", "5"), ("1", "5")):
        if q.startswith(prefix):
            return out
    return "7" if q[:1].isdigit() else ""


def load(root: Path) -> list[dict]:
    songs, seen = [], set()
    for f in sorted(root.glob("*/salami_chords.txt")):
        title = artist = ""
        tonic = None
        per_tonic: Counter = Counter()
        tonic_chords: Counter = Counter()
        sections: list[list[list[str]]] = []
        for raw in f.read_text(errors="replace").splitlines():
            if raw.startswith("# title:"):
                title = raw.split(":", 1)[1].strip()
            elif raw.startswith("# artist:"):
                artist = raw.split(":", 1)[1].strip()
            elif raw.startswith("# tonic:"):
                tonic = PC.get(raw.split(":", 1)[1].strip())
            elif "|" in raw and tonic is not None:
                body = raw.split("\t", 1)[-1]
                if SECTION.match(body) or not sections:
                    sections.append([])
                line: list[str] = []
                for m in TOKEN.finditer(body):
                    if m.group(1):
                        name = m.group(1) + suffix(m.group(2))
                        per_tonic[tonic] += 1
                        if PC[m.group(1)] == tonic:
                            tonic_chords[(tonic, suffix(m.group(2)))] += 1
                        if not line or line[-1] != name:
                            line.append(name)
                if line:
                    sections[-1].append(line)
        sections = [s for s in sections if s]
        key = (title.lower(), artist.lower())
        if not sections or not per_tonic or key in seen:
            continue
        seen.add(key)
        main = per_tonic.most_common(1)[0][0]
        minor_n = tonic_chords[(main, "m")] + tonic_chords[(main, "m7b5")]
        major_n = sum(tonic_chords[(main, s)] for s in ("", "7", "maj7", "aug"))
        songs.append({
            "sections": sections,
            "tonic": main,
            "minor": (minor_n > major_n) if (minor_n or major_n) else None,
            "modulates": len(per_tonic) > 1,
        })
    return songs


def role_tables(songs: list[dict]) -> tuple[key_detect.RoleTables, float]:
    counts = {False: Counter(), True: Counter()}
    for s in songs:
        if s["minor"] is None or s["modulates"]:
            continue
        for sec in s["sections"]:
            for line in sec:
                for c in line:
                    p = key_detect.parse_chord(c)
                    if p and p[1] in QUALITIES:
                        counts[s["minor"]][((p[0] - s["tonic"]) % 12, p[1])] += 1
    tables, floors = [], []
    for minor in (False, True):
        total = sum(counts[minor].values()) + ALPHA * 12 * len(QUALITIES)
        tables.append({k: round(math.log((n + ALPHA) / total), 2) for k, n in sorted(counts[minor].items())})
        floors.append(math.log(ALPHA / total))
    return (tables[0], tables[1]), round(min(floors), 2)


def design(songs, tables, floor):
    X, M = [], []
    for s in songs:
        rows = key_detect.key_features(s["sections"], tables, floor)
        mask = np.zeros(24, bool)
        if s["minor"] is None:
            mask[2 * s["tonic"]] = mask[2 * s["tonic"] + 1] = True
        else:
            mask[2 * s["tonic"] + int(s["minor"])] = True
        X.append(rows)
        M.append(mask)
    return np.array(X), np.array(M)


def train(X, M, iters=1500, lr=0.05):
    flat = X.reshape(-1, X.shape[-1])
    mu, sd = flat.mean(0), flat.std(0) + 1e-9
    Z = (X - mu) / sd
    w = np.zeros(X.shape[-1])
    m = np.zeros_like(w)
    v = np.zeros_like(w)
    for t in range(1, iters + 1):
        s = Z @ w
        s -= s.max(1, keepdims=True)
        p = np.exp(s)
        p /= p.sum(1, keepdims=True)
        q = np.where(M, p, 0)
        q /= q.sum(1, keepdims=True)
        grad = -((q - p)[..., None] * Z).sum(1).mean(0) + L2 * w
        m = 0.9 * m + 0.1 * grad
        v = 0.999 * v + 0.001 * grad**2
        w -= lr * (m / (1 - 0.9**t)) / (np.sqrt(v / (1 - 0.999**t)) + 1e-8)
    return w / sd


def cross_validate(songs):
    order = np.random.default_rng(0).permutation(len(songs))
    tonic_ok = key_ok = keyed = 0
    for part in np.array_split(order, FOLDS):
        held = set(part.tolist())
        train_songs = [s for i, s in enumerate(songs) if i not in held]
        tables, floor = role_tables(train_songs)
        w = train(*design(train_songs, tables, floor))
        X, _ = design([songs[i] for i in part], tables, floor)
        for i, best in zip(part, (X @ w).argmax(1)):
            s = songs[i]
            tonic_ok += best // 2 == s["tonic"]
            if s["minor"] is not None:
                keyed += 1
                key_ok += best == 2 * s["tonic"] + int(s["minor"])
    return tonic_ok / len(songs), key_ok / keyed


def emit_table(table):
    items = [f'({iv}, "{q}"): {lp}' for (iv, q), lp in sorted(table.items())]
    return "\n".join("        " + ", ".join(items[i:i + 6]) + "," for i in range(0, len(items), 6))


if __name__ == "__main__":
    songs = load(Path(sys.argv[1]))
    tonic_acc, key_acc = cross_validate(songs)
    print(f"# {len(songs)} songs, {FOLDS}-fold CV by song: tonic {100 * tonic_acc:.1f}%, key {100 * key_acc:.1f}%")
    tables, floor = role_tables(songs)
    w = train(*design(songs, tables, floor))
    print("_ROLE_LOGP: RoleTables = (\n    {\n" + emit_table(tables[0]) + "\n    },\n    {\n"
          + emit_table(tables[1]) + "\n    },\n)")
    print(f"_ROLE_LOGP_FLOOR = {floor}")
    print("_WEIGHTS = (\n" + "\n".join(f"    {wi:.4g},  # {n}" for n, wi in zip(key_detect.FEATURES, w)) + "\n)")
