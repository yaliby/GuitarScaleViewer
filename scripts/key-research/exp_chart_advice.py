"""How much is a chord chart's key worth to the neck, and does the recogniser's chord stream earn the same?

Two legs can name a key long before the engine has heard enough audio to be sure of one: the chart
ChordSync scrapes from Tab4U / Ultimate Guitar, seconds after a song starts, and the chords the
recogniser reads off the saved copy of the recording. Both are chord sequences, so both can go
through the chart-key model in ``key_detect.py``. To weigh either against the engine, the neck
needs more than the model's argmax — it needs to know how often the argmax is right *about the
seven notes*, which is what the engine's calibrated probability speaks to, and how often the root
is right once the notes are. This measures both on the McGill Billboard annotations the model was
fitted on, out of fold, with the model refitted inside every fold exactly as ``emit_chart_key.py``
does:

    python3 exp_chart_advice.py /tmp/bb/McGill-Billboard

It also measures the model on the chord stream a recogniser produces, which differs from a chart in
two ways: nobody has split it into phrases and sections, and some of its chords are wrong. The first
is simulated by regrouping every song into four-bar lines from its first bar — what the bar grid of
the recogniser's own beat tracker supports — and the second by replacing a share of the chords with
the confusions a recogniser makes. The duration-weighted profile match the recording's analysis
used to name its key (``harmonia/packages/audio/rhythm.ts`` ``estimateKey``) is scored on the same
songs, for comparison.

What this cannot measure: how often a scraped chart is in another key than the recording (a capo the
chart does not mention, a simplified transcription, another song). That risk is not in the
Billboard annotations and has to be priced separately.
"""
from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

import numpy as np

import emit_chart_key as eck
from emit_chart_key import key_detect

LINE_BARS = 4
NOISE_RATES = (0.1, 0.2, 0.3)
NS_BINS = (0.0, 0.5, 0.7, 0.8, 0.9, 0.95, 0.99, 1.0001)
PAIR_BINS = (0.5, 0.6, 0.7, 0.8, 0.9, 1.0001)
KRUMHANSL = {
    False: np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]),
    True: np.array([6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]),
}


def note_set(index: int) -> int:
    """The major tonic of a key's seven notes; ``2 * tonic + minor`` indexing, as ``key_features``."""
    tonic, minor = divmod(index, 2)
    return (tonic + 3) % 12 if minor else tonic


def relative(index: int) -> int:
    tonic, minor = divmod(index, 2)
    return 2 * ((tonic + 3) % 12) if minor else 2 * ((tonic + 9) % 12) + 1


def load(root: Path) -> list[dict]:
    """``emit_chart_key.load``, keeping each song's bars and their lengths as well."""
    songs, seen = [], set()
    for f in sorted(root.glob("*/salami_chords.txt")):
        title = artist = ""
        tonic = None
        per_tonic: Counter = Counter()
        tonic_chords: Counter = Counter()
        sections: list[list[list[str]]] = []
        timed: list[tuple[float, str]] = []
        for raw in f.read_text(errors="replace").splitlines():
            if raw.startswith("# title:"):
                title = raw.split(":", 1)[1].strip()
            elif raw.startswith("# artist:"):
                artist = raw.split(":", 1)[1].strip()
            elif raw.startswith("# tonic:"):
                tonic = eck.PC.get(raw.split(":", 1)[1].strip())
            elif raw.strip() and not raw.startswith("#"):
                stamp, _, body = raw.partition("\t")
                timed.append((float(stamp), body))
                if "|" in raw and tonic is not None:
                    if eck.SECTION.match(body) or not sections:
                        sections.append([])
                    line: list[str] = []
                    for m in eck.TOKEN.finditer(body):
                        if m.group(1):
                            name = m.group(1) + eck.suffix(m.group(2))
                            per_tonic[tonic] += 1
                            if eck.PC[m.group(1)] == tonic:
                                tonic_chords[(tonic, eck.suffix(m.group(2)))] += 1
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
            "bars": bars_of(timed),
            "tonic": main,
            "minor": (minor_n > major_n) if (minor_n or major_n) else None,
            "modulates": len(per_tonic) > 1,
        })
    return songs


