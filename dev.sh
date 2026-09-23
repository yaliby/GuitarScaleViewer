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
if [[ "$backend" == "libkeyfinder" && -z "${KEY_ANALYZER_LIBKEYFINDER_CLI:-}" \
      && -f "$lkf_build_dir/CMakeCache.txt" ]] && command -v cmake >/dev/null 2>&1; then
  if ! cmake --build "$lkf_build_dir" --parallel >/dev/null; then
    echo "dev.sh: rebuilding the libkeyfinder CLI failed; probing whatever binary is there." >&2
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

echo "dev.sh: starting tauri dev on http://127.0.0.1:$port ..."
exec npx tauri dev --config "{\"build\":{\"devUrl\":\"http://127.0.0.1:$port\"}}" "$@"
