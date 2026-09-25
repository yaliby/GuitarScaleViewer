"""LRCLIB client with retries + caching + best-match resolution."""

from __future__ import annotations

import asyncio
import json
import random
from dataclasses import dataclass, replace
from typing import Any, Mapping

import httpx
import structlog

from chordsync.config import AppConfig
from chordsync.core.models import CanonicalTrack, IdentityCandidate, LyricsRecord, UrlStr
from chordsync.core.net import is_transient_status, note_transient
from chordsync.lyrics.lyrics_cache import LyricsCache
from chordsync.normalize.title_rules import strip_bracket_noise
from chordsync.persistence.repositories import LyricsCacheRepository
from chordsync.resolution.identity import best_identity_match, fold, track_identities

log = structlog.get_logger(__name__)

# A search row must clear both bars before its lyrics are shown. Without them
# the "best" row of an unrelated result list becomes the lyrics of the song.
_MIN_SCORE = 0.62
_MIN_TITLE_SIM = 0.72
# A synced row this good ends the search early.
_GOOD_ENOUGH = 0.86
_MAX_SEARCHES = 5


def _backoff_s(attempt: int) -> float:
    base = 0.5 * (2**attempt)
    jitter = random.random() * 0.2
    return min(6.0, base + jitter)


def _row_title(c: Mapping[str, Any]) -> str:
    return str(c.get("trackName") or c.get("track_name") or c.get("name") or "")


def _row_artist(c: Mapping[str, Any]) -> str:
    return str(c.get("artistName") or c.get("artist_name") or "")


def _row_duration_ms(c: Mapping[str, Any]) -> int | None:
    d = c.get("duration")
    if isinstance(d, (int, float)) and d > 0:
        return int(float(d) * 1000)
    return None


def _row_synced(c: Mapping[str, Any]) -> bool:
    return bool(c.get("syncedLyrics") or c.get("synced_lyrics"))


def _row_plain(c: Mapping[str, Any]) -> bool:
    return bool(c.get("plainLyrics") or c.get("plain_lyrics"))


@dataclass(slots=True)
class _Ranked:
    score: float
    title_sim: float
    artist_sim: float
    identity: IdentityCandidate | None
    row: Mapping[str, Any]

    @property
    def acceptable(self) -> bool:
        return self.score >= _MIN_SCORE and self.title_sim >= _MIN_TITLE_SIM


