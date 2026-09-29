"""Beat-synchronous decoding with LV-Chordia's own XHMM, and the bar-phase check that keeps it safe.

LV-Chordia's decoder was built to take beats: a chord may only change on a beat, cheaply on a
downbeat (15), less so mid-bar (45), dearly elsewhere (100). The app never gave it beats, because
the tracker it had could not be trusted with them. On GuitarSet (180 accompaniment excerpts, the
lead-sheet chords) Beat This! beats with downbeats lift root accuracy from 84.6% to 86.4% and
segmentation from 88.8% to 91.0%.

The same penalties make a wrong downbeat expensive: shift every downbeat one beat late and root
accuracy falls to 80.9%, under the frame-level decoder it replaced. So the bar phase is not taken
on trust. Every rotation of the tracked downbeats is scored by the decoder's own best-path log
likelihood, chords being likeliest to change on a real downbeat; the tracker's phase keeps a
10-nat head start. With the check, deliberately rotated downbeats score 85.9% instead of 80.9%,
at a cost of 0.3 points when the tracker was right. See scripts/chord-research/README.md.
"""

from __future__ import annotations

import numpy as np

from harmonia_ml.rhythm import grid

# XHMMDecoder's defaults, which the checks above were measured with.
DIFF_PENALTY = 30.0
BEAT_PENALTIES = (15.0, 45.0, 100.0)
TRACKED_PHASE_PRIOR = 10.0


def beat_frames(n_frames: int, beats, positions, hop: float, downbeats: bool = True) -> np.ndarray:
    """XHMMDecoder's private beat array: 0 = no change allowed, 1 = free, 2..4 = bar position."""
    arr = np.ones((n_frames,), dtype=np.int8)
    valid = [
        (int(np.round(t / hop)), int(p))
        for t, p in zip(beats, positions)
        if 0 <= int(np.round(t / hop)) < n_frames
    ]
    for i in range(len(valid) - 1):
        arr[valid[i][0] + 1 : valid[i + 1][0]] = 0
    if downbeats and valid:
        meter = max(p for _, p in valid)
        arr[np.array([f for f, _ in valid])] = 4
        down = [f for f, p in valid if p == 1]
        if down:
            arr[np.array(down)] = 2
        if meter % 2 == 0:
            middle = [f for f, p in valid if p == meter // 2 + 1]
            if middle:
                arr[np.array(middle)] = 3
    return arr


def viterbi_score(observations: np.ndarray, arr: np.ndarray) -> float:
    """Best-path log score of XHMMDecoder.decode under `arr` (the same recursion, score only)."""
    score = observations[0].copy()
    score[1:] = -np.inf
    for t in range(1, observations.shape[0]):
        if arr[t]:
            penalty = DIFF_PENALTY if arr[t] == 1 else BEAT_PENALTIES[arr[t] - 2]
            score = np.maximum(score, score.max() - penalty) + observations[t]
        else:
            score = score + observations[t]
    return float(score.max())


def choose_rotation(observations, beats, downbeats, hop: float) -> tuple[int, list[float]]:
    """How many beats to move the tracked downbeats so chord changes land on them."""
    mask = grid.downbeat_mask(beats, downbeats)
    meter = grid.meter_of(mask)
    if meter is None:
        return 0, []
    scores: list[float] = []
    for rotation in grid.downbeat_rotations(meter):
        rotated = grid.downbeat_mask(beats, downbeats, rotation)
        positions = grid.beat_positions(rotated, meter or 0)
        arr = beat_frames(observations.shape[0], beats, positions, hop)
        scores.append(viterbi_score(observations, arr) + (TRACKED_PHASE_PRIOR if rotation == 0 else 0))
    return int(np.argmax(scores)) if scores else 0, scores


def frames_to_rows(tags: list[str], hop: float) -> list[tuple[float, float, str]]:
    rows, first = [], 0
    for i, tag in enumerate(tags):
        if i + 1 == len(tags) or tags[i + 1] != tag:
            rows.append((first * hop, (i + 1) * hop, tag))
            first = i + 1
    return rows


def decode(hmm, probabilities, beats, downbeats, hop: float, rotation: int):
    """Layered (triad and bass first, then decorations) beat-synchronous decode."""
    mask = grid.downbeat_mask(beats, downbeats, rotation)
    meter = grid.meter_of(mask)
    positions = grid.beat_positions(mask, meter or 0)
    arr = beat_frames(probabilities[0].shape[0], beats, positions, hop, downbeats=meter is not None)
    return frames_to_rows(hmm.layer_decode(probabilities, arr), hop)
