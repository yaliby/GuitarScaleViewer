"""Song → chord page resolution: report types and helpers (core models live in models.py)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from chordsync.core.models import (
    CanonicalTrack,
    IdentityCandidate,
    NowPlayingSnapshot,
    PlannedChordQuery,
    TrackLanguageGuess,
    UrlStr,
)


@dataclass(frozen=True, slots=True)
class SongSearchRepresentations:
    """Multiple string forms for the same song (never replace canonical identity)."""

    primary_title: str
    primary_artist: str
    primary_album: str | None
    transliterated_title: str | None = None
    transliterated_artist: str | None = None
    translation_used_for_search: bool = False
    notes: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class NormalizationOutcome:
    """Normalization layer output before chord search."""

    track: CanonicalTrack
    language_guess: TrackLanguageGuess
    identity_alternatives: tuple[IdentityCandidate, ...] = ()
    normalization_confidence: float = 0.0
    normalization_notes: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class PageVerificationResult:
    url: UrlStr
    ok: bool
    score: float
    reasons: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class RejectedChordCandidate:
    url: UrlStr
    reason: str
    detail: str | None = None


@dataclass(frozen=True, slots=True)
class ChordResolutionReport:
    """Explainable contract for a full resolution attempt."""

    raw_input: dict[str, Any]
    normalized_primary: dict[str, Any]
    identity_alternatives: tuple[dict[str, Any], ...]
    language_guess: TrackLanguageGuess
    generated_queries: tuple[dict[str, Any], ...]
    candidate_results: tuple[dict[str, Any], ...]
    final_selected_page: dict[str, Any] | None
    confidence: float
    explanation: str
    rejected_results: tuple[dict[str, Any], ...] = ()


def snapshot_to_dict(snap: NowPlayingSnapshot | None) -> dict[str, Any]:
    if snap is None:
        return {}
    return {
        "source_provider": snap.source_provider,
        "track_title_raw": snap.track_title_raw,
        "artist_raw": snap.artist_raw,
        "album_raw": snap.album_raw,
        "duration_ms": snap.duration_ms,
        "app_name": snap.app_name,
        "confidence": snap.confidence,
    }


def track_to_dict(t: CanonicalTrack) -> dict[str, Any]:
    return {
        "canonical_title": t.canonical_title,
        "canonical_artist": t.canonical_artist,
        "canonical_album": t.canonical_album,
        "search_title": t.search_title,
        "search_artist": t.search_artist,
        "search_album": t.search_album,
        "variant_flags": sorted(t.variant_flags),
        "normalization_notes": list(t.normalization_notes),
        "confidence": t.confidence,
        "language_guess": t.language_guess.value if t.language_guess else None,
        "identity_alternatives": [identity_to_dict(x) for x in t.identity_alternatives],
    }


def planned_query_to_dict(q: PlannedChordQuery) -> dict[str, Any]:
    return {"text": q.text, "family": q.family, "priority": q.priority}


def identity_to_dict(c: IdentityCandidate) -> dict[str, Any]:
    return {
        "label": c.label,
        "search_title": c.search_title,
        "search_artist": c.search_artist,
        "search_album": c.search_album,
        "notes": list(c.notes),
    }


def build_chord_resolution_report(track: CanonicalTrack, meta: dict[str, Any]) -> ChordResolutionReport:
    """Assemble the explainable contract from router `meta` + normalized track."""
    snap = track.source_snapshot
    planned = meta.get("planned_queries") or ()
    ver = meta.get("page_verification") or ()
    conf = float(meta.get("score") or 0.0)
    expl = str(meta.get("resolution_explanation") or "")
    chosen: dict[str, Any] | None = None
    if meta.get("chosen_url"):
        chosen = {
            "url": meta.get("chosen_url"),
            "domain": meta.get("chosen_domain"),
            "score": conf,
            "tier": meta.get("tier"),
            "policy": meta.get("policy"),
        }
    rejected: tuple[dict[str, Any], ...] = ()
    if meta.get("error"):
        rejected = ({"reason": "no_results", "detail": meta.get("error")},)

    return ChordResolutionReport(
        raw_input=snapshot_to_dict(snap),
        normalized_primary=track_to_dict(track),
        identity_alternatives=tuple(identity_to_dict(x) for x in track.identity_alternatives),
        language_guess=track.language_guess or TrackLanguageGuess.UNKNOWN,
        generated_queries=tuple(planned) if isinstance(planned, (list, tuple)) else (),
        candidate_results=tuple(ver) if isinstance(ver, (list, tuple)) else (),
        final_selected_page=chosen,
        confidence=conf,
        explanation=expl,
        rejected_results=rejected,
    )
