"""Guess a song's key (סולם) from the chords in a scraped chart.

Each of the 24 keys is scored by a linear model over what a chart shows about its home chord:
how well the chords fit the key's usual harmony, whether lines and sections open, close and
cadence on its tonic, and how many chords hold the tonic note. Where phrases start and come to
rest matters as much as which chords occur — ``D F#m F Am`` is heard in D or in A minor
depending on it — so charts are scored as sections of lines of chords.

``_ROLE_LOGP`` and ``_WEIGHTS`` are fitted together, on the McGill Billboard chord annotations, by
``scripts/key-research/emit_chart_key.py`` in GuitarScaleViewer; change a feature and both must be
refitted. Cross-validated by song it names the tonic of 89.0% of those songs.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Callable, Iterable, Sequence

_SHARP = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
_FLAT = ("C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B")
_ALIAS = {"Db": 1, "Eb": 3, "Gb": 6, "Ab": 8, "Bb": 10, "Cb": 11, "Fb": 4, "E#": 5, "B#": 0}
# Major keys conventionally spelled with flats (by tonic pitch class).
_FLAT_MAJOR = {5, 10, 3, 8, 1}
_CHORD_RE = re.compile(r"^\(?([A-G][#b]?)(.*)$")
# Triad qualities: major, minor, diminished, augmented, and x for power / sus chords (no third).
_TONES = {"M": (0, 4, 7), "m": (0, 3, 7), "d": (0, 3, 6), "a": (0, 4, 8), "x": (0, 7)}
_SECTION_PRIOR = 4.0

FEATURES = (
    "fit", "tonic_share", "end_dominant", "v_to_i", "iv_to_i", "absent", "v7_share",
    "first_tonic", "start_tonic", "sec_start_tonic", "end_tonic", "sec_end_tonic", "last_tonic",
    "tonic_note", "sec_end_dominant", "root_share", "bvi_to_i",
)

Chord = tuple[int, str, bool]
RoleTables = tuple[dict[tuple[int, str], float], dict[tuple[int, str], float]]

# log P(chord root interval above the tonic, quality | major), then | minor; unlisted roles get the floor.
_ROLE_LOGP: RoleTables = (
    {
        (0, "M"): -1.13, (0, "a"): -8.03, (0, "d"): -8.5, (0, "m"): -5.04, (1, "M"): -5.39, (1, "a"): -9.42,
        (1, "d"): -7.58, (1, "m"): -8.16, (2, "M"): -3.87, (2, "d"): -6.71, (2, "m"): -2.88, (3, "M"): -4.25,
        (3, "a"): -9.7, (3, "d"): -7.62, (3, "m"): -6.55, (4, "M"): -4.92, (4, "a"): -7.97, (4, "d"): -8.03,
        (4, "m"): -3.55, (5, "M"): -1.56, (5, "a"): -9.01, (5, "d"): -8.24, (5, "m"): -4.39, (6, "M"): -5.64,
        (6, "a"): -9.19, (6, "d"): -6.67, (6, "m"): -7.3, (7, "M"): -1.81, (7, "a"): -8.4, (7, "d"): -9.01,
        (7, "m"): -4.68, (8, "M"): -4.51, (8, "a"): -9.7, (8, "d"): -7.37, (8, "m"): -7.02, (9, "M"): -4.56,
        (9, "d"): -7.76, (9, "m"): -2.84, (10, "M"): -3.13, (10, "d"): -8.86, (10, "m"): -6.61, (11, "M"): -5.86,
        (11, "a"): -8.86, (11, "d"): -7.4, (11, "m"): -6.3,
    },
    {
        (0, "M"): -3.97, (0, "m"): -1.19, (1, "M"): -4.9, (1, "d"): -7.69, (1, "m"): -6.52, (2, "M"): -4.42,
        (2, "d"): -6.04, (2, "m"): -4.62, (3, "M"): -2.56, (3, "m"): -5.86, (4, "M"): -6.73, (4, "d"): -8.2,
        (4, "m"): -6.52, (5, "M"): -2.6, (5, "d"): -7.5, (5, "m"): -2.6, (6, "M"): -6.0, (7, "M"): -2.91,
        (7, "a"): -5.33, (7, "d"): -6.81, (7, "m"): -2.95, (8, "M"): -2.0, (8, "d"): -7.69, (8, "m"): -6.73,
        (9, "M"): -6.66, (9, "d"): -7.69, (9, "m"): -4.87, (10, "M"): -1.96, (10, "a"): -7.69, (10, "m"): -5.45,
        (11, "M"): -6.52, (11, "d"): -7.69, (11, "m"): -6.3,
    },
)
_ROLE_LOGP_FLOOR = -10.11
_WEIGHTS = (
    1.449,  # fit
    13.18,  # tonic_share
    1.136,  # end_dominant
    6.113,  # v_to_i
    5.236,  # iv_to_i
    -2.119,  # absent
    3.818,  # v7_share
    1.014,  # first_tonic
    -0.446,  # start_tonic
    4.031,  # sec_start_tonic
    1.403,  # end_tonic
    1.761,  # sec_end_tonic
    0.1657,  # last_tonic
    2.743,  # tonic_note
    2.141,  # sec_end_dominant
    -14.75,  # root_share
    2.334,  # bvi_to_i
)


def parse_chord(chord: str) -> Chord | None:
    """Root pitch class, triad quality, and whether the chord is a dominant seventh."""
    m = _CHORD_RE.match(chord.strip())
    if not m:
        return None
    root, rest = m.groups()
    pc = _ALIAS.get(root, _SHARP.index(root) if root in _SHARP else -1)
    if pc < 0:
        return None
    rest = rest.split("/", 1)[0].strip("()")
    low = rest.lower()
    if low.startswith(("dim", "°", "ø", "m7b5", "m7-5")) or re.match(r"o(\d|$)", rest):
        quality = "d"
    elif low.startswith(("aug", "+")):
        quality = "a"
    elif rest.startswith(("maj", "Maj", "M", "Δ")):
        quality = "M"
    elif rest.startswith(("m", "-")):
        quality = "m"
    elif re.match(r"(5|sus|2(?!\d)|4(?!\d)|no3)", low):
        quality = "x"
    else:
        quality = "M"
    return pc, quality, quality == "M" and bool(re.match(r"(7|9|11|13)", rest))


def _name(pc: int, minor: bool) -> str:
    major_pc = (pc + 3) % 12 if minor else pc
    names = _FLAT if major_pc in _FLAT_MAJOR else _SHARP
    return names[pc] + ("m" if minor else "")


def _role_logp(table: dict[tuple[int, str], float], interval: int, quality: str, floor: float) -> float:
    if quality == "x":
        return max(table.get((interval, "M"), floor), table.get((interval, "m"), floor))
    return table.get((interval, quality), floor)


def key_features(
    sections: Iterable[Iterable[Iterable[str | None]]],
    tables: RoleTables | None = None,
    floor: float | None = None,
) -> list[list[float]] | None:
    """One row of ``FEATURES`` per candidate key, indexed ``2 * tonic + minor``; None without chords."""
    tables = tables or _ROLE_LOGP
    floor = _ROLE_LOGP_FLOOR if floor is None else floor
    secs: list[list[list[Chord]]] = []
    for sec in sections:
        lines = [ph for line in sec if (ph := [p for c in line if c and (p := parse_chord(c))])]
        if lines:
            secs.append(lines)
    if not secs:
        return None
    phrases = [ph for s in secs for ph in s]
    seq = [c for ph in phrases for c in ph]
    triads = [(pc, q) for pc, q, _ in seq]
    n = len(triads)
    counts = Counter(triads)
    changes = [(a, b) for a, b in zip(triads, triads[1:]) if a != b]
    n_changes = max(len(changes), 1)
    starts = [ph[0][:2] for ph in phrases]
    ends = [ph[-1][:2] for ph in phrases]
    sec_starts = [s[0][0][:2] for s in secs]
    sec_ends = [s[-1][-1][:2] for s in secs]
    sevenths = Counter(pc for pc, _, dom7 in seq if dom7)
    holding = [0] * 12
    for (pc, q), k in counts.items():
        for iv in _TONES[q]:
            holding[(pc + iv) % 12] += k

    # Tab4U charts label one or two sections where the fitting corpus labels about nine, so a
    # section statistic leans on its line-level counterpart until there are sections to trust.
    def by_section(section_share: float, line_share: float) -> float:
        return (len(secs) * section_share + _SECTION_PRIOR * line_share) / (len(secs) + _SECTION_PRIOR)

    rows: list[list[float]] = []
    for tonic in range(12):
        dom, sub, flat6 = (tonic + 7) % 12, (tonic + 5) % 12, (tonic + 8) % 12

        # Where phrases rest and resolve is judged by the tonic's root: songs move between the
        # major and minor chord on it (Am … A), and the mode is left to the chord vocabulary.
        def on_tonic(c: tuple[int, str]) -> bool:
            return c[0] == tonic and c[1] in ("M", "m", "x")

        def is_dom(c: tuple[int, str]) -> bool:
            return c[0] == dom and c[1] in ("M", "x")

        def into_tonic(src: Callable[[tuple[int, str]], bool]) -> float:
            return sum(1 for a, b in changes if on_tonic(b) and src(a)) / n_changes

        start_tonic = sum(map(on_tonic, starts)) / len(starts)
        end_tonic = sum(map(on_tonic, ends)) / len(ends)
        end_dominant = sum(map(is_dom, ends)) / len(ends)
        either_mode = {
            "end_dominant": end_dominant,
            "v_to_i": into_tonic(is_dom),
            "iv_to_i": into_tonic(lambda c: c[0] == sub and c[1] in ("M", "m", "x")),
            "v7_share": sevenths[dom] / n,
            "first_tonic": float(on_tonic(triads[0])),
            "start_tonic": start_tonic,
            "sec_start_tonic": by_section(sum(map(on_tonic, sec_starts)) / len(secs), start_tonic),
            "end_tonic": end_tonic,
            "sec_end_tonic": by_section(sum(map(on_tonic, sec_ends)) / len(secs), end_tonic),
            "last_tonic": float(on_tonic(triads[-1])),
            "tonic_note": holding[tonic] / n,
            "sec_end_dominant": by_section(sum(map(is_dom, sec_ends)) / len(secs), end_dominant),
            "root_share": sum(k for c, k in counts.items() if on_tonic(c)) / n,
            "bvi_to_i": into_tonic(lambda c: c[0] == flat6 and c[1] in ("M", "x")),
        }
        for minor in (False, True):
            home = "m" if minor else "M"
            hits = sum(k for (pc, q), k in counts.items() if pc == tonic and q in (home, "x"))
            fit = sum(k * _role_logp(tables[minor], (pc - tonic) % 12, q, floor) for (pc, q), k in counts.items())
            values = either_mode | {"fit": fit / n, "tonic_share": hits / n, "absent": float(hits == 0)}
            rows.append([values[name] for name in FEATURES])
    return rows


def detect_chart_key(sections: Iterable[Iterable[Iterable[str | None]]]) -> str | None:
    """Return a key like ``"G"`` or ``"Em"`` from a chart given as sections of lines of chords."""
    rows = key_features(sections)
    if rows is None:
        return None
    scores = [sum(w * f for w, f in zip(_WEIGHTS, row)) for row in rows]
    best = max(range(len(scores)), key=scores.__getitem__)
    return _name(best // 2, bool(best % 2))


def detect_key(chords: Iterable[str | None]) -> str | None:
    """Return a key like ``"G"`` or ``"Em"`` from a chord sequence read as one line, or None."""
    line: Sequence[str | None] = list(chords)
    return detect_chart_key([[line]])
