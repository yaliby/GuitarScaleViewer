"""Split a saved song into the singer and everything else, for the sheet's singer slider.

``stem_split.py --stems '{"id": ..., "force": false}'`` writes ``<id>.vocals.mp3`` and
``<id>.instrumental.mp3`` next to the capture (same length as the song, so the two play back in
step) and prints one JSON line. Demucs does the work through ``vocal_stem``, so it uses the GPU
when there is room and gives way to the host the same as lyric mapping does.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

SIDECAR_DIR = Path(__file__).resolve().parent
if str(SIDECAR_DIR) not in sys.path:
    sys.path.append(str(SIDECAR_DIR))

import hw_profile  # noqa: E402

# Before numpy / torch load: they read the thread environment at import.
hw_profile.apply_process_policy()

import numpy as np  # noqa: E402

from track_capture import capture_dir, get_track, resolve_ffmpeg  # noqa: E402

_BITRATE = "192k"


def stem_paths(track_id: str) -> tuple[Path, Path]:
    base = capture_dir()
    return base / f"{track_id}.instrumental.mp3", base / f"{track_id}.vocals.mp3"


def _current(paths: tuple[Path, Path], audio: Path) -> bool:
    try:
        stamp = audio.stat().st_mtime
        return all(p.is_file() and p.stat().st_size > 0 and p.stat().st_mtime >= stamp for p in paths)
    except OSError:
        return False


def _encode_mp3(ffmpeg: str, samples: np.ndarray, target: Path) -> None:
    """``samples`` is float32 (2, n) at 44.1 kHz. Written beside the target, then moved into place."""
    pcm = (np.clip(samples, -1.0, 1.0).T * 32767.0).astype("<i2")
    partial = target.with_name(target.name + ".part")
    command = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "s16le", "-ar", "44100", "-ac", "2", "-i", "-",
        "-c:a", "libmp3lame", "-b:a", _BITRATE, "-f", "mp3", str(partial),
    ]  # fmt: skip
    flags = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW
    done = subprocess.run(command, input=pcm.tobytes(), capture_output=True, creationflags=flags)
    if done.returncode != 0:
        partial.unlink(missing_ok=True)
        raise RuntimeError(done.stderr.decode("utf-8", "replace").strip() or "ffmpeg failed")
    os.replace(partial, target)


def emit(pct: int, stage: str) -> None:
    sys.stderr.write(json.dumps({"gsvStems": True, "progress": int(pct), "stage": stage}) + "\n")
    sys.stderr.flush()


def handle(req: dict, *, progress: bool) -> dict:
    track_id = str(req.get("id") or "")
    track = get_track(track_id) if track_id else None
    if track is None:
        return {"status": "error", "message": "That song is not saved."}
    audio = Path(track.path)
    instrumental, vocals = paths = stem_paths(track_id)
    cached_only = bool(req.get("cachedOnly"))
    if not req.get("force") and _current(paths, audio):
        return {"status": "ready", "instrumentalPath": str(instrumental), "vocalsPath": str(vocals)}
    if cached_only:
        return {"status": "miss"}
    ffmpeg = resolve_ffmpeg()
    if ffmpeg is None:
        return {"status": "error", "message": "FFmpeg is missing, so the singer cannot be separated."}
    try:
        from vocal_stem import split_stems

        say = (lambda frac: emit(2 + int(88 * frac), "separate")) if progress else None
        if progress:
            emit(1, "start")
        voice, rest = split_stems(str(audio), on_progress=say)
        if progress:
            emit(92, "save")
        _encode_mp3(ffmpeg, rest, instrumental)
        _encode_mp3(ffmpeg, voice, vocals)
    except ImportError as exc:
        return {"status": "error", "message": f"Demucs is not installed ({exc})."}
    except Exception as exc:  # a failed song must not take the app down
        return {"status": "error", "message": f"Could not separate the singer: {exc}"}
    return {"status": "ready", "instrumentalPath": str(instrumental), "vocalsPath": str(vocals)}


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if "--stems" not in args:
        print("usage: stem_split.py --stems JSON", file=sys.stderr)
        return 2
    idx = args.index("--stems")
    raw = args[idx + 1] if idx + 1 < len(args) else ""
    req = json.loads(raw or sys.stdin.read() or "{}")
    reply = sys.stdout
    reply.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")  # type: ignore[attr-defined]
    sys.stdout = sys.stderr  # library chatter must not become the reply
    try:
        payload = handle(req, progress=not req.get("cachedOnly"))
    finally:
        sys.stdout = reply
    reply.write(json.dumps(payload, ensure_ascii=False) + "\n")
    reply.flush()
    return 0 if payload.get("status") != "error" else 1


if __name__ == "__main__":
    raise SystemExit(main())