def bars_of(timed: list[tuple[float, str]]) -> list[list[tuple[str | None, float]]]:
    """Every bar as (chord, seconds) beats: a line's span split over its bars, a bar's over its tokens."""
    bars: list[list[tuple[str | None, float]]] = []
    ringing: str | None = None
    for (start, body), (end, _) in zip(timed, timed[1:]):
        contents = body.split("|")[1:-1] if "|" in body else []
        if not contents:
            continue
        span = max(end - start, 0.0) / len(contents)
        for content in contents:
            tokens = list(eck.TOKEN.finditer(content))
            if not tokens:
                continue
            beat = span / len(tokens)
            bar: list[tuple[str | None, float]] = []
            for m in tokens:
                if m.group(1):
                    ringing = m.group(1) + eck.suffix(m.group(2))
                elif m.group(3):
                    ringing = None
                bar.append((ringing, beat))
            bars.append(bar)
    return bars


def regrouped(bars: list[list[tuple[str | None, float]]]) -> list[list[list[str]]]:
    """One section of ``LINE_BARS``-bar lines from the first bar, as a bar grid would cut it."""
    lines = []
    for at in range(0, len(bars), LINE_BARS):
        line: list[str] = []
        for bar in bars[at:at + LINE_BARS]:
            for chord, _ in bar:
                if chord and (not line or line[-1] != chord):
                    line.append(chord)
        if line:
            lines.append(line)
    return [lines] if lines else []


def corrupted(bars, rate: float, rng: np.random.Generator):
    """Replace a share of the chord changes with what a recogniser confuses them with."""
    out = []
    swap: dict[int, str | None] = {}
    serial = 0
    for bar in bars:
        new = []
        for chord, seconds in bar:
            if chord is None:
                new.append((None, seconds))
                continue
            serial += 1 if not new or new[-1][0] != chord else 0
            if serial not in swap:
                swap[serial] = confuse(chord, rng) if rng.random() < rate else chord
            new.append((swap[serial], seconds))
        out.append(new)
    return out


def confuse(chord: str, rng: np.random.Generator) -> str | None:
    parsed = key_detect.parse_chord(chord)
    if not parsed:
        return chord
    root, quality, _ = parsed
    minor = quality == "m"
    kind = rng.integers(4)
    if kind == 0:  # the third misheard: C <-> Cm
        return name(root, not minor)
    if kind == 1:  # the relative chord, two shared notes: C <-> Am
        return name((root + 9) % 12, True) if not minor else name((root + 3) % 12, False)
    if kind == 2:  # the mediant, two shared notes: C <-> Em
        return name((root + 4) % 12, True) if not minor else name((root + 8) % 12, False)
    return name(int(rng.integers(12)), bool(rng.integers(2)))


def name(pc: int, minor: bool) -> str:
    return key_detect._SHARP[pc] + ("m" if minor else "")


def profile_key(bars) -> int:
    """``estimateKey`` in ``rhythm.ts``: Krumhansl-Kessler against the duration-weighted chord tones."""
    chroma = np.zeros(12)
    for bar in bars:
        for chord, seconds in bar:
            parsed = key_detect.parse_chord(chord) if chord else None
            if parsed:
                for iv in key_detect._TONES[parsed[1]]:
                    chroma[(parsed[0] + iv) % 12] += seconds
    if not chroma.any():
        return -1
    chroma = chroma - chroma.mean()
    best, best_score = -1, -np.inf
    for minor in (False, True):
        profile = KRUMHANSL[minor] - KRUMHANSL[minor].mean()
        for tonic in range(12):
            score = chroma @ np.roll(profile, tonic) / (np.linalg.norm(chroma) * np.linalg.norm(profile) or 1)
            if score > best_score:
                best, best_score = 2 * tonic + int(minor), score
    return best


def softmax(scores: np.ndarray) -> np.ndarray:
    z = np.exp(scores - scores.max())
    return z / z.sum()


def distribution(sections, tables, floor, w) -> np.ndarray | None:
    rows = key_detect.key_features(sections, tables, floor)
    return None if rows is None else softmax(np.array(rows) @ w)


