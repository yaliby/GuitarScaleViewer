"""Infer likely script/language mix from normalized search fields."""

from __future__ import annotations

from chordsync.browser.trusted_sources import text_has_hebrew_script
from chordsync.core.models import CanonicalTrack, TrackLanguageGuess


def infer_track_language_guess(track: CanonicalTrack) -> TrackLanguageGuess:
    t = (track.search_title or "").strip()
    a = (track.search_artist or "").strip()
    h_t = text_has_hebrew_script(t)
    h_a = text_has_hebrew_script(a)
    if h_t and h_a:
        return TrackLanguageGuess.HEBREW
    if h_t or h_a:
        return TrackLanguageGuess.MIXED
    if t or a:
        return TrackLanguageGuess.EN_LATIN
    return TrackLanguageGuess.UNKNOWN
