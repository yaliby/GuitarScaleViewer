"""Lyrics cache adapters (in-memory + sqlite repository)."""

from __future__ import annotations

from dataclasses import dataclass, field

from chordsync.core.models import LyricsRecord
from chordsync.persistence.repositories import LyricsCacheRepository


@dataclass(slots=True)
class LyricsCache:
    repo: LyricsCacheRepository
    _mem: dict[str, LyricsRecord] = field(default_factory=dict)

    def get(self, cache_key: str) -> LyricsRecord | None:
        if cache_key in self._mem:
            return self._mem[cache_key]
        rec = self.repo.get(cache_key)
        if rec:
            self._mem[cache_key] = rec
        return rec

    def put(self, cache_key: str, rec: LyricsRecord) -> None:
        self._mem[cache_key] = rec
        self.repo.put(cache_key, rec)

