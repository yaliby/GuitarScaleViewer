"""Follow a chart without timing by ear: where in the chart are the words just heard?

The chart's lyric lines are laid end to end as one run of words. The last few
words the live transcriber heard are slid along it; the chart line holding the
last matched word is the line being sung. Between seeks, only a stretch just
behind and ahead of the previous match is searched, so a repeated chorus or a
line that shares a few words with a later verse cannot pull the highlight away.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from rapidfuzz import fuzz, process

from chordsync.live.transcript import word_key

TAIL_WORDS = 5
MIN_WORDS = 3
_MIN_SCORE = 68.0
_BACK_WORDS = 3
_AHEAD_WORDS = 20


def words_of(text: str | None) -> list[str]:
    return [k for k in (word_key(w) for w in (text or "").split()) if k]


@dataclass(frozen=True, slots=True)
class ChartWords:
    words: tuple[str, ...]
    line_of: tuple[int, ...]  # chart line index of each word

    @classmethod
    def build(cls, lines: Sequence[str]) -> ChartWords:
        words: list[str] = []
        line_of: list[int] = []
        for i, line in enumerate(lines):
            for w in words_of(line):
                words.append(w)
                line_of.append(i)
        return cls(tuple(words), tuple(line_of))


@dataclass(frozen=True, slots=True)
class EarMatch:
    line: int  # chart line being sung
    word: int  # where in the chart's words: the cursor for the next match
    score: float


def follow_by_ear(
    chart: ChartWords,
    heard: Sequence[str],
    *,
    cursor: int | None,
    around: float | None = None,
) -> EarMatch | None:
    """Place the last heard words in the chart.

    ``cursor`` is the previous match; only a short stretch around it is
    searched. ``around`` (0..1, how far into the song) replaces it after a seek
    or when the follower got lost: then the whole chart is searched, nearest
    to that point first.
    """
    n_words = len(chart.words)
    if len(heard) < MIN_WORDS or n_words < MIN_WORDS:
        return None
    tail = list(heard[-TAIL_WORDS:])
    target = " ".join(tail)
    best: tuple[float, float, int] | None = None  # (ranking score, similarity, end word)
    for m in (len(tail) - 1, len(tail), len(tail) + 1):
        if m < 2 or m > n_words:
            continue
        lo, hi = 0, n_words - m
        if cursor is not None and around is None:
            lo = max(0, cursor - _BACK_WORDS - m + 1)
            hi = min(n_words - m, cursor + _AHEAD_WORDS - m + 1)
            if hi < lo:
                continue
        windows = [" ".join(chart.words[j : j + m]) for j in range(lo, hi + 1)]
        row = process.cdist([target], windows, scorer=fuzz.ratio)[0]
        for off, sim in enumerate(row):
            end = lo + off + m - 1
            sim = float(sim)
            if around is not None:
                # After a seek: the copy nearest to where the song is.
                rank = sim - 10.0 * abs(end - around * (n_words - 1)) / n_words
            elif cursor is not None:
                rank = sim - 0.05 * max(0, end - cursor)  # the nearer copy of a repeat
            else:
                rank = sim - 0.02 * end  # first match of the song: an early copy
            if best is None or rank > best[0]:
                best = (rank, sim, end)
    if best is None or best[1] < _MIN_SCORE:
        return None
    return EarMatch(line=chart.line_of[best[2]], word=best[2], score=best[1] / 100.0)
