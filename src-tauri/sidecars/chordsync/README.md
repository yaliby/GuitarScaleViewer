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

One-shot lyric timing for a saved song (also `POST /lyrics` on the HTTP server):

`lyric_map.py --map '{"id":"meta-…","force":false}'` · `lyric_map.py --lookup '{"id":"meta-…"}'`

LRCLIB (through the resolver) gives the words, Whisper (`WhisperAsr`, the Play Along ear) hears
the whole file with word times, and an in-order alignment pairs them. Unheard words are placed
between heard neighbours or on the LRC line clock, moved onto the file by `lrc_offset_lock`.
With no lyrics online the map is the heard words; with no Whisper it is the LRC lines. The map is
saved as `<capture id>.lyrics.json` next to the MP3. Progress goes to stderr as
`{"gsvLyrics": true, "progress": n, "stage": "lyrics|decode|load|listen|align|done"}`; stdout
carries only the reply line.

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

Song capture encodes MP3 with FFmpeg. The desktop launcher downloads it into `.tools/ffmpeg` (or uses one already on PATH that includes `libmp3lame` and `ffprobe`). **yt-dlp** comes from `requirements.txt`. Audio files land in `~/.local/share/fretboard-studio/captures` (or `$GSV_CAPTURE_DIR`).
