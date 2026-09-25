"""Align chord columns onto a lyric line — Halturaz `src/lib/chordAlign.js`."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ChartSeg:
    """One fragment: optional chord stacked over optional lyric text."""

    t: str | None = None
    c: str | None = None


def _snap_to_word(text: str, index: int) -> int:
    if index <= 0 or index >= len(text) or text[index] == " ":
        return index
    before = text.rfind(" ", 0, index)
    return 0 if before == -1 else before


def align_by_columns(
    chords: list[dict[str, object]],
    chord_len: int,
    lyric: str,
    *,
    rescale: bool = True,
) -> list[ChartSeg] | None:
    """Split lyrics under chord column starts.

    `rescale` stretches chord columns onto the lyric length when the two rows
    were not typed on one grid. Tab4U shares a monospace grid — pass False.
    """
    if not chords:
        stripped = lyric.strip()
        return [ChartSeg(t=lyric)] if stripped else None
    if not lyric.strip():
        return [ChartSeg(c=str(ch.get("c") or "")) for ch in chords]

    length = max(int(chord_len), 1)

    def column(start: int) -> int:
        if rescale:
            return int(round((start / length) * len(lyric)))
        return int(start)

    bounds: list[int] = []
    for ch in chords:
        raw = column(int(ch.get("start") or 0))
        at = _snap_to_word(lyric, raw)
        prev = bounds[-1] if bounds else None
        collapsed = prev is not None and at <= prev
        if collapsed:
            bounds.append(min(max(raw, (prev or 0) + 1), len(lyric)))
        else:
            bounds.append(at)
    bounds.append(len(lyric))

    segs: list[ChartSeg] = []
    for i, ch in enumerate(chords):
        text = lyric[bounds[i] : bounds[i + 1]]
        name = str(ch.get("c") or "")
        segs.append(ChartSeg(c=name, t=text) if text else ChartSeg(c=name))

    lead = lyric[: bounds[0]]
    if lead:
        return [ChartSeg(t=lead), *segs]
    return segs
