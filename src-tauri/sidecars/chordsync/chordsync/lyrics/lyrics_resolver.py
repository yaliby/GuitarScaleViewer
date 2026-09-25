"""End-to-end lyrics resolution: snapshot -> canonical -> LRCLIB -> chosen record."""

from __future__ import annotations

from dataclasses import dataclass, field

import structlog

from chordsync.config import AppConfig
from chordsync.core.models import CanonicalTrack, LyricsRecord, NowPlayingSnapshot
from chordsync.lyrics.lrclib_client import LRCLibClient
from chordsync.normalize.metadata_normalizer import MetadataNormalizer
from chordsync.persistence.repositories import LyricsCacheRepository

log = structlog.get_logger(__name__)


@dataclass(slots=True)
class LyricsResolver:
    cfg: AppConfig
    cache_repo: LyricsCacheRepository
    normalizer: MetadataNormalizer
    client: LRCLibClient = field(init=False)

    def __post_init__(self) -> None:
        self.client = LRCLibClient(self.cfg, self.cache_repo)

    async def resolve_from_snapshot(self, snap: NowPlayingSnapshot) -> tuple[CanonicalTrack | None, LyricsRecord | None]:
        track = self.normalizer.normalize(snap)
        if not track:
            return None, None
        rec = await self.client.resolve_best_match(track)
        if not rec:
            log.info("lyrics_not_found", title=track.canonical_title, artist=track.canonical_artist)
            return track, None
        return track, rec

