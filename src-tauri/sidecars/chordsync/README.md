# ChordSync play-along sidecar

Thin adapter. It imports the live ChordSync package from the sibling checkout
(`../ChordSync`) when present, otherwise the vendored copy next to this file.
Resolve, clock, LRC offset, and lyric-to-chart matching are ChordSync's modules.
The React screen only paints what those modules return.

## Protocol

`chordsync_sidecar.py --serve`

- First stdout line: `{ "ready": true, "readyReason": "ok", "packageRoot": "..." }`
- Then one JSON request per stdin line, one JSON response per stdout line.

Requests:

- `{ "op": "ping" }`
- `{ "op": "resolve", "title", "artist", "album", "durationMs", "sourceApp" }`
- `{ "op": "follow", "positionMs", "durationMs", "playing", "playbackStatus", "sourceApp" }`
- `{ "op": "capture"|"lookup"|"list"|"plan", "query", "title", "artist", "album", "sourceApp", "trackUrl" }`
- `{ "op": "memory", "action": "get"|"remember_scale"|"remember_chords"|"list_chords", "title", "artist" }`

Song memory is a JSON file (`~/.local/share/fretboard-studio/song-memory.json`, or `$GSV_SONG_MEMORY`), not a database. A found chord page is reused. Lyric timing is written once captions or ear-lock succeed, and the next resolve restores that clock instead of searching again.

One-shot capture (does not hold the play-along worker):

`chordsync_sidecar.py --capture '{"title":"Numb","artist":"Linkin Park"}'`

HTTP: `--http 127.0.0.1:18766` with `POST /resolve` and `POST /follow`.

## Setup

Use the sibling ChordSync venv (already has rapidfuzz and the rest):

```bash
export CHORDSYNC_ROOT=/path/to/ChordSync
export CHORDSYNC_PYTHON=$CHORDSYNC_ROOT/.venv/bin/python
```

Fallback local venv:

```bash
python3 -m venv src-tauri/sidecars/chordsync/.venv
src-tauri/sidecars/chordsync/.venv/bin/pip install -r src-tauri/sidecars/chordsync/requirements.txt
```

Windows (`dev.ps1` does this and exports `CHORDSYNC_PYTHON`):

```powershell
./setup-native.ps1 -ChordSyncOnly
# src-tauri/sidecars/chordsync/.venv/Scripts/python.exe
```

That environment is not the key-analyzer venv. ChordSync needs `rapidfuzz` from `requirements.txt`.

Song capture also needs **FFmpeg** on PATH and **yt-dlp** (pulled in by that requirements file). Audio files land in `~/.local/share/fretboard-studio/captures` (or `$GSV_CAPTURE_DIR`).
