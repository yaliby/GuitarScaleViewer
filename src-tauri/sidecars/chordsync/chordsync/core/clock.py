"""Time utilities to make logic testable."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone


@dataclass(frozen=True, slots=True)
class Clock:
    def now_utc(self) -> datetime:
        return datetime.now(timezone.utc)

