# Fretboard Studio

A Windows guitar practice app built from GuitarScaleViewer. Explore scales across the neck, hear the notes, practice positions at a steady tempo, and connect scales to chord progressions.

This is a development version. Automatic key detection is still being improved;
local results are estimates, and the suggested chords are compatible ideas rather
than a transcription of the song.

## Quick start: run the Windows app

Use the desktop app for automatic listening to music playing on your PC.

### 1. Install the prerequisites

- **Git** to clone this repository.
- **Node.js 22.12 or newer**, including npm.
- **Python 3.13**, with the `python` command available in PowerShell. The first
  setup uses it to create an isolated environment for the audio analyzer.
- **Visual Studio 2022 Build Tools** or Visual Studio 2022 with the **Desktop
  development with C++** workload, including the MSVC toolchain and a Windows SDK.
- **Microsoft Edge WebView2 Runtime**, normally already installed on Windows 11.

Open a new PowerShell window after installing these tools. These commands should
print installed versions:

```powershell
git --version
node --version
npm.cmd --version
python --version
```

### 2. Download and launch

```powershell
git clone https://github.com/yaliby/GuitarScaleViewer.git
cd GuitarScaleViewer
npm.cmd ci
npm.cmd run desktop
```

The first launch downloads and prepares a project-local Rust toolchain and Python
analyzer under `.tools`, then compiles and opens **Fretboard Studio**. Internet
access is needed for setup; the initial native build can take several minutes.
The app does not require WSL.

For later launches, open PowerShell in the project folder and run:

```powershell
npm.cmd run desktop
```

Keep that terminal open while using the development app. Press **Ctrl+C** when
you want to stop the development process.

### 3. Listen and play along

1. Play music on the **same Windows PC**, for example in Spotify or a browser.
   The app captures computer playback, not music playing independently on a phone.
2. Open **Live Jam**, turn **Follow the song** on, and leave **Lock** off.
3. Let the music play while the app collects enough audio. Detection is not
   immediate: a new track needs a sustained passage before a key is worth acting
   on.
4. The **chord bank** below the neck holds every shape that lives in the key.
   Use **Apply** to take a detection by hand, **Lock** to freeze the current
   reading, or the setup row above the neck to choose a key, tuning and capo.

If detection is uncertain, the deck says so and leaves the neck alone. The
practice tools also work with a manually chosen key.

## Practice tools

- An interactive fretboard with note or interval labels, root and triad filters, and 16 tunings with capo support.
- Five pentatonic boxes, five CAGED major shapes in standard tuning, and seven three-notes-per-string positions for seven-note scales.
- Click or keyboard-activate notes to hear them. Play ascending, descending, or returning scale exercises with looping, a metronome, and adjustable tempo and volume.
- Explore playable chord voicings and build progressions. Playback highlights the active chord and its notes on the fretboard.
- Save named practice setups and restore your last session automatically on the same device.
- Follow Windows media metadata and review local key suggestions. Lock the practice key while a song continues playing.
- **Live Jam:** the full-window neck — all 24 frets, a listening deck, the chord bank for the current key, and its own setup row — with the navigation folded into the hamburger menu. It plays the same key, tuning and capo as the rest of the workspace, so a key you land on here is the key you practice.

The interface supports smaller screens, keyboard navigation, and the operating system's reduced-motion preference. Audio starts only after interaction. Practice sounds use synthesized tones.

## Run the practice tools in a browser

After cloning the repository, run these commands from its folder:

```powershell
npm.cmd ci
npm.cmd run dev
```

Open the address printed by Vite. All practice tools work in the browser; Windows system audio and media detection require the desktop app.

## Build a Windows installer

With the prerequisites and npm dependencies installed, run from the project folder:

```powershell
npm.cmd run desktop:build
```

This builds the native release and installer, including the standalone analyzer:

```text
src-tauri/target/release/app.exe
src-tauri/target/release/bundle/nsis/Fretboard Studio_0.1.0_x64-setup.exe
```

Use the installer when distributing the app to another Windows computer; copying
only `app.exe` can omit the analyzer resources. Installed builds do not need Node,
Python, Rust, or WSL, but do need WebView2. This repository contains source code;
the commands above create the installer locally.

## Run the desktop app on Linux or macOS

```bash
./dev.sh
```

`dev.sh` probes whichever analyzer backend is selected before starting and refuses to launch
with none available. Set `ALLOW_DEGRADED_ANALYZER=1` to start anyway; the UI then reports
`analyzer_unavailable` and Apply stays disabled. It also picks the first free port in
1420-1460 and hands the same number to both Vite and the webview's `devUrl`, so a stale dev
server neither blocks startup nor gets loaded by mistake. Pin it with `GSV_DEV_PORT`.

