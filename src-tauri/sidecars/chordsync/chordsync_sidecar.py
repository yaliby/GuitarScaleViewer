#!/usr/bin/env python3
"""Headless ChordSync adapter for Fretboard Studio.

Imports the live ChordSync package (sibling repo, then vendored fallback).
Resolve + follow use ChordSync's own modules — no second matcher/clock.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
import traceback
from pathlib import Path
from typing import Any

SIDECAR_DIR = Path(__file__).resolve().parent
if str(SIDECAR_DIR) not in sys.path:
    sys.path.insert(0, str(SIDECAR_DIR))


def _valid_root(path: Path) -> bool:
    return (path / "chordsync" / "__init__.py").is_file()


def chordsync_roots() -> list[Path]:
    """Prefer the sibling ChordSync checkout so Play Along tracks the live files."""
    ordered: list[Path] = []
    env = (os.environ.get("CHORDSYNC_ROOT") or "").strip()
    if env:
        ordered.append(Path(env).expanduser().resolve())
    # sidecars/chordsync → src-tauri → GuitarScaleViewer → Projects/ChordSync
    sibling = SIDECAR_DIR.parents[3] / "ChordSync"
    ordered.append(sibling)
    ordered.append(SIDECAR_DIR)
    seen: set[Path] = set()
    out: list[Path] = []
    for raw in ordered:
        try:
            path = raw.resolve()
        except OSError:
            continue
        if path in seen or not _valid_root(path):
            continue
        seen.add(path)
        out.append(path)
    return out


def bind_chordsync() -> Path:
    roots = chordsync_roots()
    if not roots:
        raise SystemExit(
            "ChordSync package not found. Clone it next to GuitarScaleViewer "
            "or set CHORDSYNC_ROOT to the checkout that contains chordsync/."
        )
    for root in reversed(roots):
        sys.path.insert(0, str(root))
    return roots[0]


CHORD_ROOT = bind_chordsync()

from follow_session import FollowSession, playalong_track_key  # noqa: E402  — after CHORD_ROOT is on sys.path

_RESOLVE_GEN = 0
_RESOLVE_GEN_LOCK = threading.Lock()


def _chart_json(chart: Any) -> dict[str, Any] | None:
    if chart is None:
        return None
    return {
        "source": chart.source,
        "sourceUrl": chart.source_url,
        "key": chart.key,
        "title": chart.title,
        "artist": chart.artist,
        "notes": list(chart.notes or ()),
        "sections": [
            {
                "label": section.label,
                "lines": [
                    {
                        "lyric": line.lyric,
                        "rtl": line.rtl,
                        "chordsOnly": line.chords_only,
                        "segs": [{"t": seg.t, "c": seg.c} for seg in line.segs],
                    }
                    for line in section.lines
                ],
            }
            for section in chart.sections
        ],
    }


def _chart_lines(chart_json: dict[str, Any] | None) -> list[str]:
    """AppController uses chart_lyric_lines: only rows that actually have lyric text.

    Those are the same indices chart_html writes as data-line (chords-only rows
    have empty lyrics). Empty strings in this list occupy an index, so
    forward_next_line cannot stick to the next sung row.
    """
    if not chart_json:
        return []
    out: list[str] = []
    for section in chart_json.get("sections") or []:
        for line in section.get("lines") or []:
            lyric = (line.get("lyric") or "").strip()
            if not lyric:
                continue
            out.append(lyric)
    return out


def _emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _as_int(value: Any) -> int | None:
    if value is None or value is False or value == "":
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _as_bool(value: Any) -> bool | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value).strip().lower()
    if text in {"true", "1", "yes"}:
        return True
    if text in {"false", "0", "no"}:
        return False
    return None


ENGINE = FollowSession()


def _package_info() -> dict[str, Any]:
    import chordsync

    return {
        "packageRoot": str(CHORD_ROOT),
        "packageFile": getattr(chordsync, "__file__", None),
    }


async def _resolve(req: dict[str, Any]) -> dict[str, Any]:
    from chordsync.browser.chart_html import render_chart_html
    from chordsync.browser.chart_scrape import scrape_chart
    from chordsync.browser.page_router import PageRouter
    from chordsync.config import load_config
    from chordsync.core.chart import chart_lyric_lines, lyrics_only_chart
    from chordsync.core.models import NowPlayingSnapshot, Platform
    from chordsync.lyrics.lrc_parser import parse_lrc
    from chordsync.lyrics.lyrics_resolver import LyricsResolver
    from chordsync.persistence.db import Database
    from chordsync.persistence.repositories import LyricsCacheRepository
    from chordsync.normalize.metadata_normalizer import MetadataNormalizer

    gen = 0
    raw_gen = req.get("gen")
    if isinstance(raw_gen, (int, float)):
        gen = int(raw_gen)
    with _RESOLVE_GEN_LOCK:
        global _RESOLVE_GEN
        if gen > 0:
            _RESOLVE_GEN = max(_RESOLVE_GEN, gen)

    title = (req.get("title") or "").strip()
    artist = (req.get("artist") or "").strip() or None
    album = (req.get("album") or "").strip() or None
    duration_ms = req.get("durationMs")
    source_app = (req.get("sourceApp") or "").strip() or None
    if not title:
        return {"status": "none", "reason": "no_title", "track": None, "lyrics": None, "chart": None}

    from chordsync.browser.text_match import has_hebrew
    from chordsync.sync.lrc_offset import is_video_like_source
    from dev_lanes import DEV

    player_duration_ms = int(duration_ms) if isinstance(duration_ms, (int, float)) else None
    track_id = playalong_track_key(
        title=title,
        artist=artist,
        album=album,
        source_app=source_app,
    )
    DEV.ensure_track(
        track_id=track_id,
        title=title,
        artist=artist,
        source_app=source_app,
        url=str(req.get("url") or "").strip() or None,
        duration_ms=player_duration_ms,
        video_like=is_video_like_source(source_app),
        long_track=bool(player_duration_ms and player_duration_ms > 15 * 60_000),
        language_hint="he" if has_hebrew(title) or has_hebrew(artist or "") else None,
    )

    cfg = load_config()
    db = Database(cfg.resolved_db_path())
    conn = db.connect()
    db.init_schema(conn)
    resolver = LyricsResolver(cfg, LyricsCacheRepository(conn), MetadataNormalizer())
    router = PageRouter.defaults(
        preferred_language=cfg.preferred_language,
        enable_hebrew=cfg.enable_hebrew_queries,
        allow_english_fallback=cfg.chord_search_allow_english_fallback,
        verify_chord_pages=cfg.chord_search_verify_pages,
        max_verify_candidates=cfg.chord_search_max_verify_candidates,
        verify_timeout_s=cfg.chord_search_verify_timeout_s,
    )

    snap = NowPlayingSnapshot(
        source_provider="gsv",
        device_id="local",
        platform=Platform.UNKNOWN,
        app_name=source_app,
        track_title_raw=title,
        artist_raw=artist,
        album_raw=album,
        duration_ms=int(duration_ms) if isinstance(duration_ms, (int, float)) else None,
        position_ms=None,
        is_playing=True,
        artwork_url=None,
        confidence=1.0,
    )
    track, record = await resolver.resolve_from_snapshot(snap)

    lyrics: dict[str, Any] | None = None
    parsed = None
    lrc_duration_ms = None
    lyrics_state = "none"
    if record is not None:
        if record.synced_lyrics_lrc:
            parsed = parse_lrc(record.synced_lyrics_lrc)
            if parsed is not None and not parsed.lines:
                parsed = None
            lyrics_state = "synced" if parsed is not None else "none"
        elif record.plain_lyrics:
            lyrics_state = "plain"
        lrc_duration_ms = int(record.duration_ms) if record.duration_ms else None
        lyrics = {
            "provider": record.provider,
            "title": record.track,
            "artist": record.artist,
            "plain": record.plain_lyrics,
            "synced": [
                {"timeMs": line.time_ms, "text": line.raw_text, "index": line.line_index}
                for line in (parsed.lines if parsed is not None else ())
            ],
            "confidence": record.match_confidence,
        }

    chart_json = None
    chart_obj = None
    chart_reason = None
    if track is not None:
        urls, meta = await router.find_candidate_chords_urls(track, limit=3)
        chart_reason = meta.get("error") or meta.get("resolution_explanation")
        for url in urls:
            scraped = await scrape_chart(str(url))
            if scraped.chart is not None:
                chart_obj = scraped.chart
                chart_json = _chart_json(scraped.chart)
                chart_reason = str(url)
                break
            chart_reason = scraped.error or chart_reason

    if chart_json is None:
        fallback_lines: list[str] = []
        if lyrics and lyrics.get("synced"):
            fallback_lines = [str(line["text"]) for line in lyrics["synced"] if line.get("text")]
        elif lyrics and lyrics.get("plain"):
            fallback_lines = [ln for ln in str(lyrics["plain"]).splitlines() if ln.strip()]
        if fallback_lines:
            chart_obj = lyrics_only_chart(
                fallback_lines,
                title=track.canonical_title if track else title,
                artist=track.canonical_artist if track else artist,
            )
            chart_json = _chart_json(chart_obj)

    status = "none"
    if chart_json and chart_json.get("sourceUrl"):
        status = "chart"
    elif lyrics and lyrics.get("synced"):
        status = "lyrics"
    elif lyrics and lyrics.get("plain"):
        status = "plain"

    matcher_lines = chart_lyric_lines(chart_obj) if chart_obj is not None else _chart_lines(chart_json)
    chart_view = "none"
    if chart_json and chart_json.get("sourceUrl"):
        chart_view = "chords"
    elif chart_json:
        chart_view = "lyrics"
    with _RESOLVE_GEN_LOCK:
        stale = gen > 0 and gen < _RESOLVE_GEN
        if not stale:
            ENGINE.load(
                parsed=parsed,
                lines=matcher_lines,
                lrc_duration_ms=lrc_duration_ms,
                app_name=source_app,
                track_id=track_id,
                lyrics_state=lyrics_state,
                chart_view=chart_view,
                player_duration_ms=player_duration_ms,
            )

    return {
        "status": status,
        "reason": chart_reason,
        "track": {
            "title": track.canonical_title if track else title,
            "artist": track.canonical_artist if track else artist,
            "album": track.canonical_album if track else album,
        }
        if track or title
        else None,
        "lyrics": lyrics,
        "chart": chart_json,
        "chartHtml": render_chart_html(chart_obj),
        "chartLyricLines": matcher_lines,
        **_package_info(),
    }


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    op = (req.get("op") or "resolve").strip().lower()
    if op == "ping":
        return {"status": "ok", "op": "ping", **_package_info()}
    if op == "resolve":
        return asyncio.run(_resolve(req))
    if op == "follow":
        return ENGINE.follow(req)
    return {"status": "error", "reason": f"unknown_op:{op}"}


def _serve() -> int:
    _emit({"ready": True, "readyReason": "ok", **_package_info()})
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            if not isinstance(req, dict):
                raise ValueError("request must be an object")
            payload = _handle(req)
        except Exception as exc:
            payload = {
                "status": "error",
                "reason": str(exc),
                "trace": traceback.format_exc(limit=6),
            }
        _emit(payload)
    return 0


def _http_serve(host: str, port: int) -> int:
    """Browser-reachable ChordSync engine. Vite proxies /chordsync → this port."""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from urllib.parse import parse_qs, urlparse

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args: object) -> None:
            sys.stderr.write("chordsync http: " + (fmt % args) + "\n")

        def _cors(self) -> None:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "content-type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

        def _send(self, code: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self._cors()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self) -> None:  # noqa: N802
            self.send_response(204)
            self._cors()
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path in ("/health", "/", "/ping"):
                return self._send(200, {"ready": True, "status": "ok", **_package_info()})
            if parsed.path == "/resolve":
                qs = {k: v[0] for k, v in parse_qs(parsed.query).items() if v}
                qs["op"] = "resolve"
                try:
                    return self._send(200, _handle(qs))
                except Exception as exc:
                    return self._send(
                        500,
                        {"status": "error", "reason": str(exc), "track": None, "lyrics": None, "chart": None},
                    )
            if parsed.path == "/follow":
                qs = {k: v[0] for k, v in parse_qs(parsed.query).items() if v}
                qs["op"] = "follow"
                try:
                    return self._send(200, _handle(qs))
                except Exception as exc:
                    return self._send(500, {"status": "error", "reason": str(exc)})
            return self._send(404, {"status": "error", "reason": "not_found"})

        def do_POST(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path not in ("/resolve", "/follow"):
                return self._send(404, {"status": "error", "reason": "not_found"})
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            try:
                req = json.loads(raw.decode("utf-8") or "{}")
                if not isinstance(req, dict):
                    raise ValueError("request must be an object")
                req["op"] = parsed.path.lstrip("/")
                return self._send(200, _handle(req))
            except Exception as exc:
                return self._send(
                    500,
                    {"status": "error", "reason": str(exc), "track": None, "lyrics": None, "chart": None},
                )

    try:
        httpd = ThreadingHTTPServer((host, port), Handler)
    except OSError as exc:
        print(f"chordsync http: {host}:{port} already in use ({exc})", file=sys.stderr, flush=True)
        _emit({"ready": True, "readyReason": f"http://{host}:{port}", "shared": True, **_package_info()})
        return 0
    print(
        f"chordsync http listening on http://{host}:{port} package={CHORD_ROOT}",
        file=sys.stderr,
        flush=True,
    )
    _emit({"ready": True, "readyReason": f"http://{host}:{port}", **_package_info()})
    httpd.serve_forever()
    return 0


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if "--serve" in args:
        return _serve()
    if "--http" in args:
        idx = args.index("--http")
        bind = args[idx + 1] if idx + 1 < len(args) and not args[idx + 1].startswith("-") else "127.0.0.1:18766"
        if ":" in bind:
            host, port_s = bind.rsplit(":", 1)
        else:
            host, port_s = "127.0.0.1", bind
        return _http_serve(host or "127.0.0.1", int(port_s))
    if "--ping" in args:
        _emit({"ready": True, "readyReason": "ok", **_package_info()})
        payload = _handle({"op": "ping"})
        _emit(payload)
        return 0
    print("usage: chordsync_sidecar.py --serve|--http [host:port]|--ping", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
