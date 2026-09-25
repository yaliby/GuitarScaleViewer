"""Normalize now-playing metadata into a canonical track identity."""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass, replace

from chordsync.core.models import CanonicalTrack, NowPlayingSnapshot, TrackLanguageGuess
from chordsync.core.resolution_models import NormalizationOutcome
from chordsync.core.scoring import normalize_text, weighted_mean
from chordsync.normalize.album_rules import normalize_album
from chordsync.normalize.dbus_text import strip_dbus_variant_text
from chordsync.normalize.heuristics import detect_variant_flags
from chordsync.normalize.language_guess import infer_track_language_guess
from chordsync.resolution.identity import identity_candidates, names_align
from chordsync.sync.lrc_offset import is_video_like_source


_ZW_RE = re.compile(r"[​-‍‎‏‪-‮﻿]")

# How much each identity reading can be trusted before any lookup confirms it.
_LABEL_CONFIDENCE = {
    "metadata": 0.92,
    "title_split": 0.85,
    "title_split_reversed": 0.85,
    "artist_prefix_stripped": 0.82,
    "channel_artist": 0.7,
    "title_split_swapped": 0.45,
    "title_only": 0.4,
}


def _clean(s: str | None) -> str:
    if not s:
        return ""
    t = strip_dbus_variant_text(s)
    if not t:
        return ""
    t = unicodedata.normalize("NFKC", t)
    t = _ZW_RE.sub("", t)
    t = normalize_text(t)
    return t


def _names_align(part: str, artist: str) -> bool:
    """Kept for callers of the old private helper."""
    return names_align(part, artist)


@dataclass(slots=True)
class MetadataNormalizer:
    def normalize_enriched(self, snap: NowPlayingSnapshot) -> NormalizationOutcome | None:
        """Same as `normalize` but wrapped in `NormalizationOutcome` for the chord-resolution pipeline."""
        t = self.normalize(snap)
        if t is None:
            return None
        return NormalizationOutcome(
            track=t,
            language_guess=t.language_guess or TrackLanguageGuess.UNKNOWN,
            identity_alternatives=t.identity_alternatives,
            normalization_confidence=t.confidence,
            normalization_notes=t.normalization_notes,
        )

    def normalize(self, snap: NowPlayingSnapshot) -> CanonicalTrack | None:
        raw_title = _clean(snap.track_title_raw)
        raw_artist = _clean(snap.artist_raw)
        raw_album = _clean(snap.album_raw)
        if not raw_title:
            return None

        raw = snap.raw if isinstance(snap.raw, Mapping) else {}
        candidates = identity_candidates(
            raw_title,
            raw_artist,
            album_raw=raw_album or None,
            video_source=is_video_like_source(snap.app_name),
            url=str(raw.get("url") or ""),
        )
        if not candidates:
            return None
        primary = candidates[0]

        notes: list[str] = [f"identity={primary.label}", *primary.notes]
        if not raw_artist and primary.search_artist:
            notes.append("inferred_artist_from_title")
        if not primary.search_artist:
            notes.append("title_only_identity")
        # Channel names ("Karaoke Hits", "Acoustic Covers") are not the song: flags come from title/album.
        flags = detect_variant_flags(raw_title, raw_album)

        canon_album = None
        if raw_album:
            a, album_notes = normalize_album(raw_album)
            notes.extend(album_notes)
            canon_album = _clean(a) or None

        label_conf = _LABEL_CONFIDENCE.get(primary.label, 0.6)
        conf = weighted_mean([(label_conf, 0.85), (float(snap.confidence), 0.15)])

        base = CanonicalTrack(
            canonical_title=primary.search_title,
            canonical_artist=primary.search_artist,
            canonical_album=canon_album,
            search_title=primary.search_title,
            search_artist=primary.search_artist,
            search_album=canon_album,
            variant_flags=frozenset(flags),
            normalization_notes=tuple(notes),
            confidence=float(conf),
            source_snapshot=snap,
        )
        lg = infer_track_language_guess(base)
        return replace(
            base,
            language_guess=lg,
            identity_alternatives=tuple(candidates[1:]),
        )
