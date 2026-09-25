"""A small async pub/sub bus.

Used to decouple providers, resolver, sync loop and UI.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, DefaultDict

import structlog

from chordsync.core.models import Event, EventType

log = structlog.get_logger(__name__)

EventCallback = Callable[[Event], Awaitable[None] | None]


@dataclass(slots=True)
class EventBus:
    _subscribers: DefaultDict[EventType, list[EventCallback]] = field(
        default_factory=lambda: __import__("collections").defaultdict(list)
    )
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def publish(self, event: Event) -> None:
        async with self._lock:
            subs = list(self._subscribers.get(event.type, []))
        if not subs:
            return
        for cb in subs:
            try:
                result = cb(event)
                if asyncio.iscoroutine(result):
                    await result
            except Exception:
                log.exception("event_callback_failed", event_type=event.type)

    async def subscribe(self, event_type: EventType, callback: EventCallback) -> None:
        async with self._lock:
            self._subscribers[event_type].append(callback)

    async def unsubscribe(self, event_type: EventType, callback: EventCallback) -> None:
        async with self._lock:
            self._subscribers[event_type] = [
                cb for cb in self._subscribers.get(event_type, []) if cb is not callback
            ]

