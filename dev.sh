#!/usr/bin/env bash
# Dev runner: Vite + Tauri + Python analyzer sidecar (Linux/macOS).
#
# The Linux equivalent of dev.ps1. It checks the analyzer sidecar the same way, exports the
# same env vars so Rust finds the sidecar regardless of cwd, and then hands off to Tauri.
#
# Analyzer strictness (matches dev.ps1):
#   ALLOW_DEGRADED_ANALYZER=1   start anyway when no analyzer backend is available
#                               (the UI reports analyzer_unavailable and Apply stays disabled)
#
# Analyzer backend switch:
#   KEY_ANALYZER_BACKEND=libkeyfinder  (default) native CLI, see sidecars/libkeyfinder_cli/build.sh
#   KEY_ANALYZER_BACKEND=current       python analyzer sidecar (essentia, numpy fallback)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$root"

log_dir="$root/logs"
mkdir -p "$log_dir"
export GSV_LOG_DIR="$log_dir"

: "${ALLOW_DEGRADED_ANALYZER:=0}"
: "${KEY_ANALYZER_PYTHON:=python3}"
backend="${KEY_ANALYZER_BACKEND:-libkeyfinder}"

sidecar="$root/src-tauri/sidecars/key_analyzer/key_analyzer.py"
if [[ ! -f "$sidecar" ]]; then
  echo "dev.sh: analyzer sidecar not found at $sidecar" >&2
  exit 1
fi
export KEY_ANALYZER_SIDECAR="$sidecar"

# Auto-wire the libkeyfinder CLI when it has been built, so the default backend is real.
lkf="${KEY_ANALYZER_LIBKEYFINDER_CLI:-$root/src-tauri/sidecars/libkeyfinder_cli/build/gsv-libkeyfinder-cli}"

analyzer_ok=0

# Bring the CLI up to date with its source before probing it. An edit to main.cpp or the chord
# front end does nothing until the binary is rebuilt, and nothing downstream can tell: on
# 2026-09-23 the source, the docs and every fitted constant described the separated front end
# while the app went on running a binary built six hours before it. The build is incremental, so
# when nothing changed this costs a make that finds nothing to do.
lkf_build_dir="$root/src-tauri/sidecars/libkeyfinder_cli/build"
if [[ "$backend" == "libkeyfinder" && -z "${KEY_ANALYZER_LIBKEYFINDER_CLI:-}" ]] \
    && command -v cmake >/dev/null 2>&1; then
  # Zero-byte stand-ins for the bundled resources (tauri.conf.json lists both files) are newer than
  # the sources, so make calls them up to date and never links a real binary over them.
  for f in "$lkf_build_dir/gsv-libkeyfinder-cli" "$lkf_build_dir/libkeyfinder.so.2"; do
    if [[ -f "$f" && ! -s "$f" ]]; then rm -f "$f"; fi
  done
  if [[ -f "$lkf_build_dir/CMakeCache.txt" && -f "$lkf_build_dir/libkeyfinder.so.2" ]]; then
    if ! cmake --build "$lkf_build_dir" --parallel >/dev/null; then
      echo "dev.sh: rebuilding the libkeyfinder CLI failed; probing whatever binary is there." >&2
    fi
  else
    # Never configured on this machine (or the build dir came from another OS): run the full build,
    # which also bundles libkeyfinder.so.2 next to the binary.
    echo "dev.sh: building the libkeyfinder CLI..."
    if ! bash "$root/src-tauri/sidecars/libkeyfinder_cli/build.sh" >/dev/null; then
      echo "dev.sh: building the libkeyfinder CLI failed; see sidecars/libkeyfinder_cli/build.sh" >&2
    fi
  fi
fi

