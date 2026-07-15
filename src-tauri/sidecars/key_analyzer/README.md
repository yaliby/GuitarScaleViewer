# Key Analyzer Sidecar (Essentia)

This sidecar is the analysis boundary for phase 1 key detection.

## Why sidecar

- Keeps DSP dependencies isolated from the Tauri binary.
- Allows upgrading/replacing analyzer without touching Rust capture/consensus logic.
- Supports strict JSON contracts for observability and testing.

## Current mode

- Persistent mode (preferred): `key_analyzer.py --serve`
  - One JSON request per line on stdin
  - One JSON response per line on stdout
  - Reused by the Rust backend across multiple analysis cycles
- One-shot mode (fallback/diagnostic): `key_analyzer.py --analyze`
- Uses Essentia if available, otherwise falls back to `librosa` (recommended for Windows).

## Production note

For production Windows packaging, provide a compiled executable and set:

`KEY_ANALYZER_SIDECAR=<absolute_path_to_executable>`

The Rust engine defaults to:

- `sidecars/key_analyzer/key_analyzer.exe` (if present), or
- Python script `sidecars/key_analyzer/key_analyzer.py` launched with `py`.
