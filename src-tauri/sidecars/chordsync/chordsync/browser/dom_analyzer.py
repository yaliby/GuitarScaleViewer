"""DOM analysis helpers for chord/lyric pages.

We receive a JSON snapshot (from JS) of many visible blocks. We filter and
normalize into a stable list of candidate lines for matching.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from chordsync.core.scoring import normalize_text


@dataclass(frozen=True, slots=True)
class DomTextLine:
    text: str
    normalized: str
    chordiness: float
    tag: str | None


def parse_dom_snapshot(json_payload: str) -> list[DomTextLine]:
    try:
        raw = json.loads(json_payload or "[]")
    except Exception:
        return []
    if not isinstance(raw, list):
        return []

    out: list[DomTextLine] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        if len(text) > 500:
            continue
        chordiness = float(item.get("chordiness") or 0.0)
        tag = item.get("tag")
        norm = normalize_text(text).casefold()
        out.append(DomTextLine(text=text, normalized=norm, chordiness=chordiness, tag=str(tag) if tag else None))

    # Important: keep DOM order as received. Order provides locality and makes
    # context-window matching + scrolling more stable.
    return out


def best_line_texts(lines: list[DomTextLine], *, limit: int = 300) -> list[str]:
    out: list[str] = []
    for ln in lines:
        if not ln.normalized:
            continue
        out.append(ln.text)
        if len(out) >= limit:
            break
    return out

