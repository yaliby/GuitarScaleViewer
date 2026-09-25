"""Trusted chord sources registry.

This is intentionally a whitelist-first approach; it is extensible and does not
hardcode a single fragile source.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from chordsync.core.models import CanonicalTrack

_HEBREW_SCRIPT = re.compile(r"[\u0590-\u05FF]")


def text_has_hebrew_script(s: str | None) -> bool:
    """True if the string contains Hebrew letters (Unicode block)."""
    if not s:
        return False
    return bool(_HEBREW_SCRIPT.search(s))


def track_metadata_suggests_hebrew(track: CanonicalTrack) -> bool:
    """Hebrew title/artist/album → prefer Hebrew chord sites even when preferred_language is not `he`."""
    parts = (
        track.search_title,
        track.search_artist,
        track.canonical_title,
        track.canonical_artist,
        track.search_album or "",
        track.canonical_album or "",
    )
    return any(text_has_hebrew_script(p) for p in parts)


@dataclass(frozen=True, slots=True)
class TrustedSource:
    domain: str
    language: str | None
    trust_score: float  # 0..1
    strategy_id: str
    notes: str | None = None
    lyrics_and_chords_same_page: bool = True
    expected_page_style: str | None = None  # e.g. "song_sheet", "tab_text"


def default_hebrew_trusted_sources() -> list[TrustedSource]:
    """Hebrew chord sites only (Tab4U → Nagnu → Negina). Do not mix with English list."""
    return [
        TrustedSource("tab4u.com", "he", 0.99, "tab4u", "Hebrew: lyrics + chords portal (Tab4U)."),
        TrustedSource("nagnu.co.il", "he", 0.98, "nagnu", "Hebrew: chords + lyrics (נגנו)."),
        TrustedSource("negina.co.il", "he", 0.97, "negina", "Hebrew: Israeli songs chords + lyrics (נגינה)."),
    ]


def default_english_trusted_sources() -> list[TrustedSource]:
    """English/international chord sites only. Do not mix with Hebrew list."""
    return [
        TrustedSource("e-chords.com", "en", 0.99, "e_chords", "Primary source: simple lyrics + chords layout."),
        TrustedSource("ultimate-guitar.com", "en", 0.95, "ultimate_guitar", "Prefer Chords results, de-prioritize Tabs/Pro."),
        TrustedSource("azchords.com", "en", 0.91, "az_chords", "Simple text-centric chord pages."),
        TrustedSource("songselect.ccli.com", "en", 0.86, "songselect", "Strong for worship songs with chords/lyrics."),
        TrustedSource("pjsguitarsongs.com", "en", 0.80, "pjs_guitar_songs", "Smaller catalog; easy-to-play layouts."),
    ]


def is_hebrew_chord_search_mode(
    preferred_language: str | None,
    enable_hebrew: bool,
    *,
    track: CanonicalTrack | None = None,
) -> bool:
    """Hebrew chord mode: explicit `he` locale, or Hebrew script in track metadata (when enable_hebrew)."""
    if not enable_hebrew:
        return False
    pl = (preferred_language or "").strip().lower()
    if pl.startswith("he"):
        return True
    if track is not None and track_metadata_suggests_hebrew(track):
        return True
    return False


def is_hebrew_trusted_chord_domain(netloc: str) -> bool:
    """Netloc from a URL is one of the Hebrew-only trusted chord sites."""
    d = (netloc or "").lower()
    return d.endswith("tab4u.com") or d.endswith("nagnu.co.il") or d.endswith("negina.co.il")


def trusted_sources_for_search(
    preferred_language: str | None,
    enable_hebrew: bool,
    track: CanonicalTrack | None = None,
) -> list[TrustedSource]:
    """Pick exactly one family: Hebrew sources or English sources (never both)."""
    if is_hebrew_chord_search_mode(preferred_language, enable_hebrew, track=track):
        return default_hebrew_trusted_sources()
    return default_english_trusted_sources()


def trusted_domain_weight(domain: str, sources: list[TrustedSource]) -> float:
    d = (domain or "").lower()
    for s in sources:
        if d == s.domain.lower() or d.endswith("." + s.domain.lower()):
            return float(s.trust_score)
    return 0.2


def trusted_source_priority(domain: str, sources: list[TrustedSource]) -> int | None:
    """Return source priority index (lower is better) or None if untrusted."""
    d = (domain or "").lower()
    for idx, s in enumerate(sources):
        sd = s.domain.lower()
        if d == sd or d.endswith("." + sd):
            return idx
    return None

