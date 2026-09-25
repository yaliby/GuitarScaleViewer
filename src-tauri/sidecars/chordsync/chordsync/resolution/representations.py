"""Build multiple search representations (original first; transliteration/translation as hints only)."""

from __future__ import annotations

from chordsync.core.models import CanonicalTrack
from chordsync.core.resolution_models import SongSearchRepresentations


def build_song_search_representations(
    track: CanonicalTrack,
    *,
    translation_used_for_search: bool = False,
) -> SongSearchRepresentations:
    """
    Song titles are proper names — we never treat MT as canonical identity.
    `translation_used_for_search` is recorded when LibreTranslate filled Latin→Hebrew fields.
    """
    notes: list[str] = []
    if translation_used_for_search:
        notes.append("libretranslate_applied_to_search_fields")

    # Transliteration slots reserved for future explicit Latin/Hebrew pairs from metadata (no blind MT).
    return SongSearchRepresentations(
        primary_title=track.search_title,
        primary_artist=track.search_artist,
        primary_album=track.search_album,
        transliterated_title=None,
        transliterated_artist=None,
        translation_used_for_search=translation_used_for_search,
        notes=tuple(notes),
    )
