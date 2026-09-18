# Key analyzer sidecar

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
- Uses Essentia when installed, otherwise uses the packaged NumPy analyzer on Windows. NumPy estimates may follow music in Live Jam after native reliability checks and three fresh eligible revisions over at least six seconds. They do not automatically change the practice setup.

## Generic pitch and key analysis

The NumPy path uses interpolated spectral peaks, spectral-envelope whitening,
36-bin harmonic pitch features and bounded tuning correction. Insufficient tonal
coverage and unpitched frames contribute no evidence. Both independent key
profiles score all 24 major/minor keys using identical rules for every root.
Window responses retain optional `candidates` (`key`, `scale`, `score`) and
`tuningCents`; scores are descriptive fits, not probabilities. Native consensus
compares candidates and tracks absolute captured sample positions so rescanning
the same audio cannot grow confidence. Library matches seed the display without
stopping local analysis of later key changes.

Run `python -m unittest discover -s src-tauri/sidecars/key_analyzer -p 'test_*.py'`
with the analyzer virtual environment. `benchmark_accuracy.py --output report.json`
measures synthetic DSP accuracy and scan time; it does not measure real-song
success rates or end-to-end desktop latency. `export_consensus_fixtures.py`
regenerates the all-key spectral inputs used by native consensus tests.

## Production note

Run `./setup-native.ps1` at the project root to build the standalone analyzer with its Python/NumPy runtime. Tauri bundles that directory as `analyzer` resources; installed applications resolve it through Tauri's resource directory. `KEY_ANALYZER_SIDECAR` is an optional explicit override.

Startup has a 10-second deadline and responses an 8-second deadline. Failed workers are killed and reaped, and the next engine cycle can restart them. The application also closes workers on normal exit. See [Windows setup](../../../docs/NATIVE_SETUP.md) for commands and fixture limitations.
