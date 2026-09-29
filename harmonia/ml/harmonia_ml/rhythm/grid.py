"""The beat grid a whole-song analysis is read against: tempo, meter, bar positions.

Everything here is derived from beat and downbeat times alone, so it holds for any tracker.
"""

from __future__ import annotations

import math

import numpy as np

# A song whose local tempo stays inside this band around the global one reads as steady.
STEADY_TEMPO_BAND = 0.05
# Local tempo is read over this many beats, every half of it.
LOCAL_WINDOW_BEATS = 16
# Beats closer than this to a downbeat time are that downbeat (the tracker snaps them already).
DOWNBEAT_SNAP_SECONDS = 0.035


def _finite_sorted(values) -> np.ndarray:
    array = np.asarray(values, dtype=float).reshape(-1)
    if array.size and (not np.isfinite(array).all() or (np.diff(array) <= 0).any()):
        raise ValueError("Beat times must be finite and strictly increasing")
    return array


def tempo(beats) -> tuple[float | None, bool]:
    """Global tempo in BPM, and whether the song holds it.

    The median inter-beat interval names the pulse; intervals within 12% of it are the beats that
    were tracked through (a gap or a doubled beat is not), and their mean is the tempo. Averaging
    over the whole song gets well under the tracker's 20 ms frame, which one interval cannot.
    """
    beats = _finite_sorted(beats)
    if len(beats) < 5:
        return None, False
    intervals = np.diff(beats)
    median = float(np.median(intervals))
    if median <= 0:
        return None, False
    kept = intervals[np.abs(intervals - median) <= 0.12 * median]
    if len(kept) < 4:
        return None, False
    bpm = 60.0 / float(kept.mean())
    local = local_tempi(intervals)
    if len(local) < 3:
        return bpm, True
    # The tracker may count a section at double (or half) the tempo; that is not the song
    # speeding up, so each local reading is folded into the global tempo's octave first.
    folded = local * 2.0 ** np.round(np.log2(bpm / local))
    low, high = np.percentile(folded, [10, 90])
    steady = bool(low >= bpm * (1 - STEADY_TEMPO_BAND) and high <= bpm * (1 + STEADY_TEMPO_BAND))
    return bpm, steady


def local_tempi(intervals: np.ndarray) -> np.ndarray:
    """Tempo over each sixteen-beat window whose beats were tracked evenly (no gaps, no doubles)."""
    size = LOCAL_WINDOW_BEATS
    out = []
    for i in range(0, len(intervals) - size + 1, size // 2):
        window = intervals[i : i + size]
        median = float(np.median(window))
        regular = np.abs(window - median) <= 0.1 * median
        if median > 0 and regular.mean() >= 0.75:
            out.append(60.0 / float(window[regular].mean()))
    return np.asarray(out, dtype=float)


def downbeat_mask(beats, downbeats, rotation: int = 0) -> np.ndarray:
    """Which beats are downbeats, each tracked downbeat moved `rotation` beats later."""
    beats = _finite_sorted(beats)
    mask = np.zeros(len(beats), dtype=bool)
    if not len(beats):
        return mask
    for time in np.asarray(downbeats, dtype=float).reshape(-1):
        index = int(np.argmin(np.abs(beats - time)))
        if abs(beats[index] - time) > DOWNBEAT_SNAP_SECONDS:
            continue
        index += rotation
        if 0 <= index < len(beats):
            mask[index] = True
    return mask


def meter_of(mask: np.ndarray) -> int | None:
    """Beats per bar: the commonest distance between consecutive downbeats, 2..7."""
    downs = np.flatnonzero(mask)
    if len(downs) < 3:
        return None
    bars = np.diff(downs)
    bars = bars[(bars >= 2) & (bars <= 7)]
    if not len(bars):
        return None
    return int(np.bincount(bars).argmax())


def beat_positions(mask: np.ndarray, meter: int) -> list[int]:
    """Position in the bar for every beat, 1 = downbeat; a pickup counts up into the first bar."""
    downs = np.flatnonzero(mask)
    if not len(downs) or meter < 2:
        return [0] * len(mask)
    count = meter - int(downs[0]) % meter
    out = []
    for is_down in mask:
        count = 1 if is_down else count + 1
        out.append(int(min(max(count, 1), meter)))
    return out


def downbeat_rotations(meter: int | None) -> range:
    return range(meter if meter and meter >= 2 else 1)


def summarize(beats, downbeats, rotation: int = 0) -> dict:
    """Tempo, meter and downbeats (after any rotation) for the analysis payload."""
    beats = _finite_sorted(beats)
    bpm, steady = tempo(beats)
    mask = downbeat_mask(beats, downbeats, rotation)
    meter = meter_of(mask)
    return {
        "tempo": bpm if bpm is not None and math.isfinite(bpm) else None,
        "tempoSteady": steady,
        "meter": meter,
        "downbeats": [float(t) for t in beats[mask]] if meter else [],
    }
