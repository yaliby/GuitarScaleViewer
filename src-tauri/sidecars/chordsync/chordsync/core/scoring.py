"""Scoring helpers (fuzzy similarity, normalization)."""

from __future__ import annotations

import re
import unicodedata
from typing import Iterable

from rapidfuzz import fuzz


_ZW_RE = re.compile(r"[\u200B-\u200D\uFEFF]")
_SPACE_RE = re.compile(r"\s+")


def normalize_text(text: str) -> str:
    t = unicodedata.normalize("NFKC", text)
    t = _ZW_RE.sub("", t)
    t = t.strip()
    t = _SPACE_RE.sub(" ", t)
    return t


def normalized_ratio(a: str | None, b: str | None) -> float:
    if not a or not b:
        return 0.0
    na = normalize_text(a).casefold()
    nb = normalize_text(b).casefold()
    if not na or not nb:
        return 0.0
    return float(fuzz.WRatio(na, nb)) / 100.0


def token_set_ratio(a: str | None, b: str | None) -> float:
    if not a or not b:
        return 0.0
    na = normalize_text(a).casefold()
    nb = normalize_text(b).casefold()
    return float(fuzz.token_set_ratio(na, nb)) / 100.0


def clamp01(x: float) -> float:
    return 0.0 if x < 0.0 else 1.0 if x > 1.0 else x


def weighted_mean(pairs: Iterable[tuple[float, float]]) -> float:
    num = 0.0
    den = 0.0
    for value, weight in pairs:
        if weight <= 0:
            continue
        num += value * weight
        den += weight
    return (num / den) if den else 0.0

