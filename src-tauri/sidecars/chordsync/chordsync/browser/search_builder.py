"""Build chord-search queries from canonical tracks (planner-first; not a single naive query)."""

from __future__ import annotations

from chordsync.core.models import CanonicalTrack
from chordsync.resolution.query_planner import plan_chord_queries
from chordsync.resolution.representations import build_song_search_representations


def build_queries(
    track: CanonicalTrack,
    *,
    preferred_language: str | None,
    enable_hebrew: bool,
    translation_used_for_search: bool = False,
) -> list[str]:
    """Return ordered query strings (families A–F, safest first)."""
    reps = build_song_search_representations(track, translation_used_for_search=translation_used_for_search)
    return [q.text for q in plan_chord_queries(track, reps, preferred_language=preferred_language, enable_hebrew=enable_hebrew)]
