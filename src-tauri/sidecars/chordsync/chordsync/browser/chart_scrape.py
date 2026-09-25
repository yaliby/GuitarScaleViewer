"""Dispatch Halturaz-style scrapers by chord-site host."""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlparse

import httpx
import structlog

from chordsync.browser.http_fetch import FatalHttpError, FetchGaveUp
from chordsync.browser.tab4u_parse import fetch_tab4u_chart, tab4u_chart_from_html
from chordsync.browser.ug_parse import fetch_ug_chart, ug_chart_from_html
from chordsync.core.chart import ScrapedChart

log = structlog.get_logger(__name__)

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
}

# Browser HTML cannot invent a 404. It *can* pass a bot-wall that httpx hit.
_SKIP_WEBVIEW = frozenset({"unsupported_host", "http_400", "http_404", "http_410", "http_422"})


@dataclass(frozen=True, slots=True)
class ScrapeResult:
    chart: ScrapedChart | None = None
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.chart is not None


def chart_host(url: str) -> str:
    return (urlparse(url).netloc or "").lower()


def chart_from_html(url: str, html: str) -> ScrapedChart | None:
    """Parse already-fetched HTML with the same Tab4U / UG scrapers."""
    host = chart_host(url)
    if host.endswith("tab4u.com"):
        return tab4u_chart_from_html(html, url)
    if host.endswith("ultimate-guitar.com"):
        return ug_chart_from_html(html, url)
    return None


def should_try_webview(error: str | None) -> bool:
    if not error:
        return False
    return error not in _SKIP_WEBVIEW


async def scrape_chart(url: str, *, timeout_s: float = 12.0) -> ScrapeResult:
    host = chart_host(url)
    async with httpx.AsyncClient(timeout=timeout_s, headers=_HEADERS, follow_redirects=True) as client:
        try:
            if host.endswith("tab4u.com"):
                chart = await fetch_tab4u_chart(client, url)
            elif host.endswith("ultimate-guitar.com"):
                chart = await fetch_ug_chart(client, url)
            else:
                log.info("chart_scrape_unsupported_host", host=host, url=url)
                return ScrapeResult(error="unsupported_host")
        except FatalHttpError as e:
            log.warning("chart_scrape_http", url=url, status=e.status)
            return ScrapeResult(error=f"http_{e.status}")
        except FetchGaveUp as e:
            log.warning("chart_scrape_gave_up", url=url, error=e.reason)
            return ScrapeResult(error=e.reason)
        except Exception:
            log.exception("chart_scrape_failed", url=url)
            return ScrapeResult(error="fetch_failed")
    if chart is None:
        return ScrapeResult(error="chart_empty")
    return ScrapeResult(chart=chart)
