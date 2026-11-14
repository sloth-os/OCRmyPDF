#!/usr/bin/env bash
# Build libqpdf (static) for wasm32-emscripten, for linking into the pikepdf
# wasm build.
#
# zlib and libjpeg come from emscripten's ports (embuilder): the emscripten
# toolchain file restricts find_path/find_library to CMAKE_FIND_ROOT_PATH
# (the sysroot), so hand-built libs in an install prefix are invisible to
# qpdf's CMake discovery. The ports install into the sysroot with pkgconfig
# entries that pkg_check_modules finds, and -sUSE_ZLIB/-sUSE_LIBJPEG link
# flags that emcc understands.
#
# qpdf is built as position-independent code: pikepdf's _core links as a
# wasm side module (-sSIDE_MODULE=1), and wasm-ld rejects non-PIC objects
# there with "relocation R_WASM_MEMORY_ADDR_SLEB cannot be used against
# symbol ...; recompile with -fPIC". -fPIC goes into C[XX]_FLAGS directly
# because qpdf's libqpdf/CMakeLists.txt sets
# POSITION_INDEPENDENT_CODE OFF on its libqpdf_object target whenever
# BUILD_STATIC_LIBS=ON, which would override a global
# CMAKE_POSITION_INDEPENDENT_CODE=ON cache entry; raw flags are additive
# and win over the target property.
#
# Inputs (environment):
#   QPDF_VERSION - qpdf release (default: the version pikepdf pins)
#   WORK_DIR     - scratch dir (default: ./build under script dir)
#   OUT_DIR      - install prefix (default $WORK_DIR/install)
#   EMSDK        - path to emsdk (default $HOME/wasm-build/emsdk or ~/emsdk)
#   JOBS         - parallel jobs (default nproc)
set -euo pipefail

QPDF_VERSION="${QPDF_VERSION:-12.4.2}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="${WORK_DIR:-$SCRIPT_DIR/build}"
OUT_DIR="${OUT_DIR:-$WORK_DIR/install}"
JOBS="${JOBS:-$(nproc)}"

if [[ -n "${EMSDK:-}" ]]; then :
elif [[ -d "$HOME/wasm-build/emsdk" ]]; then EMSDK="$HOME/wasm-build/emsdk"
elif [[ -d "$HOME/emsdk" ]]; then EMSDK="$HOME/emsdk"
else echo "error: emsdk not found (set EMSDK=...)" >&2; exit 1; fi
# shellcheck disable=SC1091
source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1 || true
command -v emcmake >/dev/null || { echo "error: emcmake not on PATH after sourcing $EMSDK/emsdk_env.sh" >&2; exit 1; }

mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

fetch() { # fetch <url> <tarball>
  local url="$1" out="$2"
  if [[ ! -f "$out" ]]; then
    echo "Downloading $url ..." >&2
    curl -fsSL --retry 5 -o "$out" "$url"
  fi
}

# ------------------------------------------------ zlib + libjpeg (ports)
# Build the emscripten ports into the emsdk sysroot (cached by emsdk's own
# cache; rebuilt only when the toolchain version changes). Also build the
# PIC variants since pikepdf links everything into one shared module.
echo "Building emscripten ports (zlib, libjpeg) ..." >&2
embuilder build zlib libjpeg --pic

# The ports' .pc files live in the sysroot, and the system pkg-config does
# not search there by default (it only knows the host's multiarch dirs).
# qpdf discovers zlib/jpeg via pkg_check_modules, so point pkg-config at
# the sysroot. The ports' .pc files put "-sUSE_ZLIB"/"-sUSE_LIBJPEG" in
# Libs:, which pkg_check_modules drops (not -l<name> shaped), so the flags
# never reach the link line; pass them explicitly via CMAKE_EXE_LINKER_FLAGS
# so test binaries and the qpdf CLI resolve the port libraries. The qpdf
# CLI binary is itself installed by the install target.
export PKG_CONFIG_LIBDIR="$EMSDK/upstream/emscripten/cache/sysroot/lib/pkgconfig"
PORT_LINK_FLAGS="-sUSE_ZLIB -sUSE_LIBJPEG"

# ------------------------------------------------------------------ qpdf
if [[ ! -d qpdf-src ]]; then
  fetch "https://github.com/qpdf/qpdf/releases/download/v$QPDF_VERSION/qpdf-$QPDF_VERSION.tar.gz" \
    "qpdf-$QPDF_VERSION.tar.gz"
  mkdir qpdf-src
  tar xzf "qpdf-$QPDF_VERSION.tar.gz" -C qpdf-src --strip-components=1
fi

echo "Building qpdf $QPDF_VERSION for wasm32-emscripten ..." >&2
rm -rf qpdf-build
emcmake cmake -S qpdf-src -B qpdf-build \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$OUT_DIR" \
   -DCMAKE_C_FLAGS="-O2 -fPIC" \
  -DCMAKE_CXX_FLAGS="-O2 -fwasm-exceptions -fPIC" \
  -DCMAKE_EXE_LINKER_FLAGS="$PORT_LINK_FLAGS" \
  -DBUILD_STATIC_LIBS=ON \
  -DBUILD_SHARED_LIBS=OFF \
  -DINSTALL_MANUAL=OFF \
  -DINSTALL_EXAMPLES=OFF \
  -DINSTALL_PKGCONFIG=ON \
  -DUSE_IMPLICIT_CRYPTO=OFF \
  -DREQUIRE_CRYPTO_NATIVE=ON
cmake --build qpdf-build --target install -j "$JOBS"

# The wasm CLI binary is useless to us; keep the tree small.
rm -f "$OUT_DIR/bin/qpdf"

echo "qpdf wasm build complete:" >&2
ls -la "$OUT_DIR/lib/libqpdf.a" >&2
