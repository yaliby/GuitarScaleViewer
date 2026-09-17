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
2. Open **Live Jam**, turn **Follow music** on, and leave **Hold this key** off.
3. Let the music play while the app collects enough audio. Detection is not
   immediate: a new track needs a sustained passage, and a key change requires
   repeated fresh evidence before the fretboard switches.
4. Enable **Chords & shapes** to see compatible chord suggestions. Use **Hold
   this key** to keep the current key, or the sliders beside the map to choose a
   key manually. Manual selection pauses automatic following; turn **Follow
   music** back on to resume it.

If detection is uncertain, the app explains its status and may offer **Try
[key]** buttons. The practice tools also work with a manually chosen key.

## Practice tools

- An interactive fretboard with note or interval labels, root and triad filters, and 16 tunings with capo support.
- Five pentatonic boxes, five CAGED major shapes in standard tuning, and seven three-notes-per-string positions for seven-note scales.
- Click or keyboard-activate notes to hear them. Play ascending, descending, or returning scale exercises with looping, a metronome, and adjustable tempo and volume.
- Explore playable chord voicings and build progressions. Playback highlights the active chord and its notes on the fretboard.
- Save named practice setups and restore your last session automatically on the same device.
- Follow Windows media metadata and review local key suggestions. Lock the practice key while a song continues playing.
- **Live Jam:** a dedicated listening deck that follows a settled song key across all 24 frets, with optional compatible chords, selectable shapes, note audition, key hold, manual overrides, and a per-track key journey. Its key, tuning and capo do not overwrite your practice setup.

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

In **Live Jam**, start music in a desktop player and leave **Follow music** enabled. Verified library matches can initialize the key immediately while audio analysis continues. Local estimates must pass native stability, silence, ambiguity and consistency gates, then persist across three fresh revisions over at least six seconds. Sustained key changes update the fretboard and chord ideas together; the current key remains visible while a new one is being compared. Analysis needs a stretch of music; it is not instant chord recognition. The full scale stays visible, and **Chords & shapes** reveals diatonic suggestions with playable voicings. Use **Hold this key**, or open the sliders beside the map to choose a key, tuning and capo. **Fretboard focus** hides the listening deck to leave more space for the neck. In a browser, choose a key manually; desktop audio capture requires the Windows app.

The bundled Windows analyzer can be uncertain, especially between relative major and minor keys. Live Jam labels local results as estimates, and compatible chords are suggestions rather than a transcription of the song. Its separate follow policy does not automatically change the practice key. Explore's stricter automatic path still requires a ready, unambiguous result from a supported analyzer or a validated cloud match. The practice lock prevents either from changing your practice context. Live Jam's key journey and display controls last for the current workspace visit.

Cloud lookup and user-submitted corrections require a configured backend. Source fixes and setup instructions are in [chordsync-api](chordsync-api/README.md); changing this repository does not deploy that service. Corrections are submitted only when you click the suggestion button.

## Checks

```powershell
npm test
npm run build
npm run test:e2e
powershell -ExecutionPolicy Bypass -File ./dev.ps1 -Test
```

Browser tests use installed Google Chrome. Worker tests run separately with `npm test` in `chordsync-api`. Native fixture tests can be enabled with `RUN_KEY_FIXTURES=1`; details are in the Windows setup guide.

The original audit is recorded in [the project review](docs/PROJECT_REVIEW.md).
The latest detection checks and limitations are documented in
[key accuracy results](docs/KEY_ACCURACY_RESULTS.md).
