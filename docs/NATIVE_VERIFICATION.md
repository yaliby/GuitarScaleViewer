# Native verification — 2026-09-14

Machine: Windows 11 x64; Visual Studio 2022 Community C++ toolchain and WebView2 already present. Installed Rust 1.98.1 in project-local `.tools/cargo`/`.tools/rustup`, and Python 3.13 analyzer dependencies in `.tools/analyzer-venv`. No WSL installation or global PATH change.

Verified checks:

- Rust unit regressions cover supported-backend readiness, sufficient audio, ambiguity, contradiction, silence, stable hold, cloud eligibility, flat accidentals, usable NumPy health, and bounded sidecar startup/responses/CLI execution.
- Windows media metadata requests have a two-second deadline shared by the engine, event poller and command. A delayed future regression confirms unavailable status and cancellation; timely metadata is preserved. Shutdown has a final twenty-second limit for unexpected synchronous OS stalls, in addition to the shorter normal operation deadlines.
- The Rust audio-fixture regression ran with `RUN_KEY_FIXTURES=1`; all six manifest entries passed. These refer to five unique synthesized recordings. Detailed NumPy candidates and vote shares are in `src-tauri/tests/windows_analyzer_report.json`.
- NumPy regressions verify silence, non-inflated flat-chroma scores, a known major profile and independent profile votes. Unsupported Essentia profiles no longer duplicate the same Krumhansl vote.
- The standalone packaged analyzer ran from an unrelated temporary directory, with no system Python invocation. Its twelve profile/window predictions on the D-major fixture were D major.
- Real Windows endpoint loopback captured 131,705 samples at 44.1 kHz from a quiet three-second test tone; peak amplitude was 0.027169. The explicit `capture_smoke` example plays the tone, checks the capture buffer, stops the worker, and removes its temporary tone file. Captured system audio stays in memory.
- Optimized Rust desktop executable compiled successfully. Bundled analyzer resources appear next to it under `analyzer/`.

Reproduce the full automated native/analyzer suite with `./dev.ps1 -Test`. Run the explicit audible hardware check with the project-local Cargo environment configured, then `cargo run --manifest-path src-tauri/Cargo.toml --example capture_smoke`.

The bundled NumPy analyzer remains suggestion-only for automatic changes to the practice setup. Live Jam has a separate estimate-follow policy: native stable evidence produces a dedicated marker without enabling practice `readyToApply`; the UI requires three fresh eligible revisions over at least six seconds. Agreement on synthetic fixtures is not a real-music accuracy benchmark or calibrated probability. Process-specific application capture and a broad range of sound hardware were not tested. Verified cloud results can seed a track while local analysis continues. Live cloud/database behavior is outside these native checks. See [the latest key accuracy results](KEY_ACCURACY_RESULTS.md) for the generic analyzer, modulation and fresh-evidence verification that supersedes the earlier counts above.

The controller performs the final build and visible application smoke test after frontend acceptance, so that the delivered executable contains the reviewed interface.
