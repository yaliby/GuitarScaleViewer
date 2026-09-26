from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass

import numpy as np

_ROOTS = {
    "C": 0,
    "B#": 0,
    "C#": 1,
    "Db": 1,
    "D": 2,
    "D#": 3,
    "Eb": 3,
    "E": 4,
    "Fb": 4,
    "E#": 5,
    "F": 5,
    "F#": 6,
    "Gb": 6,
    "G": 7,
    "G#": 8,
    "Ab": 8,
    "A": 9,
    "A#": 10,
    "Bb": 10,
    "B": 11,
    "Cb": 11,
}
_DEGREE_SEMITONES = {1: 0, 2: 2, 3: 4, 4: 5, 5: 7, 6: 9, 7: 11}


@dataclass(frozen=True)
class ChordTarget:
    root: int
    triad: int
    seventh: int
    bass: int
    extensions: tuple[int, int, int, int]


def _degree_to_semitone(value: str) -> int:
    match = re.fullmatch(r"(?P<accidental>[b#]*)(?P<degree>\d+)", value)
    if match is None:
        raise ValueError(f"Unsupported Harte degree: {value}")
    degree = int(match.group("degree"))
    base = _DEGREE_SEMITONES[((degree - 1) % 7) + 1] + 12 * ((degree - 1) // 7)
    accidental = match.group("accidental")
    return (base + accidental.count("#") - accidental.count("b")) % 12


def encode_harte(label: str) -> ChordTarget:
    if label in {"N", "X"}:
        return ChordTarget(12, 0, 0, 12, (0, 0, 0, 0))
    match = re.fullmatch(r"(?P<root>[A-G](?:b|#)?):(?P<body>[^/]+)(?:/(?P<bass>[^/]+))?", label)
    if match is None:
        raise ValueError(f"Unsupported Harte chord: {label}")
    root = _ROOTS[match.group("root")]
    body = match.group("body")
    quality = body.split("(", 1)[0]
    degrees = set(re.findall(r"(?<!\*)[b#]*\d+", body))
    if not quality and "b3" in degrees and "b5" in degrees:
        triad = 3
    elif not quality and "3" in degrees and "#5" in degrees:
        triad = 4
    elif not quality and "b3" in degrees:
        triad = 2
    elif not quality and "3" in degrees:
        triad = 1
    elif not quality and "2" in degrees:
        triad = 5
    elif not quality and "4" in degrees:
        triad = 6
    elif not quality:
        triad = 7
    elif quality.startswith("min") or quality.startswith("hdim"):
        triad = 2
    elif quality.startswith("dim"):
        triad = 3
    elif quality.startswith("aug"):
        triad = 4
    elif quality.startswith("sus2"):
        triad = 5
    elif quality.startswith("sus4") or quality == "sus":
        triad = 6
    elif quality in {"5", "1"}:
        triad = 7
    else:
        triad = 1

    if "maj7" in quality or (not quality and "7" in degrees):
        seventh = 2
    elif ("dim7" in quality and not quality.startswith("hdim")) or "bb7" in degrees:
        seventh = 3
    elif "7" in quality or (not quality and "b7" in degrees):
        seventh = 1
    else:
        seventh = 0

    tokens = set(re.findall(r"(?<!\*)[b#]?(?:6|9|11|13)(?!\d)", body))
    extensions = tuple(
        int(any(token.lstrip("b#") == degree for token in tokens))
        for degree in ("6", "9", "11", "13")
    )
    bass_degree = match.group("bass") or "1"
    bass = (root + _degree_to_semitone(bass_degree)) % 12
    return ChordTarget(root, triad, seventh, bass, extensions)


def targets_at_times(
    intervals: Iterable[tuple[float, float, str]],
    times: np.ndarray,
    *,
    boundary_tolerance: float,
) -> dict[str, np.ndarray]:
    rows = list(intervals)
    encoded = [encode_harte(label) for _, _, label in rows]
    indices = np.full(len(times), -1, dtype=np.int64)
    for index, (start, end, _) in enumerate(rows):
        indices[(times >= start) & (times < end)] = index
    output = {
        "root": np.full(len(times), 12, dtype=np.int64),
        "triad": np.zeros(len(times), dtype=np.int64),
        "seventh": np.zeros(len(times), dtype=np.int64),
        "bass": np.full(len(times), 12, dtype=np.int64),
        "extensions": np.zeros((len(times), 4), dtype=np.float32),
        "boundary": np.zeros(len(times), dtype=np.float32),
    }
    for frame_index, chord_index in enumerate(indices):
        if chord_index >= 0:
            target = encoded[chord_index]
            output["root"][frame_index] = target.root
            output["triad"][frame_index] = target.triad
            output["seventh"][frame_index] = target.seventh
            output["bass"][frame_index] = target.bass
            output["extensions"][frame_index] = target.extensions
    boundaries = np.array([start for start, _, _ in rows[1:]], dtype=np.float64)
    if boundaries.size:
        output["boundary"] = (
            np.min(np.abs(times[:, None] - boundaries[None, :]), axis=1) <= boundary_tolerance
        ).astype(np.float32)
    return output
