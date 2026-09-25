"""Artist normalization rules."""

from __future__ import annotations

import re


_SPLIT_RE = re.compile(r"\s*(?:,|&|\band\b|\+|/|;)\s*", flags=re.IGNORECASE)
_FEAT_IN_ARTIST_RE = re.compile(r"\b(feat\.?|ft\.?|featuring)\b", flags=re.IGNORECASE)
_YOUTUBE_CHANNEL_NOISE_RE = re.compile(
    r"(?:\s*[-–—]\s*(?:topic|vevo)\s*$)|(?:vevo\s*$)|(?:\s*\((?:official\s+)?(?:artist\s+)?channel\)\s*$)",
    flags=re.IGNORECASE,
)


def split_artists(artist_raw: str) -> list[str]:
    a = artist_raw.strip()
    a = _YOUTUBE_CHANNEL_NOISE_RE.sub("", a).strip()
    a = _FEAT_IN_ARTIST_RE.split(a)[0].strip()
    parts = [p.strip() for p in _SPLIT_RE.split(a) if p.strip()]
    # keep order, dedupe
    seen: set[str] = set()
    out: list[str] = []
    for p in parts:
        key = p.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(p)
    return out or ([a] if a else [])


def canonical_artist_name(artists: list[str]) -> str:
    return ", ".join(artists[:2]) if artists else ""