# Probe the backend that will actually be used. Probing Python while Rust runs libkeyfinder
# is how this gate used to refuse to start on a machine whose default backend worked fine.
if [[ "$backend" == "libkeyfinder" ]]; then
  echo "dev.sh: probing libkeyfinder CLI at $lkf ..."
  if [[ ! -x "$lkf" ]]; then
    echo "dev.sh: libkeyfinder CLI not built." >&2
    echo "dev.sh:   ./src-tauri/sidecars/libkeyfinder_cli/build.sh" >&2
  else
    # Exit 3 is the CLI's own "open_failed" for a missing input, which only happens once the
    # binary has loaded and run -- so it proves the shared libraries resolve, without a fixture.
    set +e
    "$lkf" /nonexistent-probe.wav >/dev/null 2>&1
    probe_rc=$?
    set -e
    if [[ "$probe_rc" -eq 3 ]]; then
      export KEY_ANALYZER_LIBKEYFINDER_CLI="$lkf"
      echo "dev.sh: libkeyfinder CLI ready"
      analyzer_ok=1
    else
      echo "dev.sh: libkeyfinder CLI present but not runnable (exit $probe_rc)." >&2
      echo "dev.sh:   ldd $lkf   # check for missing shared libraries" >&2
    fi
  fi
fi

# The Python sidecar is the selected backend under KEY_ANALYZER_BACKEND=current, and a
# fallback worth reporting either way.
if [[ "$analyzer_ok" -eq 0 ]]; then
  if ! command -v "$KEY_ANALYZER_PYTHON" >/dev/null 2>&1; then
    echo "dev.sh: '$KEY_ANALYZER_PYTHON' not on PATH (set KEY_ANALYZER_PYTHON)" >&2
  else
    echo "dev.sh: probing python analyzer sidecar via $KEY_ANALYZER_PYTHON ..."
    ready_json="$(echo '' | "$KEY_ANALYZER_PYTHON" "$sidecar" --serve 2>/dev/null | head -n 1 || true)"
    echo "dev.sh: analyzer ready line: ${ready_json:-<none>}"
    if [[ "$ready_json" == *'"ready": true'* || "$ready_json" == *'"ready":true'* ]]; then
      analyzer_ok=1
      if [[ "$backend" == "libkeyfinder" ]]; then
        echo "dev.sh: falling back to the python sidecar; forcing KEY_ANALYZER_BACKEND=current" >&2
        export KEY_ANALYZER_BACKEND=current
      fi
    fi
  fi
fi

if [[ "$analyzer_ok" -eq 0 ]]; then
  echo "dev.sh: no analyzer backend available." >&2
  echo "dev.sh:   ./src-tauri/sidecars/libkeyfinder_cli/build.sh   # preferred, no python needed" >&2
  echo "dev.sh:   pip install numpy scipy                          # minimum python fallback" >&2
  echo "dev.sh:   pip install essentia                             # preferred python backend" >&2
  if [[ "$ALLOW_DEGRADED_ANALYZER" != "1" ]]; then
    echo "dev.sh: refusing to start; set ALLOW_DEGRADED_ANALYZER=1 to run without key detection." >&2
    exit 2
  fi
  echo "dev.sh: ALLOW_DEGRADED_ANALYZER=1 -- starting without local key detection." >&2
fi

if [[ ! -d "$root/node_modules" ]]; then
  echo "dev.sh: installing npm dependencies..."
  npm install
fi

# node_modules on this shared drive is often installed from Windows, which fetches only the win32
# build of the Tauri CLI; npx tauri then dies with "Cannot find module './cli.linux-x64-gnu.node'".
# Add this platform's build next to it without touching package.json or the lockfile.
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)  tauri_native="cli-linux-x64-gnu" ;;
  Linux-aarch64) tauri_native="cli-linux-arm64-gnu" ;;
  Darwin-arm64)  tauri_native="cli-darwin-arm64" ;;
  Darwin-x86_64) tauri_native="cli-darwin-x64" ;;
  *)             tauri_native="" ;;
