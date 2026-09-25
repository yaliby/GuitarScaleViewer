"""Smart scroll decision engine.

We don't scroll on every tick. We scroll when:
- the lyric line changes (primary trigger)
- we have sufficient match confidence
- user hasn't manually scrolled recently (cooldown)

The actual scrolling is executed by browser JS (scrollIntoView center).
"""

from __future__ import annotations

import time
from dataclasses import dataclass


@dataclass(slots=True)
class ScrollController:
    user_override_cooldown_s: float = 0.35
    min_confidence: float = 0.60
    min_interval_s: float = 0.0

    _last_scroll_s: float = 0.0
    _last_user_scroll_epoch_ms: float = 0.0
    _last_line_key: str | None = None

    def note_user_scroll(self, epoch_ms: float) -> None:
        self._last_user_scroll_epoch_ms = float(epoch_ms)

    def should_scroll(self, *, line_key: str, match_confidence: float) -> tuple[bool, str]:
        now = time.time()
        if match_confidence < self.min_confidence:
            return False, "low_confidence"
        # Production behavior: never auto-scroll repeatedly to the same line.
        # Auto-scroll is meant to react to line changes, not "fight" the page.
        if self._last_line_key == line_key:
            return False, "same_line_already_scrolled"

        if self._last_user_scroll_epoch_ms:
            delta = (time.time() * 1000.0) - self._last_user_scroll_epoch_ms
            if delta < (self.user_override_cooldown_s * 1000.0):
                return False, "user_override_cooldown"
        return True, "ok"

    def mark_scrolled(self, *, line_key: str) -> None:
        self._last_scroll_s = time.time()
        self._last_line_key = line_key

