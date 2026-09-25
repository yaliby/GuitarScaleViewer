"""Match lyric lines to chart lines (robust, fuzzy, top-to-bottom).

Repeated choruses are the hard case: the same sentence appears several times
on the page. Scores are then tied, so a global argmax always snaps back to the
first copy. Playback that is moving forward must therefore pick the next copy
strictly below the previous highlight.

If the chart does not write that copy again — only a pointer like ``(פזמון)`` —
there is no next copy below, so we recycle to the most recent written copy above.
A high-water mark keeps the furthest line already reached: after a recycle, new
material can only be taken from below that mark, so we do not replay verse two.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from rapidfuzz import fuzz

from chordsync.browser.text_match import norm_text
from chordsync.core.scoring import normalize_text

MatchDirection = Literal["forward", "backward", "seek"]

_TIE_EPS = 0.06
_MIN_KEEP = 0.58
_NEXT_LINE_MIN = 0.70
_POINTER_RE = re.compile(
    r"^[\(\[\{\s]*(?:פזמון|chorus|refrain|hook|וחוזר|חוזר)(?:\s*[x×]\s*\d+)?[\)\]\}\s]*$",
    re.IGNORECASE,
)


@dataclass(frozen=True, slots=True)
class MatchResult:
    best_index: int | None
    best_score: float
    alternatives: tuple[tuple[int, float], ...]
    reason: str


def _norm(s: str) -> str:
    # Halturaz-style: NFKC + drop geresh/apostrophes so Hebrew lyrics match
    # chord-page lines that spell נצי vs נצ'י.
    return norm_text(s) or normalize_text(s).casefold()


def is_refrain_pointer(s: str | None) -> bool:
    """True when the chart line is a shorthand pointer, not sung lyrics."""
    t = re.sub(r"[:：]\s*$", "", (s or "").strip()).strip()
    if not t or len(t) > 24:
        return False
    return bool(_POINTER_RE.match(t))


def _score_one(nl: str, nd: str, *, prev_n: str | None, next_n: str | None, prev_dom: str, next_dom: str) -> float:
    s_main = fuzz.WRatio(nl, nd) / 100.0
    s_tok = fuzz.token_set_ratio(nl, nd) / 100.0
    s_part = fuzz.partial_ratio(nl, nd) / 100.0
    score = (0.50 * s_main) + (0.35 * s_tok) + (0.15 * s_part)
    if nl and nd and (nl in nd or nd in nl):
        score += 0.10

    len_ratio = min(len(nd), len(nl)) / max(1, max(len(nd), len(nl)))
    if len_ratio < 0.45:
        score -= 0.10
    if len(nd) < 8:
        score -= 0.08

    if prev_n:
        score += 0.06 * (fuzz.token_set_ratio(prev_n, prev_dom) / 100.0)
    if next_n:
        score += 0.06 * (fuzz.token_set_ratio(next_n, next_dom) / 100.0)
    return max(0.0, min(1.0, score))


def _good_copies(scored: list[tuple[int, float]]) -> list[tuple[int, float]]:
    best_s = max(s for _, s in scored)
    floor = max(_MIN_KEEP, best_s - _TIE_EPS)
    return [(i, s) for i, s in scored if s >= floor]


def _seek_target(*, lrc_index: int | None, lrc_count: int | None, n_chart: int, last_best_index: int | None) -> int:
    if lrc_index is not None and lrc_count and lrc_count > 1 and n_chart > 1:
        frac = max(0, min(int(lrc_index), lrc_count - 1)) / (lrc_count - 1)
        return int(round(frac * (n_chart - 1)))
    if last_best_index is not None:
        return last_best_index
    return 0


def _pick(
    scored: list[tuple[int, float]],
    *,
    direction: MatchDirection,
    last_best_index: int | None,
    high_water_index: int | None,
    lrc_index: int | None,
    lrc_count: int | None,
    pointer_indexes: set[int],
) -> tuple[int, float, str]:
    by_i = {i: s for i, s in scored}
    copies = [(i, s) for i, s in _good_copies(scored) if i not in pointer_indexes]
    if not copies:
        copies = _good_copies(scored)
    # Nothing on the page may be close (a misheard phrase, an intro): then the
    # best weak line goes back and the caller judges it by its score.
    weak = max(scored, key=lambda t: (t[1], -t[0]))
    n_chart = max(i for i, _ in scored) + 1
    in_replay = (
        last_best_index is not None
        and high_water_index is not None
        and last_best_index < high_water_index
    )

    if direction == "seek":
        target = _seek_target(
            lrc_index=lrc_index,
            lrc_count=lrc_count,
            n_chart=n_chart,
            last_best_index=last_best_index,
        )
        if not copies:
            return weak[0], weak[1], "seek_weak"
        i, s = min(copies, key=lambda t: (abs(t[0] - target), t[0]))
        return i, s, "seek"

    if direction == "backward":
        ceil = (last_best_index - 1) if last_best_index is not None else n_chart
        behind = [(i, s) for i, s in copies if i <= ceil]
        if behind:
            i, s = max(behind, key=lambda t: t[0])
            return i, s, "backward_prev"
        if last_best_index is not None and last_best_index in by_i:
            return last_best_index, by_i[last_best_index], "stay_last"
        if not copies:
            return weak[0], weak[1], "weak"
        i, s = min(copies, key=lambda t: t[0])
        return i, s, "first"

    # Forward: walk a recycled block only below the high-water mark; new
    # material starts strictly after the furthest line already reached.
    floor = (last_best_index + 1) if last_best_index is not None else 0
    progress_floor = (high_water_index + 1) if in_replay else floor
    if last_best_index is not None:
        nxt = last_best_index + 1
        nxt_s = by_i.get(nxt)
        sticky_ok = (not in_replay) or (high_water_index is not None and nxt < high_water_index)
        ahead_best = max(
            (s for i, s in scored if i >= progress_floor and i not in pointer_indexes),
            default=0.0,
        )
        if (
            sticky_ok
            and nxt_s is not None
            and nxt not in pointer_indexes
            and nxt_s >= _NEXT_LINE_MIN
            and nxt_s >= ahead_best - 0.15
        ):
            return nxt, nxt_s, "forward_next_line"

    ahead = [(i, s) for i, s in copies if i >= progress_floor]
    if ahead:
        i, s = min(ahead, key=lambda t: t[0])
        return i, s, "forward_next" if last_best_index is not None else "first"

    behind = [(i, s) for i, s in copies if i < progress_floor]
    if behind:
        i, s = max(behind, key=lambda t: t[0])
        return i, s, "recycle_prev"

    if last_best_index is not None and last_best_index in by_i:
        return last_best_index, by_i[last_best_index], "stay_last"

    weak_ahead = [(i, s) for i, s in scored if i >= progress_floor and i not in pointer_indexes]
    if weak_ahead:
        i, s = max(weak_ahead, key=lambda t: (t[1], -t[0]))
        return i, s, "forward_weak"

    if not copies:
        return weak[0], weak[1], "weak"
    i, s = min(copies, key=lambda t: t[0])
    return i, s, "first"


def match_line(
    *,
    lyric: str,
    dom_lines: list[str],
    prev: str | None = None,
    next: str | None = None,
    last_best_index: int | None = None,
    high_water_index: int | None = None,
    direction: MatchDirection = "forward",
    lrc_index: int | None = None,
    lrc_count: int | None = None,
) -> MatchResult:
    if not lyric or not dom_lines:
        return MatchResult(best_index=None, best_score=0.0, alternatives=(), reason="empty")

    nl = _norm(lyric)
    if not nl or all(ch in "♪♫ " for ch in nl):
        return MatchResult(best_index=None, best_score=0.0, alternatives=(), reason="empty")
    np = _norm(prev) if prev else None
    nn = _norm(next) if next else None
    norms = [_norm(dl) for dl in dom_lines]

    scored: list[tuple[int, float]] = []
    for i, nd in enumerate(norms):
        if not nd:
            continue
        prev_dom = norms[i - 1] if i > 0 else ""
        next_dom = norms[i + 1] if i + 1 < len(norms) else ""
        score = _score_one(nl, nd, prev_n=np, next_n=nn, prev_dom=prev_dom, next_dom=next_dom)
        scored.append((i, float(score)))

    if not scored:
        return MatchResult(best_index=None, best_score=0.0, alternatives=(), reason="no_scored")

    pointer_indexes = {i for i, raw in enumerate(dom_lines) if is_refrain_pointer(raw)}
    best_i, best_s, reason = _pick(
        scored,
        direction=direction,
        last_best_index=last_best_index,
        high_water_index=high_water_index,
        lrc_index=lrc_index,
        lrc_count=lrc_count,
        pointer_indexes=pointer_indexes,
    )
    alts = tuple(sorted(scored, key=lambda t: t[1], reverse=True)[:5])
    return MatchResult(best_index=best_i, best_score=best_s, alternatives=alts, reason=reason)
