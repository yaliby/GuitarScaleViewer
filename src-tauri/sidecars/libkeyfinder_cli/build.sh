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

echo
echo "built: $build_dir/gsv-libkeyfinder-cli"
echo "use it with: export KEY_ANALYZER_LIBKEYFINDER_CLI=\"$build_dir/gsv-libkeyfinder-cli\""