Linux now-playing metadata comes from MPRIS and audio capture from PulseAudio, mirroring the
GSMTC/WASAPI path on Windows.

## Repository layout

| Path | What it is |
|---|---|
| `src/` | React + Vite frontend (Studio shell, fretboard, chord library, key-resolution hooks) |
| `src/LiveJamScreen.tsx` | Live Jam: the detailed neck chassis, driven by the workspace's shared session |
| `src-tauri/` | Rust backend: audio capture, OS now-playing metadata, key-detection engine |
| `src-tauri/sidecars/key_analyzer/` | Python analyzer sidecar (essentia, numpy fallback) |
| `src-tauri/sidecars/libkeyfinder_cli/` | Native libKeyFinder CLI analyzer backend |
| `chordsync-api/` | Cloudflare Worker: verified key database + catalog lookups |

## Key detection backends

`KEY_ANALYZER_BACKEND` selects the analyzer:

- `libkeyfinder` — native CLI. Build it once:
  ```bash
  ./src-tauri/sidecars/libkeyfinder_cli/build.sh
  ```
  `dev.sh` and the Rust engine both pick up `build/gsv-libkeyfinder-cli` automatically.
- `current` — the Python sidecar. Needs `numpy` at minimum; `essentia` is the preferred
  backend. Without either, key detection is unavailable and the app says so rather than
  guessing.

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

## Troubleshooting startup

- **`npm` is blocked by PowerShell policy:** use `npm.cmd`, as in the commands above.
- **`python` is not found or opens the Microsoft Store:** install Python 3.13,
  ensure it is on PATH, and reopen PowerShell before retrying.
- **`link.exe` or Windows SDK errors:** install the Visual Studio C++ workload
  and Windows SDK, then reopen PowerShell.
- **Audio detection is unavailable in the browser:** launch with
  `npm.cmd run desktop`; browser mode supports manual practice, not Windows
  playback capture.
- **Song title appears but no key is accepted:** keep music playing and check
  Live Jam's listening status. A title match alone does not establish the key;
  choose a suggested or manual key if the audio remains ambiguous.

See [Windows setup](docs/NATIVE_SETUP.md) for additional native diagnostics.

## Key detection

In **Live Jam**, start music in a desktop player and turn **Follow the song** on. A verified library row is worth 100% and applies immediately; an unverified catalog hit is worth 70% and proposes rather than overrules; a local estimate is worth its own confidence, and nothing at all while the engine calls it ambiguous. Only a key worth at least the auto-apply threshold (85% by default) moves the neck unattended — everything else waits for **Apply**. Analysis needs a stretch of music; it is not instant chord recognition. **Lock** freezes the current reading, **Reset** clears the detector, and the setup row above the neck always overrides both. In a browser, choose a key manually; desktop audio capture requires the Windows app.

The bundled analyzer can be uncertain, especially between relative major and minor keys. The deck labels local results as estimates, and the chord bank offers shapes that fit the key rather than a transcription of the song. Explore's separate automatic path still requires a ready, unambiguous result from a supported analyzer or a validated cloud match, and the practice lock prevents it from changing your practice context.

Cloud lookup and user-submitted corrections require a configured backend. Source fixes and setup instructions are in [chordsync-api](chordsync-api/README.md); changing this repository does not deploy that service. Corrections are submitted only when you click the suggestion button.

## Checks

```powershell
npm test
npm run build
npm run test:e2e
powershell -ExecutionPolicy Bypass -File ./dev.ps1 -Test
```

Per boundary, on any platform:

```bash
npm run typecheck && npm test && npx vite build      # frontend
cd chordsync-api && npm run typecheck && npm test    # Worker
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings
cd src-tauri && cargo test -- --ignored              # key fixture regression (needs numpy + wav fixtures)
```

`.github/workflows/ci.yml` runs all of the above plus the cross-boundary contracts
(ACL, Tauri event names, `frontendDist` vs the Vite output, sidecar JSON protocol).
`QUALITY_GATE.md` is the manual QA checklist and the open-defect register.

Browser tests use installed Google Chrome. Worker tests run separately with `npm test` in `chordsync-api`. Native fixture tests can be enabled with `RUN_KEY_FIXTURES=1`; details are in the Windows setup guide.

The original audit is recorded in [the project review](docs/PROJECT_REVIEW.md).
The latest detection checks and limitations are documented in
[key accuracy results](docs/KEY_ACCURACY_RESULTS.md).
