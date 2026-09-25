"""Tell "the network hiccuped" apart from "this song has nothing".

Fetch helpers swallow errors and return an empty result so one flaky site never
breaks the pipeline. That hides *why* nothing was found. Resolvers run inside
``track_transient()``; fetch helpers call ``note_transient()`` on timeouts,
5xx, 429 and connection errors. The controller retries a failed resolution
only when the tracker saw transient trouble.

The tracker lives in a ContextVar holding a mutable object, so tasks spawned
inside the block (``asyncio.create_task`` / ``asyncio.to_thread`` copy the
context) report into the same tracker.
"""

from __future__ import annotations

import contextlib
from collections.abc import Iterator
from contextvars import ContextVar
from dataclasses import dataclass, field

_MAX_REASONS = 50


@dataclass(slots=True)
class TransientFailures:
    reasons: list[str] = field(default_factory=list)

    @property
    def any(self) -> bool:
        return bool(self.reasons)


_current: ContextVar[TransientFailures | None] = ContextVar("chordsync_transient", default=None)


def note_transient(reason: str) -> None:
    tracker = _current.get()
    if tracker is not None and len(tracker.reasons) < _MAX_REASONS:
        tracker.reasons.append(str(reason or "transient"))


def is_transient_status(status: int) -> bool:
    return int(status) >= 500 or int(status) == 429


@contextlib.contextmanager
def track_transient() -> Iterator[TransientFailures]:
    tracker = TransientFailures()
    token = _current.set(tracker)
    try:
        yield tracker
    finally:
        _current.reset(token)
