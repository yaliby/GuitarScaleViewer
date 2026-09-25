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
