"""Heuristics for dirty metadata normalization."""

from __future__ import annotations

import re


_COVER_RE = re.compile(r"\bcover\b", flags=re.IGNORECASE)
_KARAOKE_RE = re.compile(r"\bkaraoke\b", flags=re.IGNORECASE)
_INSTRUMENTAL_RE = re.compile(r"\binstrumental\b", flags=re.IGNORECASE)
_ACOUSTIC_RE = re.compile(r"\bacoustic\b", flags=re.IGNORECASE)
_LIVE_RE = re.compile(r"\blive\b", flags=re.IGNORECASE)
_TUTORIAL_RE = re.compile(r"\btutorial\b|\blesson\b", flags=re.IGNORECASE)
_VISUALIZER_RE = re.compile(r"\bvisualizer\b", flags=re.IGNORECASE)


def detect_variant_flags(*texts: str) -> set[str]:
    flags: set[str] = set()
    joined = " | ".join([t for t in texts if t]).strip()
    if not joined:
        return flags
    if _COVER_RE.search(joined):
        flags.add("cover")
    if _KARAOKE_RE.search(joined):
        flags.add("karaoke")
    if _INSTRUMENTAL_RE.search(joined):
        flags.add("instrumental")
    if _ACOUSTIC_RE.search(joined):
        flags.add("acoustic")
    if _LIVE_RE.search(joined):
        flags.add("live")
    if _TUTORIAL_RE.search(joined):
        flags.add("tutorial")
    if _VISUALIZER_RE.search(joined):
        flags.add("visualizer")
    return flags