@dataclass(slots=True)
class LRCLibClient:
    cfg: AppConfig
    cache_repo: LyricsCacheRepository
    _cache: LyricsCache | None = None

    def __post_init__(self) -> None:
        self._cache = LyricsCache(self.cache_repo)

    def _cache_key(self, *, track: str | None, artist: str | None, album: str | None, duration_ms: int | None) -> str:
        return self.cache_repo.make_cache_key(
            provider="lrclib", track=track, artist=artist, album=album, duration_ms=duration_ms
        )

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            timeout=httpx.Timeout(self.cfg.lrclib_timeout_s),
            headers={"User-Agent": "ChordSyncCompanion/1.1 (https://github.com/chordsync)"},
        )

    async def get_exact(
        self,
        *,
        track: str,
        artist: str,
        album: str | None,
        duration_ms: int | None = None,
        client: httpx.AsyncClient | None = None,
    ) -> LyricsRecord | None:
        cache_key = self._cache_key(track=track, artist=artist, album=album, duration_ms=duration_ms)
        cached = self._cache.get(cache_key) if self._cache else None
        if cached:
            return cached

        # GET /api/get?track_name=...&artist_name=...[&album_name=...][&duration=...]
        url = f"{self.cfg.lrclib_base_url.rstrip('/')}/api/get"
        params = {"track_name": track, "artist_name": artist}
        if album:
            params["album_name"] = album
        if duration_ms is not None:
            params["duration"] = str(int(round(duration_ms / 1000)))

        log.info("lrclib_get_exact", track=track, artist=artist, album=album, duration_ms=duration_ms)
        data = await self._request_json(url, params=params, client=client)
        if not data or not isinstance(data, Mapping):
            log.info("lrclib_get_exact_miss")
            return None

        rec = self._to_record(data, notes=("exact_get",), confidence=0.75)
        if self._cache:
            self._cache.put(cache_key, rec)
        return rec

    async def search(
        self,
        *,
        query_text: str | None = None,
        track: str | None = None,
        artist: str | None = None,
        duration_ms: int | None = None,
        client: httpx.AsyncClient | None = None,
    ) -> list[Mapping[str, Any]]:
        url = f"{self.cfg.lrclib_base_url.rstrip('/')}/api/search"
        params: dict[str, str] = {}
        if query_text:
            params["q"] = query_text
        if track:
            params["track_name"] = track
        if artist:
            params["artist_name"] = artist
        if duration_ms is not None:
            params["duration"] = str(int(duration_ms / 1000))

        data = await self._request_json(url, params=params, client=client)
        if not data:
            return []
        if isinstance(data, list):
            return [d for d in data if isinstance(d, dict)]
        # some deployments may return {"results":[...]}
        if isinstance(data, dict) and isinstance(data.get("results"), list):
            return [d for d in data["results"] if isinstance(d, dict)]
        return []

    def _rank(
        self, rows: list[Mapping[str, Any]], identities: list[IdentityCandidate], duration_ms: int | None
    ) -> list[_Ranked]:
        ranked: list[_Ranked] = []
        seen: set[tuple[str, str, int | None]] = set()
        for row in rows:
            key = (fold(_row_title(row)), fold(_row_artist(row)), _row_duration_ms(row))
            if key in seen:
                continue
            seen.add(key)
            score, ts, asim, ident = best_identity_match(
                identities,
                _row_title(row),
                _row_artist(row),
                want_duration_ms=duration_ms,
                got_duration_ms=_row_duration_ms(row),
            )
            if _row_synced(row):
                score = min(1.0, score + 0.03)
            ranked.append(_Ranked(score=score, title_sim=ts, artist_sim=asim, identity=ident, row=row))
        ranked.sort(key=lambda r: r.score, reverse=True)
        return ranked

    async def resolve_best_match(self, track: CanonicalTrack) -> LyricsRecord | None:
        snap = track.source_snapshot
        duration = snap.duration_ms if snap else None
        identities = track_identities(track)
        plain_fallback: LyricsRecord | None = None

        async with self._client() as client:
            # 1) Exact lookups for identities that name an artist.
            tried: set[tuple[str, str, str, int | None]] = set()
            for n, ident in enumerate(identities[:3]):
                if not ident.search_artist:
                    continue
                attempts: list[tuple[str | None, int | None]] = []
                if n == 0 and track.search_album:
                    attempts.append((track.search_album, duration))
                attempts.append((None, duration))
                if duration is not None:
                    attempts.append((None, None))
                for album, dur in attempts:
                    key = (fold(ident.search_title), fold(ident.search_artist), fold(album), dur)
                    if key in tried:
                        continue
                    tried.add(key)
                    rec = await self.get_exact(
                        track=ident.search_title,
                        artist=ident.search_artist,
                        album=album,
                        duration_ms=dur,
                        client=client,
                    )
                    if rec is None:
                        continue
                    score, ts, _asim, _ident = best_identity_match(
                        [ident], rec.track, rec.artist, want_duration_ms=duration, got_duration_ms=rec.duration_ms
                    )
                    notes = (f"identity={ident.label}", f"score={score:.2f}")
                    if ts < _MIN_TITLE_SIM:
                        continue
                    if rec.synced_lyrics_lrc:
                        conf = 0.92 if dur is not None else 0.86
                        return replace(rec, match_confidence=conf, match_notes=rec.match_notes + ("exact_synced_hit",) + notes)
                    if rec.plain_lyrics and plain_fallback is None:
                        plain_fallback = replace(
                            rec, match_confidence=0.78, match_notes=rec.match_notes + ("exact_plain_fallback",) + notes
                        )

            # 2) Free-text search across identities, then the raw title.
            queries: list[str] = []
            for ident in identities[:4]:
                q = f"{ident.search_artist} {ident.search_title}".strip()
                if q:
                    queries.append(q)
            raw_title = strip_bracket_noise((snap.track_title_raw or "") if snap else "")
            if raw_title:
                queries.append(raw_title)
            seen_q: set[str] = set()
            rows: list[Mapping[str, Any]] = []
            ranked: list[_Ranked] = []
            n_searches = 0
            for q in queries:
                fq = fold(q)
                if not fq or fq in seen_q:
                    continue
                seen_q.add(fq)
                if n_searches >= _MAX_SEARCHES:
                    break
                n_searches += 1
                rows.extend(await self.search(query_text=q, client=client))
                ranked = self._rank(rows, identities, duration)
                top_synced = next((r for r in ranked if _row_synced(r.row) and r.acceptable), None)
                if top_synced is not None and top_synced.score >= _GOOD_ENOUGH:
                    break

        if not ranked:
            log.info("lrclib_search_no_results", title=track.search_title, artist=track.search_artist)
            return plain_fallback

        best = ranked[0]
        log.info(
            "lrclib_ranked",
            best_score=round(best.score, 3),
            title_sim=round(best.title_sim, 3),
            artist_sim=round(best.artist_sim, 3),
            best_track=_row_title(best.row),
            best_artist=_row_artist(best.row),
            identity=best.identity.label if best.identity else None,
            candidates=len(ranked),
        )

        synced = next((r for r in ranked if _row_synced(r.row) and r.acceptable), None)
        if synced is not None:
            return self._ranked_record(synced, "search_synced_preferred")
        if plain_fallback is not None:
            return plain_fallback
        plain = next((r for r in ranked if _row_plain(r.row) and r.acceptable), None)
        if plain is not None:
            return self._ranked_record(plain, "search_plain")
        log.info(
            "lrclib_rejected_weak_matches",
            best_score=round(best.score, 3),
            title_sim=round(best.title_sim, 3),
            best_track=_row_title(best.row),
            best_artist=_row_artist(best.row),
        )
        return None

    def _ranked_record(self, r: _Ranked, tag: str) -> LyricsRecord:
        notes = (
            tag,
            f"title={r.title_sim:.2f}",
            f"artist={r.artist_sim:.2f}",
            f"identity={r.identity.label if r.identity else 'none'}",
            f"synced={'1' if _row_synced(r.row) else '0'}",
        )
        rec = self._to_record(r.row, notes=notes, confidence=r.score)
        return replace(rec, match_confidence=float(r.score))

    async def _request_json(
        self,
        url: str,
        *,
        params: Mapping[str, str],
        client: httpx.AsyncClient | None = None,
    ) -> Any | None:
        if client is None:
            async with self._client() as own:
                return await self._request_json(url, params=params, client=own)
        last_error = ""
        for attempt in range(self.cfg.lrclib_retries + 1):
            try:
                r = await client.get(url, params=dict(params))
                log.debug("lrclib_http", status=r.status_code, url=url)
                if r.status_code == 404:
                    return None
                if r.status_code >= 400 and not is_transient_status(r.status_code):
                    log.warning("lrclib_http_rejected", status=r.status_code, url=url)
                    return None
                r.raise_for_status()
                return r.json()
            except Exception as e:
                last_error = str(e) or e.__class__.__name__
                if attempt >= self.cfg.lrclib_retries:
                    break
                await asyncio.sleep(_backoff_s(attempt))
        log.warning("lrclib_request_failed", url=url, error=last_error)
        note_transient(f"lrclib:{last_error[:80]}")
        return None

    def _to_record(self, data: Mapping[str, Any], *, notes: tuple[str, ...], confidence: float) -> LyricsRecord:
        plain = data.get("plainLyrics") or data.get("plain_lyrics")
        synced = data.get("syncedLyrics") or data.get("synced_lyrics")
        source_url = data.get("url") or data.get("source") or None
        return LyricsRecord(
            provider="lrclib",
            track=str(data.get("trackName") or data.get("track_name") or "") or None,
            artist=str(data.get("artistName") or data.get("artist_name") or "") or None,
            album=(str(data.get("albumName") or data.get("album_name")) if (data.get("albumName") or data.get("album_name")) else None),
            duration_ms=(int(float(data.get("duration")) * 1000) if data.get("duration") else None),
            plain_lyrics=str(plain) if plain else None,
            synced_lyrics_lrc=str(synced) if synced else None,
            source_url=UrlStr(str(source_url)) if source_url else None,
            match_confidence=float(confidence),
            match_notes=tuple(notes),
            raw=json.loads(json.dumps(data, default=str)),
        )
