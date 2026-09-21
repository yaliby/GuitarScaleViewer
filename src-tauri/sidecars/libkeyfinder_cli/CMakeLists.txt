cmake_minimum_required(VERSION 3.16)
project(gsv_libkeyfinder_cli CXX)

set(CMAKE_CXX_STANDARD 14)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(PkgConfig REQUIRED)
pkg_check_modules(SNDFILE REQUIRED IMPORTED_TARGET sndfile)

# libkeyfinder ships a pkg-config file in most distributions; fall back to a plain
# header/library search so a locally built libKeyFinder still links.
pkg_check_modules(KEYFINDER IMPORTED_TARGET libkeyfinder)

add_executable(gsv-libkeyfinder-cli main.cpp chord_frontend.cpp)
target_link_libraries(gsv-libkeyfinder-cli PRIVATE PkgConfig::SNDFILE)

if(KEYFINDER_FOUND)
  target_link_libraries(gsv-libkeyfinder-cli PRIVATE PkgConfig::KEYFINDER)
else()
  find_path(KEYFINDER_INCLUDE_DIR keyfinder/keyfinder.h)
  find_library(KEYFINDER_LIBRARY NAMES keyfinder KeyFinder)
  if(NOT KEYFINDER_INCLUDE_DIR OR NOT KEYFINDER_LIBRARY)
    message(FATAL_ERROR
      "libKeyFinder not found. Install it (Fedora: libkeyfinder-devel, Debian/Ubuntu: libkeyfinder-dev) "
      "or build it from https://github.com/mixxxdj/libkeyfinder and re-run cmake with "
      "-DCMAKE_PREFIX_PATH=<install-prefix>.")
  endif()
  target_include_directories(gsv-libkeyfinder-cli PRIVATE ${KEYFINDER_INCLUDE_DIR})
  target_link_libraries(gsv-libkeyfinder-cli PRIVATE ${KEYFINDER_LIBRARY})
endif()

# The packaged app ships this binary next to a copy of libkeyfinder.so.2 (see build.sh), because
# libKeyFinder is usually built from source into /usr/local/lib and an end user's machine has no
# such file. `$ORIGIN` makes the loader look beside the executable first, so the bundle is
# self-contained instead of depending on the build machine's prefix.
set_target_properties(gsv-libkeyfinder-cli PROPERTIES
  BUILD_RPATH "$ORIGIN"
  INSTALL_RPATH "$ORIGIN")

install(TARGETS gsv-libkeyfinder-cli RUNTIME DESTINATION bin)
