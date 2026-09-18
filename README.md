# Guitar Scale Viewer

Desktop guitar scale and chord viewer (React + Tauri) that detects the musical key of whatever
is currently playing on the machine and highlights it on the fretboard.

## Layout

| Path | What it is |
|---|---|
| `src/` | React + Vite frontend (fretboard, chord library, key-resolution hooks) |
| `src-tauri/` | Rust backend: audio capture, OS now-playing metadata, key-detection engine |
| `src-tauri/sidecars/key_analyzer/` | Python analyzer sidecar (essentia, numpy fallback) |
| `src-tauri/sidecars/libkeyfinder_cli/` | Native libKeyFinder CLI — the **default** analyzer backend |
| `chordsync-api/` | Cloudflare Worker: verified key database + catalog lookups |

## Running it

```bash
# Linux / macOS
./dev.sh

# Windows
./dev.ps1
```

Both runners probe whichever analyzer backend is actually selected before starting, and refuse
to launch with none available. Set `ALLOW_DEGRADED_ANALYZER=1` to start anyway; the UI then
reports `analyzer_unavailable` and Apply stays disabled.

`dev.sh` also picks the first free port in 1420-1460 and hands the same number to both Vite and
the webview's `devUrl`, so a stale dev server left on 1420 neither blocks startup nor gets
loaded by mistake. Pin it with `GSV_DEV_PORT`.

Frontend only, without the desktop shell:

```bash
npm install
npm run dev
```

## Key detection backends

`KEY_ANALYZER_BACKEND` selects the analyzer:

- `libkeyfinder` (default) — native CLI. Build it once:
  ```bash
  ./src-tauri/sidecars/libkeyfinder_cli/build.sh
  ```
  `dev.sh` and the Rust engine both pick up `build/gsv-libkeyfinder-cli` automatically.
- `current` — the Python sidecar. Needs `numpy` at minimum; `essentia` is the preferred backend.
  Without either, key detection is unavailable and the app says so rather than guessing.

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `KEY_ANALYZER_BACKEND` | `libkeyfinder` or `current` | `libkeyfinder` |
| `KEY_ANALYZER_PYTHON` | Interpreter for the sidecar | `python3` (`py` on Windows) |
| `KEY_ANALYZER_SIDECAR` | Explicit path to `key_analyzer.py` or a frozen binary | auto-discovered |
| `KEY_ANALYZER_LIBKEYFINDER_CLI` | Explicit path to the native CLI | auto-discovered |
| `KEY_ANALYZER_WSL_PYTHON`, `KEY_ANALYZER_WSL_SIDECAR`, `KEY_ANALYZER_LIBKEYFINDER_WSL_CLI` | Run the analyzer under WSL from a Windows host | unset |
| `KEY_ANALYZER_AB` | Run two backends side by side and emit `detected-key-ab-update` | unset |
| `ALLOW_DEGRADED_ANALYZER` | Let `dev.sh`/`dev.ps1` start without an analyzer backend | `0` |
| `GSV_LOG_DIR` | Where the Rust side writes logs | `logs/` |

Worker secrets live in `chordsync-api/.dev.vars` — see `.dev.vars.example`.

## Tests and checks

```bash
npm run typecheck && npm test && npx vite build      # frontend
cd chordsync-api && npm run typecheck && npm test    # Worker
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings
cd src-tauri && cargo test -- --ignored              # key fixture regression (needs numpy + wav fixtures)
```

`.github/workflows/ci.yml` runs all of the above plus the cross-boundary contracts
(ACL, Tauri event names, `frontendDist` vs the Vite output, sidecar JSON protocol).

`QUALITY_GATE.md` is the full manual QA checklist and the open-defect register.