esac
if [[ -n "$tauri_native" && ! -d "$root/node_modules/@tauri-apps/$tauri_native" ]]; then
  tauri_version="$(node -p "require('./node_modules/@tauri-apps/cli/package.json').version")"
  echo "dev.sh: adding @tauri-apps/$tauri_native@$tauri_version (node_modules was installed on another OS)"
  npm install --no-save "@tauri-apps/$tauri_native@$tauri_version"
fi

# ChordSync (Play Along, lyrics, capture) needs its own venv with requirements.txt, plus
# requirements-lyrics.txt (Whisper, Demucs, the CTC aligner) to time lyric words by ear: without
# them every word sits on LRCLIB's line clock and the song sheet runs ahead of the singer. The
# sidecar's `.venv` is the Windows one on this shared drive, and PyTorch takes the better part of an
# hour to land on NTFS, so the Linux venv lives on the native filesystem, like the chord analysis
# one. Reinstalled whenever either requirements file changes.
chordsync_dir="$root/src-tauri/sidecars/chordsync"
chordsync_venv="${XDG_DATA_HOME:-$HOME/.local/share}/fretboard-studio/chordsync-venv"
chordsync_stamp="$chordsync_venv/.requirements-installed"
setup_chordsync_venv() {
  local uv_bin
  uv_bin="$(command -v uv || true)"
  if [[ -z "$uv_bin" && -x "$HOME/.local/bin/uv" ]]; then uv_bin="$HOME/.local/bin/uv"; fi
  mkdir -p "$(dirname "$chordsync_venv")"
  if [[ -n "$uv_bin" ]]; then
    if [[ ! -x "$chordsync_venv/bin/python" ]]; then
      "$uv_bin" venv --python python3 "$chordsync_venv" || return 1
    fi
    # torch for Demucs and the aligner: uv picks the build that matches the machine (CUDA on an
    # NVIDIA GPU, CPU elsewhere), so the GPU is used when there is one. Whisper runs on CTranslate2.
    "$uv_bin" pip install --python "$chordsync_venv/bin/python" --torch-backend=auto \
      -r "$chordsync_dir/requirements.txt" -r "$chordsync_dir/requirements-lyrics.txt"
  elif python3 -c 'import ensurepip' 2>/dev/null; then
    if [[ ! -x "$chordsync_venv/bin/python" ]]; then
      python3 -m venv "$chordsync_venv" || return 1
    fi
    "$chordsync_venv/bin/python" -m pip install --index-url https://download.pytorch.org/whl/cpu torch || return 1
    "$chordsync_venv/bin/python" -m pip install -r "$chordsync_dir/requirements.txt" \
      -r "$chordsync_dir/requirements-lyrics.txt"
  else
    echo "dev.sh: cannot create the ChordSync venv: install uv (https://docs.astral.sh/uv/)" >&2
    echo "dev.sh:   or python3-venv (sudo apt install python3-venv)." >&2
    return 1
  fi
}
if [[ -z "${CHORDSYNC_PYTHON:-}" ]]; then
  if [[ ! -x "$chordsync_venv/bin/python" || ! -f "$chordsync_stamp" \
        || "$chordsync_dir/requirements.txt" -nt "$chordsync_stamp" \
        || "$chordsync_dir/requirements-lyrics.txt" -nt "$chordsync_stamp" ]]; then
    echo "dev.sh: setting up the ChordSync venv at $chordsync_venv ..."
    if setup_chordsync_venv; then
      touch "$chordsync_stamp"
    else
      echo "dev.sh: ChordSync venv setup failed; Play Along, lyrics and song capture will not work." >&2
    fi
  fi
  if [[ -x "$chordsync_venv/bin/python" ]]; then
    export CHORDSYNC_PYTHON="$chordsync_venv/bin/python"
  fi
fi

