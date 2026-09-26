"""Validated attack-supported timing refinement for native whole-song regions."""

import numpy as np


def align_boundaries(rows, attacks, observations, names, hop):
    """Relocate nearby uncertain boundaries; preserve labels, order and short regions."""
    if not rows or not len(attacks):
        return list(rows)
    events = np.asarray(attacks, dtype=float)
    if not np.isfinite(events).all() or np.any(np.diff(events) < 0):
        raise ValueError("Attack times must be finite and sorted")
    if not np.isfinite(hop) or hop <= 0:
        raise ValueError("Invalid frame hop")
    state = {name: index for index, name in enumerate(names)}
    cuts = [row[0] for row in rows] + [rows[-1][1]]
    for index in range(1, len(rows)):
        previous, current = rows[index - 1 : index + 1]
        if previous[2] == "N" or current[2] == "N":
            continue
        if previous[2] not in state or current[2] not in state:
            continue
        old = current[0]
        radius = min(0.15, (previous[1] - previous[0]) / 4, (current[1] - current[0]) / 4)
        eligible = events[(events >= old - radius - 1e-9) & (events <= old + radius + 1e-9)]
        if not len(eligible):
            continue
        new = float(eligible[np.argmin(abs(eligible - old))])
        if not previous[0] < new < current[1]:
            continue
        first, last = sorted((int(round(old / hop)), int(round(new / hop))))
        first, last = max(0, first), min(len(observations), last)
        if first >= last:
            continue
        before, after = (previous[2], current[2]) if new < old else (current[2], previous[2])
        lost = observations[first:last, state[before]] - observations[first:last, state[after]]
        if np.isfinite(lost).all() and float(lost.mean()) <= 0.5:
            cuts[index] = new
    return [(cuts[index], cuts[index + 1], row[2]) for index, row in enumerate(rows)]
