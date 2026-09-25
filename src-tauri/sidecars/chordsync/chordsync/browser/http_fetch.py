"""Halturaz-style HTML fetch.

Retry 5xx, 429, empty bodies, and network errors. Fail immediately on other 4xx
(404/400/403): waiting does not turn a missing page into a chart. A 403 bot-wall
is recovered later by parsing the WebView document with the same scraper.
"""

from __future__ import annotations

import asyncio

import httpx
import structlog

from chordsync.core.net import note_transient

log = structlog.get_logger(__name__)

_DEFAULT_RETRIES = 3


class FatalHttpError(Exception):
    """Non-retryable HTTP status (4xx except 429)."""

    def __init__(self, status: int, url: str) -> None:
        self.status = int(status)
        self.url = url
        super().__init__(f"http_{self.status}")


class FetchGaveUp(Exception):
    """Retries exhausted for a transient fetch failure."""

    def __init__(self, reason: str, url: str = "") -> None:
        self.reason = reason or "fetch_failed"
        self.url = url
        super().__init__(self.reason)


def should_retry_status(status: int) -> bool:
    return int(status) >= 500 or int(status) == 429


async def fetch_html(
    client: httpx.AsyncClient,
    url: str,
    *,
    retries: int = _DEFAULT_RETRIES,
    headers: dict[str, str] | None = None,
) -> str:
    last_err = "fetch_failed"
    attempts = max(1, int(retries))
    for i in range(attempts):
        try:
            r = await client.get(url, headers=headers) if headers else await client.get(url)
            if r.status_code >= 400:
                last_err = f"http_{r.status_code}"
                if not should_retry_status(r.status_code):
                    raise FatalHttpError(r.status_code, url)
            elif not (r.text or "").strip():
                last_err = "empty"
            else:
                return r.text
        except FatalHttpError:
            raise
        except Exception as e:
            last_err = str(e) or e.__class__.__name__
            log.warning("html_fetch_failed", url=url, attempt=i + 1, error=last_err)
        if i + 1 < attempts:
            delay = 1.0 * (i + 1) if last_err == "http_429" else 0.3 * (i + 1)
            await asyncio.sleep(delay)
    note_transient(f"fetch:{last_err}")
    raise FetchGaveUp(last_err, url)