# Whole-song chord analysis (LV-Chordia + the Beat This! beat tracker). `harmonia/ml/.venv` on this
# shared drive is the Windows one, and PyTorch's thousands of files take the better part of an hour
# to land on NTFS, so the Linux environment lives on the native filesystem instead and Rust is
# pointed at it through HARMONIA_RECOGNITION_PYTHON. Without it "Read the chords" fails with
# "Whole-song recognition is unavailable". Reinstalled whenever requirements-unix.txt changes.
harmonia_ml_dir="$root/harmonia/ml"
harmonia_venv="${XDG_DATA_HOME:-$HOME/.local/share}/fretboard-studio/harmonia-venv"
harmonia_stamp="$harmonia_venv/.requirements-installed"
beat_ckpt="$harmonia_venv/share/beat-this/final0.ckpt"
beat_ckpt_sha256="8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331"
setup_harmonia_venv() {
  local uv_bin
  uv_bin="$(command -v uv || true)"
  if [[ -z "$uv_bin" && -x "$HOME/.local/bin/uv" ]]; then uv_bin="$HOME/.local/bin/uv"; fi
  mkdir -p "$(dirname "$harmonia_venv")"
  if [[ -n "$uv_bin" ]]; then
    if [[ ! -x "$harmonia_venv/bin/python" ]]; then
      "$uv_bin" venv --python python3 "$harmonia_venv" || return 1
    fi
    # CPU wheels: the default Linux torch wheel drags in several GB of CUDA libraries.
    "$uv_bin" pip install --python "$harmonia_venv/bin/python" --torch-backend=cpu \
      -r "$harmonia_ml_dir/requirements-unix.txt" || return 1
  elif python3 -c 'import ensurepip' 2>/dev/null; then
    if [[ ! -x "$harmonia_venv/bin/python" ]]; then
      python3 -m venv "$harmonia_venv" || return 1
    fi
    "$harmonia_venv/bin/python" -m pip install --index-url https://download.pytorch.org/whl/cpu torch || return 1
    "$harmonia_venv/bin/python" -m pip install -r "$harmonia_ml_dir/requirements-unix.txt" || return 1
  else
    echo "dev.sh: cannot create the chord analysis venv: install uv or python3-venv." >&2
    return 1
  fi
  "$harmonia_venv/bin/python" -c 'import lv_chordia, torch, librosa, einops, rotary_embedding_torch' || return 1
}
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
ensure_beat_checkpoint() {
  if [[ -f "$beat_ckpt" && "$(sha256_of "$beat_ckpt")" == "$beat_ckpt_sha256" ]]; then
    return 0
  fi
  echo "dev.sh: downloading the Beat This! beat tracker (80 MB, once)..."
  mkdir -p "$(dirname "$beat_ckpt")"
  curl -L --fail --retry 3 -o "$beat_ckpt.partial" \
    "https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/final0.ckpt" || return 1
  if [[ "$(sha256_of "$beat_ckpt.partial")" != "$beat_ckpt_sha256" ]]; then
    rm -f "$beat_ckpt.partial"
    echo "dev.sh: the beat tracker download does not match its pinned SHA-256." >&2
    return 1
  fi
  mv "$beat_ckpt.partial" "$beat_ckpt"
}
if [[ -z "${HARMONIA_RECOGNITION_PYTHON:-}" ]]; then
  if [[ ! -x "$harmonia_venv/bin/python" || ! -f "$harmonia_stamp" \
        || "$harmonia_ml_dir/requirements-unix.txt" -nt "$harmonia_stamp" ]]; then
    echo "dev.sh: setting up the chord analysis venv at $harmonia_venv (downloads PyTorch once) ..."
    if setup_harmonia_venv; then
      touch "$harmonia_stamp"
    else
      echo "dev.sh: chord analysis venv setup failed; saved songs cannot be read for chords." >&2
    fi
  fi
  if [[ -x "$harmonia_venv/bin/python" ]]; then
    ensure_beat_checkpoint \
      || echo "dev.sh: no beat tracker; chords are decoded frame by frame and tempo is rough." >&2
    export HARMONIA_RECOGNITION_PYTHON="$harmonia_venv/bin/python"
  fi
