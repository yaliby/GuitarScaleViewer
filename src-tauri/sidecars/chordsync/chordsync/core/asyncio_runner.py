"""Run an asyncio event loop in a background thread.

Qt's event loop is the main loop; we keep asyncio orchestration separate and
communicate via Qt signals.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import structlog

log = structlog.get_logger(__name__)


@dataclass(slots=True)
class AsyncioRunner:
    _thread: threading.Thread | None = None
    _loop: asyncio.AbstractEventLoop | None = None
    _started: threading.Event = field(default_factory=threading.Event)

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return

        def _run() -> None:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            self._loop = loop
            self._started.set()
            log.info("asyncio_runner_started")
            try:
                loop.run_forever()
            finally:
                pending = asyncio.all_tasks(loop)
                for t in pending:
                    t.cancel()
                with contextlib.suppress(Exception):
                    loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
                loop.close()
                log.info("asyncio_runner_stopped")

        self._thread = threading.Thread(target=_run, name="ChordSyncAsyncio", daemon=True)
        self._thread.start()
        self._started.wait(timeout=5.0)

    def stop(self) -> None:
        if not self._loop:
            return
        self._loop.call_soon_threadsafe(self._loop.stop)

    def submit(self, coro: Awaitable[Any]) -> "asyncio.Future[Any]":
        if not self._loop:
            raise RuntimeError("AsyncioRunner not started")
        return asyncio.run_coroutine_threadsafe(coro, self._loop)

    def call_soon(self, fn: Callable[[], Any]) -> None:
        if not self._loop:
            raise RuntimeError("AsyncioRunner not started")
        self._loop.call_soon_threadsafe(fn)


import contextlib  # at end

