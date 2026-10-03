# Windows desktop setup

Use Windows 10/11 x64 with WebView2, Visual Studio 2022 C++ desktop build tools, Node.js, and Python 3.13. Python is needed to build the analyzer; the distributed desktop app includes its own runtime.

From the project directory:

```powershell
./setup-native.ps1  # Project-local Rust, Python environment and standalone analyzer
./dev.ps1          # Desktop development; starts Vite and one application window
./dev.ps1 -Test    # Rust tests, all audio fixtures, Python and packaged analyzer checks
./dev.ps1 -Build   # Frontend, release application and NSIS installer
```

The setup script uses `.tools/cargo`, `.tools/rustup` and `.tools/analyzer-venv`; it does not modify the global PATH or install WSL. Install Microsoft's C++ build tools separately if absent. The first Cargo build downloads its dependencies and may take several minutes.

Play Along and song memory use a separate environment at `src-tauri/sidecars/chordsync/.venv`. `dev.ps1` creates it (or `./setup-native.ps1 -ChordSyncOnly`) and sets `CHORDSYNC_PYTHON` to `Scripts\python.exe`. That install includes `rapidfuzz` from `src-tauri/sidecars/chordsync/requirements.txt`. The analyzer venv does not, and pointing ChordSync at it fails at startup.

Play Along times lyrics by ear. A ChordSync checkout next to this one supplies its own engine and wins; otherwise the vendored `chordsync/live` package carries one: WASAPI loopback on Windows (Linux: the PulseAudio/PipeWire monitor through `parec`) of the default speakers (`soundcard`), faster-whisper with word times (CUDA through the `nvidia-cublas-cu12` / `nvidia-cudnn-cu12` wheels when an NVIDIA GPU is present, int8 on the CPU otherwise), and LocalAgreement between passes. `dev.ps1` installs `requirements-windows-live.txt` (plus `requirements-windows-cuda.txt` when `nvidia-smi` exists) into the ChordSync venv and downloads both Whisper models once (about 1.6 GB each). On Windows only (`follow_session._EAR_EVERYWHERE`), the ear times every song with synced lyrics without waiting for captions, keeps listening after it locks, and re-checks a remembered offset, moving it on a firm lock at least 2.5 s away. Measured on an RTX 3060 Laptop GPU: a 20 s Whisper pass takes about 0.5 s; a Top of the Pops upload of Killer Queen locked at +5.0 s about 12 s after the first sung line. Silero VAD stays off because it removed most of a sung verse over a full band.

Saving a captured song encodes MP3 with FFmpeg. `dev.ps1` downloads a GPL build into `.tools/ffmpeg` when `ffmpeg.exe` and `ffprobe.exe` are not already there, and puts that directory on `PATH` for Vite and Tauri. The binary is not part of the git checkout.

Keep the Tauri npm API/CLI and Rust runtime in the same 2.10 minor-version family. Their manifest ranges are constrained to this family so an unrelated dependency refresh does not break desktop packaging.

The analyzer is packaged as a PyInstaller directory in `src-tauri/sidecars/key_analyzer/dist/key_analyzer`. Tauri includes this directory under `analyzer` in its resource directory. Discovery first honors `KEY_ANALYZER_SIDECAR`, then uses Tauri's resource directory, followed by development paths. The installed application does not depend on the working directory or a developer's Python/WSL paths.

`KEY_ANALYZER_BACKEND=libkeyfinder` remains available when explicitly paired with `KEY_ANALYZER_LIBKEYFINDER_CLI`; Essentia is used when available in a configured Python environment. Neither is downloaded by normal startup. Experimental A/B analysis is off by default.

The bundled NumPy backend supports conservative estimate following in Live Jam;
automatic changes to the separate practice setup remain disabled for its audio
results. Live Jam requires native reliability checks and three fresh eligible
revisions over at least six seconds. Verified database results can initialize the
display while local capture continues to follow sustained key changes. A stable
sequence is not proof of a song's key, and synthesized fixtures are not a
representative music benchmark. Manual practice and playback work without an
analyzer or network connection.

Analyzer checks:

```powershell
./.tools/analyzer-venv/Scripts/python.exe -m unittest discover -s src-tauri/sidecars/key_analyzer -p test_analyzer.py
./.tools/analyzer-venv/Scripts/python.exe src-tauri/sidecars/key_analyzer/fixture_report.py
```

The fixture report records every manifest entry and candidate vote shares in `src-tauri/tests/windows_analyzer_report.json`. Those shares describe agreement, not calibrated probabilities. Native readiness, timeout behavior, and actual audio prediction are verified separately.