fi

# rustup installs cargo into ~/.cargo/bin, which only login shells put on PATH.
if ! command -v cargo >/dev/null 2>&1 && [[ -x "$HOME/.cargo/bin/cargo" ]]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "dev.sh: cargo not found; install Rust from https://rustup.rs" >&2
  exit 1
fi

# Vite and the webview have to agree on the port, so pick one free port and hand it to both.
# strictPort is on, so a busy port is a hard failure rather than a silent shift -- and without
# the matching devUrl override the webview would happily load whatever already held it.
port="${GSV_DEV_PORT:-1420}"
if [[ -z "${GSV_DEV_PORT:-}" ]]; then
  for candidate in $(seq 1420 1460); do
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$candidate") 2>/dev/null; then
      port="$candidate"
      break
    fi
    exec 3>&- 2>/dev/null || true
  done
fi
export GSV_DEV_PORT="$port"
if [[ "$port" != "1420" ]]; then
  echo "dev.sh: port 1420 is busy; using $port for the dev server and the webview"
fi

ensure_ffmpeg() {
  local dest="$root/.tools/ffmpeg/bin"
  if [[ -x "$dest/ffmpeg" && -x "$dest/ffprobe" ]]; then
    export FFMPEG_PATH="$dest/ffmpeg"
    export PATH="$dest:$PATH"
    return
  fi
  if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
    # Not grep -q: it exits on the first match, ffmpeg dies of SIGPIPE, and pipefail turns a
    # working build into a failed check.
    if ffmpeg -hide_banner -encoders 2>/dev/null | grep libmp3lame >/dev/null; then
      return
    fi
  fi
  if [[ "$(uname -m)" != "x86_64" ]]; then
    echo "dev.sh: no bundled FFmpeg build for $(uname -m). Capture needs ffmpeg and ffprobe on PATH." >&2
    return
  fi
  local url="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-linux64-gpl-8.1.tar.xz"
  local archive="$root/.tools/ffmpeg-linux64-gpl.tar.xz"
  local extract="$root/.tools/ffmpeg-extract"
  mkdir -p "$root/.tools"
  echo "dev.sh: downloading FFmpeg so saved songs can be encoded to MP3..."
  curl -L --fail --retry 3 -o "$archive" "$url"
  rm -rf "$extract"
  mkdir -p "$extract"
  tar -xJf "$archive" -C "$extract"
  local found
  found="$(find "$extract" -type f -name ffmpeg -path '*/bin/ffmpeg' -print -quit)"
  if [[ -z "$found" ]]; then
    echo "dev.sh: FFmpeg archive did not contain bin/ffmpeg" >&2
    exit 1
  fi
  rm -rf "$root/.tools/ffmpeg"
  mkdir -p "$dest"
  cp -a "$(dirname "$found")/." "$dest/"
  chmod +x "$dest/ffmpeg" "$dest/ffprobe"
  rm -f "$archive"
  rm -rf "$extract"
  if [[ ! -x "$dest/ffmpeg" || ! -x "$dest/ffprobe" ]]; then
    echo "dev.sh: FFmpeg setup did not produce ffmpeg and ffprobe" >&2
    exit 1
  fi
  if ! "$dest/ffmpeg" -hide_banner -encoders 2>/dev/null | grep libmp3lame >/dev/null; then
    echo "dev.sh: downloaded FFmpeg cannot encode MP3 (libmp3lame missing)" >&2
    exit 1
  fi
  export FFMPEG_PATH="$dest/ffmpeg"
  export PATH="$dest:$PATH"
}

ensure_ffmpeg

echo "dev.sh: starting tauri dev on http://127.0.0.1:$port ..."
exec npx tauri dev --config "{\"build\":{\"devUrl\":\"http://127.0.0.1:$port\"}}" "$@"
