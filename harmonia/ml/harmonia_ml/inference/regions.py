"""Conservative offline decoration/bass persistence using original model evidence."""

from __future__ import annotations

import numpy as np


def component_values(probability, head, chord, first, last):
    if head == 1:
        return probability[first:last, chord[head] + 1]
    if probability.ndim == 3:
        return probability[first:last, (chord[0] - 1) % 12, chord[head]]
    return probability[first:last, chord[head]]


def refine_regions(rows, probabilities, beats, hop_seconds, encode):
    """Resolve only weak A-B-A decorations corroborated by containing-beat evidence.

    This neither deletes arbitrary short chords nor snaps harmonic boundaries.
    No beat support means no additional consolidation beyond the original HMM.
    """
    beat_times = np.asarray(beats, dtype=float)
    if len(beat_times) < 2:
        return list(rows), 0
    if not np.isfinite(beat_times).all() or (np.diff(beat_times) <= 0).any():
        raise ValueError("Beat evidence must be finite and strictly increasing")

    def values(head, chord, first, last):
        return component_values(probabilities[head], head, chord, first, last)

    def bounds(start, end):
        first = max(0, int(round(start / hop_seconds)))
        last = min(len(probabilities[0]), int(round(end / hop_seconds)))
        return first, max(first + 1, last)

    output, collapsed, index = [], 0, 0
    while index < len(rows):
        if index + 2 >= len(rows):
            output.extend(rows[index:])
            break
        a, b, c = rows[index : index + 3]
        ca, cb = np.asarray(encode(a[2]), dtype=int), np.asarray(encode(b[2]), dtype=int)
        beat = int(np.searchsorted(beat_times, b[0], side="right") - 1)
        eligible = (
            a[2] == c[2]
            and a[2] != b[2]
            and ca[0] == cb[0]
            and ca[0] > 0
            and 0 <= beat < len(beat_times) - 1
        )
        if eligible:
            beat_start, beat_end = beat_times[beat : beat + 2]
            eligible = b[1] <= beat_end + 1e-9 and b[1] - b[0] <= min(
                0.25, (beat_end - beat_start) / 2
            )
        changed = [h for h in range(1, 6) if ca[h] != cb[h]]
        eligible = eligible and bool(changed) and all(ca[h] >= 0 and cb[h] >= 0 for h in changed)
        if eligible:
            first, last = bounds(b[0], b[1])
            beat_first, beat_last = bounds(beat_start, beat_end)
            region_first, region_last = bounds(a[0], c[1])
            log_evidence = 0.0
            for head in changed:
                selected = values(head, cb, first, last).mean()
                prior = values(head, ca, first, last).mean()
                beat_prior = values(head, ca, beat_first, beat_last).mean()
                beat_selected = values(head, cb, beat_first, beat_last).mean()
                if selected >= 0.65 or selected - prior >= 0.10 or beat_prior <= beat_selected:
                    eligible = False
                    break
                log_evidence += float(
                    np.log(np.clip(values(head, ca, region_first, region_last), 1e-12, 1)).sum()
                    - np.log(np.clip(values(head, cb, region_first, region_last), 1e-12, 1)).sum()
                )
            eligible = eligible and log_evidence > 0
        if eligible:
            output.append((a[0], c[1], a[2]))
            collapsed += 1
            index += 3
        else:
            output.append(a)
            index += 1
    return output, collapsed
