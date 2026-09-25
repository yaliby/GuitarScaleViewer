"""Song resolution pipeline: representations, query planning, page verification."""

from chordsync.resolution.page_verifier import verify_chord_page, verify_chord_page_html
from chordsync.resolution.query_planner import plan_chord_queries
from chordsync.resolution.representations import build_song_search_representations

__all__ = [
    "build_song_search_representations",
    "plan_chord_queries",
    "verify_chord_page",
    "verify_chord_page_html",
]
