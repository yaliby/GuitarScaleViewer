"""Album normalization rules."""

from __future__ import annotations

import re


_EDITION_RE = re.compile(r"\b(deluxe|expanded|remaster(?:ed)?|anniversary)\b", flags=re.IGNORECASE)


def normalize_album(album: str) -> tuple[str, list[str]]:
    notes: list[str] = []
    a = album.strip()
    if _EDITION_RE.search(a):
        # keep edition info; it's meaningful for some matches
        notes.append("kept_album_edition_hint")
    return a, notes

