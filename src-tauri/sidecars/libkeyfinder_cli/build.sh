#!/usr/bin/env bash
# Builds the libKeyFinder CLI that `KEY_ANALYZER_BACKEND=libkeyfinder` (the default) expects.
#
# Requires: cmake, a C++14 compiler, libsndfile and libKeyFinder development packages.
#   Fedora:        sudo dnf install cmake gcc-c++ libsndfile-devel libkeyfinder-devel
#   Debian/Ubuntu: sudo apt install cmake g++ libsndfile1-dev libkeyfinder-dev
#
# On success, point the app at the binary:
#   export KEY_ANALYZER_LIBKEYFINDER_CLI="$PWD/build/gsv-libkeyfinder-cli"
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
build_dir="${1:-$here/build}"

cmake -S "$here" -B "$build_dir" -DCMAKE_BUILD_TYPE=Release
cmake --build "$build_dir" --parallel

# libKeyFinder is normally built from source into /usr/local/lib, so an end user's machine has no
# libkeyfinder.so.2 at all. The binary is linked with an `$ORIGIN` rpath (see CMakeLists.txt), so
# copying the library next to it makes the packaged app self-contained. Without this the bundled
# app falls back to the python analyzer, finds no numpy, and reports analyzer_unavailable — the
# default backend silently not existing is the worst of the failure modes.
lib_path="$(ldd "$build_dir/gsv-libkeyfinder-cli" | awk '/libkeyfinder\.so/ {print $3}')"
if [ -n "${lib_path:-}" ] && [ -f "$lib_path" ]; then
  cp -L "$lib_path" "$build_dir/$(basename "$lib_path")"
  echo "bundled: $build_dir/$(basename "$lib_path")"
else
  echo "warning: libkeyfinder.so not located next to the binary; a packaged build will not run" >&2
fi

echo
echo "built: $build_dir/gsv-libkeyfinder-cli"
echo "use it with: export KEY_ANALYZER_LIBKEYFINDER_CLI=\"$build_dir/gsv-libkeyfinder-cli\""
