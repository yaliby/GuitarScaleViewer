"""Core typed models used across the application.

All modules should depend on these types rather than importing UI or provider
implementations. Keep this file import-safe (no heavy/optional deps).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Mapping, NewType, Sequence


class TrackLanguageGuess(str, Enum):
    """Inferred script/language mix for search (not a legal claim about the recording)."""

    HEBREW = "hebrew"
    EN_LATIN = "en_latin"
    MIXED = "mixed"
    UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class IdentityCandidate:
    """Alternate search identity (e.g. swapped order). Not a second canonical truth."""

    label: str
    search_title: str
    search_artist: str
    search_album: str | None = None
    notes: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class PlannedChordQuery:
    """One DDG query with planner family tag."""

    text: str
    family: str
    priority: int


UrlStr = NewType("UrlStr", str)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class Platform(str, Enum):
    WINDOWS = "windows"
    LINUX = "linux"
    MACOS = "macos"
    ANDROID = "android"
    IOS = "ios"
    GENERIC_REMOTE = "generic_remote"
    UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class NowPlayingSnapshot:
    """Unified now-playing snapshot emitted by any metadata provider."""

    source_provider: str
    device_id: str
    platform: Platform
    app_name: str | None

    track_title_raw: str | None
    artist_raw: str | None
    album_raw: str | None

    duration_ms: int | None
    position_ms: int | None
    is_playing: bool | None

    artwork_url: UrlStr | None

    timestamp_utc: datetime = field(default_factory=utc_now)
    confidence: float = 0.0  # provider's self-confidence 0..1

    raw: Mapping[str, Any] = field(default_factory=dict)  # provider-specific payload


@dataclass(frozen=True, slots=True)
class CanonicalTrack:
    """Normalized, canonical identity used for lyrics and search."""

    canonical_title: str
    canonical_artist: str
    canonical_album: str | None

    search_title: str
    search_artist: str
    search_album: str | None

    variant_flags: frozenset[str] = field(default_factory=frozenset)
    normalization_notes: tuple[str, ...] = field(default_factory=tuple)
    confidence: float = 0.0  # 0..1

    source_snapshot: NowPlayingSnapshot | None = None

    # Chord resolution: optional enriched identity (filled by MetadataNormalizer.normalize_enriched).
    language_guess: TrackLanguageGuess | None = None
    identity_alternatives: tuple[IdentityCandidate, ...] = field(default_factory=tuple)


@dataclass(frozen=True, slots=True)
class LyricsQuery:
    track: str
    artist: str
    album: str | None = None
    duration_ms: int | None = None

    # Free-form query used by search endpoints when exact is missing
    query_text: str | None = None


@dataclass(frozen=True, slots=True)
class LyricsRecord:
    """Resolved lyrics result (plain and/or synced)."""

    provider: str  # e.g. "lrclib"
    track: str | None
    artist: str | None
    album: str | None
    duration_ms: int | None

    plain_lyrics: str | None
    synced_lyrics_lrc: str | None

    source_url: UrlStr | None
    fetched_at_utc: datetime = field(default_factory=utc_now)

    # Diagnostics
    match_confidence: float = 0.0
    match_notes: tuple[str, ...] = field(default_factory=tuple)
    raw: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class TimedLyricLine:
    time_ms: int
    raw_text: str
    normalized_text: str
    line_index: int


@dataclass(frozen=True, slots=True)
class SearchCandidate:
    url: UrlStr
    title: str | None = None
    snippet: str | None = None
    source: str | None = None  # search engine identifier
    raw: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class DomLineCandidate:
    """A candidate line extracted from the chords page DOM."""

    text: str
    normalized_text: str
    dom_path: str | None  # stable-ish semantic selector/path produced by JS
    container_fingerprint: str | None
    line_fingerprint: str | None
    bbox: tuple[float, float, float, float] | None  # x,y,w,h in CSS px
    raw: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ScrollTarget:
    """Instruction to scroll to a given DOM line or y-offset."""

    dom_path: str | None
    y_offset: float | None
    center_in_viewport: bool = True
    reason: str | None = None


@dataclass(frozen=True, slots=True)
class SyncState:
    """High-level sync state for UI + debugging."""

    snapshot: NowPlayingSnapshot | None
    track: CanonicalTrack | None
    lyrics: LyricsRecord | None
    timed_lines: Sequence[TimedLyricLine] = field(default_factory=tuple)

    current_line_index: int | None = None
    current_line_text: str | None = None
    dom_target: DomLineCandidate | None = None

    confidence_metadata: float = 0.0
    confidence_lyrics: float = 0.0
    confidence_dom: float = 0.0
    confidence_alignment: float = 0.0
    confidence_total: float = 0.0

    notes: tuple[str, ...] = field(default_factory=tuple)


class EventType(str, Enum):
    NOW_PLAYING = "now_playing"
    TRACK_CHANGED = "track_changed"
    LYRICS_UPDATED = "lyrics_updated"
    DOM_UPDATED = "dom_updated"
    SYNC_STATE = "sync_state"


@dataclass(frozen=True, slots=True)
class Event:
    type: EventType
    timestamp_utc: datetime = field(default_factory=utc_now)
    payload: Mapping[str, Any] = field(default_factory=dict)

