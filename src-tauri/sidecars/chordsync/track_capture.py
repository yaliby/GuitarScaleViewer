"""Grab a playable audio file for the song that is on, or a URL the player pasted.

YouTube is a direct stream extract (yt-dlp + FFmpeg). Spotify / Apple Music and
other DRM players are identified from OS now-playing metadata, then matched on
YouTube — we never read player session files or strip DRM.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
import urllib.parse
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping

ProgressFn = Callable[[int, str], None]

YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "www.youtu.be",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
}

# These hosts are DRM / login walls. Never point yt-dlp at them; search YouTube instead.
PROTECTED_HOSTS = {
    "open.spotify.com",
    "spotify.com",
    "play.spotify.com",
    "music.apple.com",
    "itunes.apple.com",
    "geo.music.apple.com",
    "listen.tidal.com",
    "tidal.com",
    "music.amazon.com",
    "music.amazon.co.uk",
    "deezer.com",
    "www.deezer.com",
}

YOUTUBE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
INDEX_NAME = "index.json"
AUDIO_EXTS = {".mp3", ".m4a", ".aac", ".ogg", ".opus", ".webm", ".wav", ".flac"}


class CaptureError(Exception):
    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason
        self.message = message


@dataclass(frozen=True)
class CapturePlan:
    engine: str
    target: str
    cache_id: str
    youtube_id: str | None = None
    search_query: str | None = None
    local_path: str | None = None


@dataclass(frozen=True)
class CapturedTrack:
    id: str
    path: str
    title: str
    artist: str | None
    album: str | None
    engine: str
    webpage_url: str | None
    duration_ms: int | None
    artwork_path: str | None
    bytes: int
    cached: bool
    source_app: str | None
    captured_at: str

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "path": self.path,
            "title": self.title,
            "artist": self.artist,
            "album": self.album,
            "engine": self.engine,
            "webpageUrl": self.webpage_url,
            "durationMs": self.duration_ms,
            "artworkPath": self.artwork_path,
            "bytes": self.bytes,
            "cached": self.cached,
            "sourceApp": self.source_app,
            "capturedAt": self.captured_at,
        }


def capture_dir() -> Path:
    configured = (os.environ.get("GSV_CAPTURE_DIR") or "").strip()
    if configured:
        path = Path(configured).expanduser()
    else:
        xdg = (os.environ.get("XDG_DATA_HOME") or "").strip()
        if xdg:
            path = Path(xdg) / "fretboard-studio" / "captures"
        else:
            path = Path.home() / ".local" / "share" / "fretboard-studio" / "captures"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _index_path() -> Path:
    return capture_dir() / INDEX_NAME


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _norm(value: str | None) -> str:
    return re.sub(r"\s+", " ", (value or "").strip()).casefold()


def metadata_cache_id(title: str | None, artist: str | None, album: str | None = None) -> str:
    blob = "|".join((_norm(artist), _norm(title), _norm(album)))
    digest = hashlib.sha1(blob.encode("utf-8")).hexdigest()[:16]
    return f"meta-{digest}"


def youtube_video_id(value: str | None) -> str | None:
    text = (value or "").strip()
    if not text:
        return None
    if YOUTUBE_ID_RE.fullmatch(text):
        return text
    try:
        parsed = urllib.parse.urlparse(text)
    except ValueError:
        return None
    host = (parsed.hostname or "").lower()
    if host not in YOUTUBE_HOSTS:
        return None
    if host in {"youtu.be", "www.youtu.be"}:
        candidate = parsed.path.strip("/").split("/", 1)[0]
        return candidate if YOUTUBE_ID_RE.fullmatch(candidate) else None
    query = urllib.parse.parse_qs(parsed.query)
    if "v" in query and query["v"] and YOUTUBE_ID_RE.fullmatch(query["v"][0]):
        return query["v"][0]
    parts = [p for p in parsed.path.split("/") if p]
    if len(parts) >= 2 and parts[0] in {"embed", "shorts", "live", "v"}:
        return parts[1] if YOUTUBE_ID_RE.fullmatch(parts[1]) else None
    return None


def _host_of(url: str) -> str:
    try:
        return (urllib.parse.urlparse(url).hostname or "").lower()
    except ValueError:
        return ""


def is_youtube_url(value: str | None) -> bool:
    return youtube_video_id(value) is not None


def is_protected_url(value: str | None) -> bool:
    host = _host_of(value or "")
    if not host:
        return False
    if host in PROTECTED_HOSTS:
        return True
    return any(host.endswith("." + h) for h in PROTECTED_HOSTS)


def is_http_url(value: str | None) -> bool:
    try:
        parsed = urllib.parse.urlparse((value or "").strip())
    except ValueError:
        return False
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def local_file_path(value: str | None) -> Path | None:
    text = (value or "").strip()
    if not text:
        return None
    if text.startswith("file:"):
        parsed = urllib.parse.urlparse(text)
        raw = urllib.parse.unquote(parsed.path)
        if parsed.netloc and parsed.netloc != "localhost":
            raw = f"//{parsed.netloc}{raw}"
        path = Path(raw)
    else:
        path = Path(text).expanduser()
    try:
        path = path.resolve()
    except OSError:
        return None
    if path.is_file() and path.suffix.lower() in AUDIO_EXTS:
        return path
    return None


def _source_is_youtube(source_app: str | None) -> bool:
    text = (source_app or "").casefold()
    return "youtube" in text or "youtu.be" in text


def plan_capture(
    *,
    query: str | None = None,
    title: str | None = None,
    artist: str | None = None,
    album: str | None = None,
    source_app: str | None = None,
    track_url: str | None = None,
) -> CapturePlan:
    pasted = (query or "").strip()
    session_url = (track_url or "").strip()
    url = pasted or session_url

    local = local_file_path(url)
    if local is not None:
        return CapturePlan(
            engine="local_file",
            target=str(local),
            cache_id=f"file-{hashlib.sha1(str(local).encode()).hexdigest()[:16]}",
            local_path=str(local),
        )

    video_id = youtube_video_id(url)
    if video_id:
        return CapturePlan(
            engine="youtube_direct",
            target=f"https://www.youtube.com/watch?v={video_id}",
            cache_id=f"yt-{video_id}",
            youtube_id=video_id,
        )

    title_text = (title or "").strip()
    artist_text = (artist or "").strip()
    if is_protected_url(url) or (is_http_url(url) and is_protected_url(url)):
        if not title_text:
            raise CaptureError(
                "protected_source",
                "This player protects its audio. Play the song, then capture from its title.",
            )
        search = " ".join(part for part in (artist_text, title_text) if part)
        return CapturePlan(
            engine="youtube_search",
            target=f"ytsearch1:{search}",
            cache_id=metadata_cache_id(title_text, artist_text, album),
            search_query=search,
        )

    if is_http_url(url) and not is_protected_url(url):
        digest = hashlib.sha1(url.encode("utf-8")).hexdigest()[:16]
        return CapturePlan(engine="direct_url", target=url, cache_id=f"url-{digest}")

    if not title_text and pasted and not is_http_url(pasted):
        # Bare search box: treat as a YouTube search query.
        return CapturePlan(
            engine="youtube_search",
            target=f"ytsearch1:{pasted}",
            cache_id=metadata_cache_id(pasted, None, None),
            search_query=pasted,
        )

    if not title_text:
        raise CaptureError("no_title", "Need a YouTube link, or a song title to search for.")

    search = " ".join(part for part in (artist_text, title_text) if part)
    engine = "youtube_search"
    if _source_is_youtube(source_app) and not url:
        engine = "youtube_search"
    return CapturePlan(
        engine=engine,
        target=f"ytsearch1:{search}",
        cache_id=metadata_cache_id(title_text, artist_text, album),
        search_query=search,
    )


def _read_index() -> dict[str, Any]:
    path = _index_path()
    if not path.is_file():
        return {"version": 1, "tracks": {}}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"version": 1, "tracks": {}}
    if not isinstance(payload, dict):
        return {"version": 1, "tracks": {}}
    tracks = payload.get("tracks")
    if not isinstance(tracks, dict):
        payload["tracks"] = {}
    return payload


def _write_index(payload: dict[str, Any]) -> None:
    path = _index_path()
    fd, tmp_name = tempfile.mkstemp(prefix="index.", suffix=".json", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        Path(tmp_name).replace(path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def _row_to_track(row: Mapping[str, Any], *, cached: bool) -> CapturedTrack | None:
    path = str(row.get("path") or "")
    if not path or not Path(path).is_file():
        return None
    duration = row.get("durationMs")
    duration_ms = int(duration) if isinstance(duration, (int, float)) else None
    artwork = str(row.get("artworkPath") or "") or None
    if artwork and not Path(artwork).is_file():
        artwork = None
    return CapturedTrack(
        id=str(row.get("id") or ""),
        path=path,
        title=str(row.get("title") or "Unknown"),
        artist=str(row.get("artist") or "") or None,
        album=str(row.get("album") or "") or None,
        engine=str(row.get("engine") or "youtube_search"),
        webpage_url=str(row.get("webpageUrl") or "") or None,
        duration_ms=duration_ms,
        artwork_path=artwork,
        bytes=int(row.get("bytes") or Path(path).stat().st_size),
        cached=cached,
        source_app=str(row.get("sourceApp") or "") or None,
        captured_at=str(row.get("capturedAt") or ""),
    )


def lookup_track(
    *,
    query: str | None = None,
    title: str | None = None,
    artist: str | None = None,
    album: str | None = None,
    source_app: str | None = None,
    track_url: str | None = None,
) -> CapturedTrack | None:
    try:
        plan = plan_capture(
            query=query,
            title=title,
            artist=artist,
            album=album,
            source_app=source_app,
            track_url=track_url,
        )
    except CaptureError:
        return None
    tracks = _read_index().get("tracks") or {}
    row = tracks.get(plan.cache_id)
    if isinstance(row, dict):
        found = _row_to_track(row, cached=True)
        if found is not None:
            return found
    if plan.youtube_id:
        alt = tracks.get(f"yt-{plan.youtube_id}")
        if isinstance(alt, dict):
            return _row_to_track(alt, cached=True)
    return None


def get_track(cache_id: str) -> CapturedTrack | None:
    row = (_read_index().get("tracks") or {}).get(cache_id)
    if isinstance(row, dict):
        return _row_to_track(row, cached=True)
    return None


def list_tracks() -> list[CapturedTrack]:
    out: list[CapturedTrack] = []
    tracks = _read_index().get("tracks") or {}
    for row in tracks.values():
        if not isinstance(row, dict):
            continue
        item = _row_to_track(row, cached=True)
        if item is not None:
            out.append(item)
    out.sort(key=lambda item: item.captured_at, reverse=True)
    return out


def which_tool(name: str) -> str | None:
    found = shutil.which(name)
    return found if found else None


def _project_root() -> Path | None:
    for parent in Path(__file__).resolve().parents:
        if (parent / "setup-native.ps1").is_file() and (parent / "src-tauri").is_dir():
            return parent
    return None


def _executable(directory: Path, name: str) -> Path | None:
    for filename in (f"{name}.exe", name):
        candidate = directory / filename
        if candidate.is_file():
            return candidate
    return None


def _with_ffprobe(ffmpeg: Path) -> str | None:
    """yt-dlp encodes with the ffprobe that sits next to ffmpeg."""
    if ffmpeg.is_file() and _executable(ffmpeg.parent, "ffprobe") is not None:
        return str(ffmpeg)
    return None


def resolve_ffmpeg(
    env: Mapping[str, str] | None = None,
    root: Path | None = None,
    which: Callable[[str], str | None] | None = None,
) -> str | None:
    """Project-local FFmpeg first, then PATH. The desktop launcher downloads the local one."""
    environ = os.environ if env is None else env
    configured = (environ.get("FFMPEG_PATH") or environ.get("GSV_FFMPEG") or "").strip()
    if configured:
        path = Path(configured).expanduser()
        if path.is_dir():
            found = _executable(path, "ffmpeg")
            if found is not None:
                paired = _with_ffprobe(found)
                if paired:
                    return paired
        else:
            paired = _with_ffprobe(path)
            if paired:
                return paired
    project = _project_root() if root is None else root
    if project is not None:
        found = _executable(project / ".tools" / "ffmpeg" / "bin", "ffmpeg")
        if found is not None:
            paired = _with_ffprobe(found)
            if paired:
                return paired
    locate = which if which is not None else which_tool
    on_path = locate("ffmpeg")
    if on_path:
        paired = _with_ffprobe(Path(on_path))
        if paired:
            return paired
    return None


def _require_ffmpeg() -> str:
    path = resolve_ffmpeg()
    if path:
        return path
    raise CaptureError(
        "ffmpeg_missing",
        "FFmpeg is not available yet. Run the desktop app again so it can download FFmpeg into .tools.",
    )


def _ytdlp_module() -> Any | None:
    try:
        import yt_dlp  # type: ignore
    except ImportError:
        return None
    return yt_dlp


def _require_ytdlp_cli() -> str:
    path = which_tool("yt-dlp")
    if path:
        return path
    raise CaptureError(
        "ytdlp_missing",
        "yt-dlp is not installed. pip install yt-dlp, or add the yt-dlp binary to PATH.",
    )


def _pick_audio_file(folder: Path) -> Path | None:
    files = [p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in AUDIO_EXTS]
    if not files:
        return None
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return files[0]


def _pick_artwork(folder: Path) -> Path | None:
    for ext in (".jpg", ".jpeg", ".png", ".webp"):
        matches = [p for p in folder.iterdir() if p.is_file() and p.suffix.lower() == ext]
        if matches:
            matches.sort(key=lambda p: p.stat().st_mtime, reverse=True)
            return matches[0]
    return None


def _copy_to_cache(src: Path, cache_id: str, suffix: str) -> Path:
    dest = capture_dir() / f"{cache_id}{suffix}"
    if src.resolve() != dest.resolve():
        shutil.copy2(src, dest)
    return dest


def _encode_mp3(src: Path, dest: Path, ffmpeg: str, progress: ProgressFn | None) -> None:
    if progress:
        progress(82, "encode")
    cmd = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(src),
        "-vn",
        "-codec:a",
        "libmp3lame",
        "-q:a",
        "2",
        str(dest),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or str(exc)).strip()
        raise CaptureError("ffmpeg_failed", f"FFmpeg could not encode MP3: {detail}") from exc
    if not dest.is_file() or dest.stat().st_size < 1024:
        raise CaptureError("ffmpeg_failed", "FFmpeg produced an empty MP3.")


def _progress_hook(progress: ProgressFn | None) -> Callable[[dict[str, Any]], None]:
    def hook(event: dict[str, Any]) -> None:
        if not progress:
            return
        status = event.get("status")
        if status == "downloading":
            total = event.get("total_bytes") or event.get("total_bytes_estimate") or 0
            done = event.get("downloaded_bytes") or 0
            if total:
                pct = max(1, min(80, int(done * 80 / total)))
            else:
                pct = 20
            progress(pct, "download")
        elif status == "finished":
            progress(80, "encode")

    return hook


def _download_with_module(
    yt_dlp: Any,
    plan: CapturePlan,
    work: Path,
    ffmpeg: str,
    progress: ProgressFn | None,
) -> dict[str, Any]:
    opts: dict[str, Any] = {
        "format": "bestaudio[ext=m4a]/bestaudio/best",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "outtmpl": str(work / "%(id)s.%(ext)s"),
        "writethumbnail": True,
        "restrictfilenames": True,
        "retries": 2,
        "socket_timeout": 20,
        "cachedir": False,
        "ffmpeg_location": str(Path(ffmpeg).parent),
        "progress_hooks": [_progress_hook(progress)],
        "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"},
            {"key": "FFmpegMetadata"},
        ],
        "extractor_args": {"youtube": {"player_client": ["android", "web"]}},
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(plan.target, download=True)
    if isinstance(info, dict) and info.get("entries"):
        entries = [row for row in info["entries"] if isinstance(row, dict)]
        info = entries[0] if entries else info
    if not isinstance(info, dict):
        raise CaptureError("extract_failed", "yt-dlp returned no video information.")
    return info


def _download_with_cli(
    binary: str,
    plan: CapturePlan,
    work: Path,
    ffmpeg: str,
    progress: ProgressFn | None,
) -> dict[str, Any]:
    if progress:
        progress(5, "download")
    output = str(work / "%(id)s.%(ext)s")
    cmd = [
        binary,
        "--no-playlist",
        "--no-warnings",
        "-f",
        "bestaudio[ext=m4a]/bestaudio/best",
        "-x",
        "--audio-format",
        "mp3",
        "--audio-quality",
        "192",
        "--write-thumbnail",
        "--embed-metadata",
        "--ffmpeg-location",
        str(Path(ffmpeg).parent),
        "-o",
        output,
        "--print",
        "%(.{id,title,artist,uploader,album,duration,webpage_url})j",
        "--no-simulate",
        plan.target,
    ]
    try:
        result = subprocess.run(cmd, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or str(exc)).strip().splitlines()
        tail = detail[-1] if detail else str(exc)
        raise CaptureError("extract_failed", f"yt-dlp failed: {tail}") from exc
    if progress:
        progress(80, "encode")
    info: dict[str, Any] = {}
    for line in reversed((result.stdout or "").splitlines()):
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                info = parsed
                break
    return info


def _without_symbols(text: str) -> str:
    """Drop emoji and pictographs; YouTube search returns nothing for a query holding "⭐"."""
    kept = [
        " " if ch == "️" or unicodedata.category(ch) in {"So", "Sk", "Cs", "Co", "Cf"} else ch
        for ch in text
    ]
    return re.sub(r"\s+", " ", "".join(kept)).strip()


def _search_attempts(plan: CapturePlan, title: str | None) -> list[CapturePlan]:
    """The plan, then narrower searches for when artist + title finds nothing.

    A browser reports a YouTube channel ("Keshet 12 - ...") as the artist, and YouTube returns
    zero results for channel name + video title; the title alone, without emoji, finds the video.
    """
    attempts = [plan]
    if plan.engine != "youtube_search":
        return attempts
    title_text = (title or "").strip()
    seen = {plan.search_query}
    for query in (title_text, _without_symbols(title_text)):
        if query and query not in seen:
            seen.add(query)
            attempts.append(replace(plan, target=f"ytsearch1:{query}", search_query=query))
    return attempts


def _capture_remote(
    plan: CapturePlan,
    *,
    title: str | None,
    artist: str | None,
    album: str | None,
    source_app: str | None,
    progress: ProgressFn | None,
) -> CapturedTrack:
    ffmpeg = _require_ffmpeg()
    yt_dlp = _ytdlp_module()
    work = Path(tempfile.mkdtemp(prefix="gsv-capture-", dir=str(capture_dir())))
    try:
        if progress:
            progress(2, "extract")
        audio = None
        info: dict[str, Any] = {}
        for attempt in _search_attempts(plan, title):
            if yt_dlp is not None:
                info = _download_with_module(yt_dlp, attempt, work, ffmpeg, progress)
            else:
                info = _download_with_cli(_require_ytdlp_cli(), attempt, work, ffmpeg, progress)
            audio = _pick_audio_file(work)
            if audio is not None:
                break
        if audio is None:
            if plan.engine == "youtube_search":
                raise CaptureError(
                    "extract_failed",
                    f"YouTube search found no video for: {plan.search_query or title}",
                )
            raise CaptureError("extract_failed", "yt-dlp did not produce an audio file.")
        if audio.suffix.lower() != ".mp3":
            encoded = work / f"{audio.stem}.mp3"
            _encode_mp3(audio, encoded, ffmpeg, progress)
            audio = encoded
        dest = _copy_to_cache(audio, plan.cache_id, ".mp3")
        artwork_src = _pick_artwork(work)
        artwork_dest = None
        if artwork_src is not None:
            artwork_dest = _copy_to_cache(artwork_src, plan.cache_id, artwork_src.suffix.lower())
        info_title = str(info.get("title") or title or dest.stem)
        info_artist = (
            str(info.get("artist") or info.get("uploader") or artist or "").strip() or None
        )
        info_album = str(info.get("album") or album or "").strip() or None
        duration = info.get("duration")
        duration_ms = int(float(duration) * 1000) if isinstance(duration, (int, float)) else None
        webpage = str(info.get("webpage_url") or "").strip() or None
        if plan.youtube_id and not webpage:
            webpage = f"https://www.youtube.com/watch?v={plan.youtube_id}"
        if progress:
            progress(100, "done")
        return CapturedTrack(
            id=plan.cache_id,
            path=str(dest),
            title=info_title,
            artist=info_artist,
            album=info_album,
            engine=plan.engine,
            webpage_url=webpage,
            duration_ms=duration_ms,
            artwork_path=str(artwork_dest) if artwork_dest else None,
            bytes=dest.stat().st_size,
            cached=False,
            source_app=source_app,
            captured_at=_now_iso(),
        )
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _capture_local(
    plan: CapturePlan,
    *,
    title: str | None,
    artist: str | None,
    album: str | None,
    source_app: str | None,
    progress: ProgressFn | None,
) -> CapturedTrack:
    src = Path(plan.local_path or plan.target)
    if not src.is_file():
        raise CaptureError("local_missing", f"Local file is gone: {src}")
    if progress:
        progress(20, "copy")
    if src.suffix.lower() == ".mp3":
        dest = _copy_to_cache(src, plan.cache_id, ".mp3")
    else:
        ffmpeg = _require_ffmpeg()
        dest = capture_dir() / f"{plan.cache_id}.mp3"
        _encode_mp3(src, dest, ffmpeg, progress)
    if progress:
        progress(100, "done")
    return CapturedTrack(
        id=plan.cache_id,
        path=str(dest),
        title=(title or src.stem).strip() or src.stem,
        artist=(artist or "").strip() or None,
        album=(album or "").strip() or None,
        engine="local_file",
        webpage_url=None,
        duration_ms=None,
        artwork_path=None,
        bytes=dest.stat().st_size,
        cached=False,
        source_app=source_app,
        captured_at=_now_iso(),
    )


def _store(track: CapturedTrack) -> CapturedTrack:
    payload = _read_index()
    tracks = payload.setdefault("tracks", {})
    tracks[track.id] = track.to_json()
    payload["version"] = 1
    _write_index(payload)
    return track


def capture_track(
    *,
    query: str | None = None,
    title: str | None = None,
    artist: str | None = None,
    album: str | None = None,
    source_app: str | None = None,
    track_url: str | None = None,
    progress: ProgressFn | None = None,
    force: bool = False,
) -> CapturedTrack:
    plan = plan_capture(
        query=query,
        title=title,
        artist=artist,
        album=album,
        source_app=source_app,
        track_url=track_url,
    )
    if not force:
        cached = lookup_track(
            query=query,
            title=title,
            artist=artist,
            album=album,
            source_app=source_app,
            track_url=track_url,
        )
        if cached is not None:
            if progress:
                progress(100, "cache")
            return cached
    if plan.engine == "local_file":
        track = _capture_local(
            plan,
            title=title,
            artist=artist,
            album=album,
            source_app=source_app,
            progress=progress,
        )
    else:
        track = _capture_remote(
            plan,
            title=title,
            artist=artist,
            album=album,
            source_app=source_app,
            progress=progress,
        )
    return _store(track)


def handle_request(req: Mapping[str, Any], *, progress: ProgressFn | None = None) -> dict[str, Any]:
    """JSON in / JSON out for the sidecar and the one-shot CLI."""
    op = str(req.get("op") or "capture").strip().lower()
    query = str(req.get("query") or "").strip() or None
    title = str(req.get("title") or "").strip() or None
    artist = str(req.get("artist") or "").strip() or None
    album = str(req.get("album") or "").strip() or None
    source_app = str(req.get("sourceApp") or req.get("source_app") or "").strip() or None
    track_url = str(req.get("trackUrl") or req.get("track_url") or "").strip() or None
    force = bool(req.get("force"))
    try:
        if op in {"lookup", "status"}:
            found = lookup_track(
                query=query,
                title=title,
                artist=artist,
                album=album,
                source_app=source_app,
                track_url=track_url,
            )
            if found is None:
                return {"status": "miss", "track": None}
            return {"status": "ready", "track": found.to_json()}
        if op == "list":
            return {"status": "ok", "tracks": [item.to_json() for item in list_tracks()]}
        if op == "plan":
            planned = plan_capture(
                query=query,
                title=title,
                artist=artist,
                album=album,
                source_app=source_app,
                track_url=track_url,
            )
            return {
                "status": "ok",
                "engine": planned.engine,
                "target": planned.target,
                "id": planned.cache_id,
            }
        if op != "capture":
            return {"status": "error", "reason": f"unknown_op:{op}"}
        track = capture_track(
            query=query,
            title=title,
            artist=artist,
            album=album,
            source_app=source_app,
            track_url=track_url,
            progress=progress,
            force=force,
        )
        return {"status": "ready", "track": track.to_json()}
    except CaptureError as exc:
        return {"status": "error", "reason": exc.reason, "message": exc.message}


def emit_progress_stderr(pct: int, stage: str) -> None:
    sys.stderr.write(json.dumps({"gsvCapture": True, "progress": pct, "stage": stage}) + "\n")
    sys.stderr.flush()


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    flag = next((item for item in ("--capture", "--lookup", "--plan", "--list") if item in args), None)
    if flag is None:
        print("usage: track_capture.py --capture|--lookup|--plan|--list [JSON]", file=sys.stderr)
        return 2
    idx = args.index(flag)
    raw = args[idx + 1] if idx + 1 < len(args) and not args[idx + 1].startswith("-") else ""
    if not raw and flag != "--list":
        raw = sys.stdin.read()
    req: dict[str, Any] = json.loads(raw or "{}") if raw else {}
    if not isinstance(req, dict):
        print("capture request must be a JSON object", file=sys.stderr)
        return 2
    req["op"] = str(req.get("op") or "").strip() or flag.lstrip("-")
    progress = emit_progress_stderr if req["op"] == "capture" else None
    payload = handle_request(req, progress=progress)
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    return 0 if payload.get("status") != "error" else 1


if __name__ == "__main__":
    raise SystemExit(main())
