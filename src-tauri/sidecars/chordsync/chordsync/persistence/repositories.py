"""Repositories for persistence and caching."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone

from chordsync.core.models import CanonicalTrack, LyricsRecord


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _stable_key(parts: list[str]) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update(p.encode("utf-8", errors="ignore"))
        h.update(b"\x1f")
    return h.hexdigest()


@dataclass(slots=True)
class LyricsCacheRepository:
    conn: sqlite3.Connection

    def make_cache_key(
        self, *, provider: str, track: str | None, artist: str | None, album: str | None, duration_ms: int | None
    ) -> str:
        return _stable_key(
            [
                provider,
                (track or "").strip().casefold(),
                (artist or "").strip().casefold(),
                (album or "").strip().casefold(),
                str(duration_ms or ""),
            ]
        )

    def get(self, cache_key: str) -> LyricsRecord | None:
        row = self.conn.execute("SELECT * FROM lyrics_cache WHERE cache_key = ?", (cache_key,)).fetchone()
        if not row:
            return None
        return LyricsRecord(
            provider=row["provider"],
            track=row["track"],
            artist=row["artist"],
            album=row["album"],
            duration_ms=row["duration_ms"],
            plain_lyrics=row["plain_lyrics"],
            synced_lyrics_lrc=row["synced_lyrics_lrc"],
            source_url=row["source_url"],
            match_confidence=float(row["match_confidence"]),
            match_notes=tuple(json.loads(row["match_notes"])),
            raw=json.loads(row["raw_json"]),
        )

    def put(self, cache_key: str, rec: LyricsRecord) -> None:
        self.conn.execute(
            """
            INSERT INTO lyrics_cache (
              cache_key, created_at_utc, provider, track, artist, album, duration_ms,
              plain_lyrics, synced_lyrics_lrc, source_url, match_confidence, match_notes, raw_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(cache_key) DO UPDATE SET
              created_at_utc=excluded.created_at_utc,
              plain_lyrics=excluded.plain_lyrics,
              synced_lyrics_lrc=excluded.synced_lyrics_lrc,
              source_url=excluded.source_url,
              match_confidence=excluded.match_confidence,
              match_notes=excluded.match_notes,
              raw_json=excluded.raw_json
            """,
            (
                cache_key,
                _utcnow_iso(),
                rec.provider,
                rec.track,
                rec.artist,
                rec.album,
                rec.duration_ms,
                rec.plain_lyrics,
                rec.synced_lyrics_lrc,
                rec.source_url,
                float(rec.match_confidence),
                json.dumps(list(rec.match_notes)),
                json.dumps(rec.raw),
            ),
        )
        self.conn.commit()


@dataclass(slots=True)
class TrackHistoryRepository:
    conn: sqlite3.Connection

    def add(self, track: CanonicalTrack) -> None:
        self.conn.execute(
            """
            INSERT INTO track_history (
              created_at_utc, canonical_title, canonical_artist, canonical_album,
              variant_flags, confidence, source_provider, raw_title, raw_artist, raw_album
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                _utcnow_iso(),
                track.canonical_title,
                track.canonical_artist,
                track.canonical_album,
                json.dumps(sorted(track.variant_flags)),
                float(track.confidence),
                (track.source_snapshot.source_provider if track.source_snapshot else None),
                (track.source_snapshot.track_title_raw if track.source_snapshot else None),
                (track.source_snapshot.artist_raw if track.source_snapshot else None),
                (track.source_snapshot.album_raw if track.source_snapshot else None),
            ),
        )
        self.conn.commit()