def out_of_fold(songs: list[dict]) -> dict[str, list]:
    """Every variant's key distribution per song, from a model that never saw the song."""
    order = np.random.default_rng(0).permutation(len(songs))
    variants: dict[str, list] = {"chart": [None] * len(songs), "bar grid": [None] * len(songs)}
    for rate in NOISE_RATES:
        variants[f"bar grid, {int(rate * 100)}% misread"] = [None] * len(songs)
    for part in np.array_split(order, eck.FOLDS):
        held = set(part.tolist())
        train_songs = [s for i, s in enumerate(songs) if i not in held]
        tables, floor = eck.role_tables(train_songs)
        w = eck.train(*eck.design(train_songs, tables, floor))
        for i in part:
            s = songs[i]
            variants["chart"][i] = distribution(s["sections"], tables, floor, w)
            variants["bar grid"][i] = distribution(regrouped(s["bars"]), tables, floor, w)
            for rate in NOISE_RATES:
                rng = np.random.default_rng(1000 + int(i))
                noisy = corrupted(s["bars"], rate, rng)
                variants[f"bar grid, {int(rate * 100)}% misread"][i] = distribution(regrouped(noisy), tables, floor, w)
    return variants


def truth_index(s: dict) -> int | None:
    return None if s["minor"] is None else 2 * s["tonic"] + int(s["minor"])


def accuracy(label: str, songs: list[dict], picks: list[int]) -> None:
    tonic = [p >= 0 and p // 2 == s["tonic"] for s, p in zip(songs, picks)]
    keyed = [(s, p) for s, p in zip(songs, picks) if truth_index(s) is not None]
    key = [p == truth_index(s) for s, p in keyed]
    notes = [p >= 0 and note_set(p) == note_set(truth_index(s)) for s, p in keyed]
    print(f"  {label:<28} tonic {100 * np.mean(tonic):5.1f}%   key {100 * np.mean(key):5.1f}%   "
          f"note set {100 * np.mean(notes):5.1f}%   (n={len(songs)}, keyed {len(keyed)})")


def calibration(label: str, songs: list[dict], dists: list) -> None:
    """How often the argmax's seven notes are right, against the mass the model puts on them."""
    rows = []
    pair_rows = []
    for s, p in zip(songs, dists):
        truth = truth_index(s)
        if p is None or truth is None:
            continue
        best = int(np.argmax(p))
        mass = float(p[best] + p[relative(best)])
        right = note_set(best) == note_set(truth)
        rows.append((mass, right))
        if right:
            # Which end of the pair is home, judged by the model's own split of the pair.
            home = best if p[best] >= p[relative(best)] else relative(best)
            share = float(max(p[best], p[relative(best)]) / (p[best] + p[relative(best)]))
            pair_rows.append((share, home == truth))
    print(f"  {label}: note-set mass of the argmax against how often those notes are right")
    for lo, hi in zip(NS_BINS, NS_BINS[1:]):
        hit = [r for m, r in rows if lo <= m < hi]
        if hit:
            print(f"    mass {lo:4.2f}-{min(hi, 1):4.2f}   {len(hit):4d} songs   {100 * np.mean(hit):5.1f}% right")
    print(f"  {label}: the pair's split against how often its larger end is the tonic (notes right)")
    for lo, hi in zip(PAIR_BINS, PAIR_BINS[1:]):
        hit = [r for m, r in pair_rows if lo <= m < hi]
        if hit:
            print(f"    split {lo:3.1f}-{min(hi, 1):3.1f}   {len(hit):4d} songs   {100 * np.mean(hit):5.1f}% right")


if __name__ == "__main__":
    songs = load(Path(sys.argv[1]))
    variants = out_of_fold(songs)
    print(f"# {len(songs)} songs, {eck.FOLDS}-fold CV by song, model refitted in every fold\n")
    print("argmax accuracy")
    for label, dists in variants.items():
        accuracy(label, songs, [int(np.argmax(p)) if p is not None else -1 for p in dists])
    accuracy("profile match (rhythm.ts)", songs, [profile_key(s["bars"]) for s in songs])
    rng_songs = [(s, corrupted(s["bars"], 0.2, np.random.default_rng(1000 + i))) for i, s in enumerate(songs)]
    accuracy("profile match, 20% misread", songs, [profile_key(b) for _, b in rng_songs])
    print()
    for label in ("chart", "bar grid", "bar grid, 20% misread"):
        calibration(label, songs, variants[label])
        print()
