#!/usr/bin/env bash
# Cross-compile pikepdf to a Pyodide wheel (wasm32-emscripten, cp314).
#
# Uses Pyodide's xbuildenv: it ships a wasm-built CPython (headers + libs) and
# the pyodide-build toolchain wrapper. libqpdf comes from build-qpdf-wasm.sh.
#
# pikepdf's CMakeLists understands a qpdf source-tree layout via
# QPDF_SOURCE_TREE (+ QPDF_BUILD_LIBDIR): $tree/include with headers and
# $tree/build/libqpdf with libqpdf.a. We fabricate that layout on top of the
# install tree produced by build-qpdf-wasm.sh.
#
# Inputs (environment):
#   PIKEPDF_VERSION - release tag to build (default 10.18.1)
#   PYODIDE_VERSION - xbuildenv version (default 314.0.8; python 3.14 + ems 5.0.3)
#   QPDF_INSTALL    - install tree from build-qpdf-wasm.sh (default sibling build dir)
#   WORK_DIR        - scratch dir (default: ./build under script dir)
#   OUT_DIR         - where the wheel is copied (default $WORK_DIR/dist)
#   EMSDK           - path to emsdk (default $HOME/wasm-build/emsdk or ~/emsdk)
#   JOBS            - parallel jobs (default nproc)
set -euo pipefail

PIKEPDF_VERSION="${PIKEPDF_VERSION:-10.18.1}"
PYODIDE_VERSION="${PYODIDE_VERSION:-314.0.8}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="${WORK_DIR:-$SCRIPT_DIR/build}"
QPDF_INSTALL="${QPDF_INSTALL:-$WORK_DIR/install}"
OUT_DIR="${OUT_DIR:-$WORK_DIR/dist}"
JOBS="${JOBS:-$(nproc)}"

if [[ -n "${EMSDK:-}" ]]; then :
elif [[ -d "$HOME/wasm-build/emsdk" ]]; then EMSDK="$HOME/wasm-build/emsdk"
elif [[ -d "$HOME/emsdk" ]]; then EMSDK="$HOME/emsdk"
else echo "error: emsdk not found (set EMSDK=...)" >&2; exit 1; fi
export EMSDK
# shellcheck disable=SC1091
source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1 || true

# libqpdf must be PIC: _core links as a wasm side module, which rejects
# non-PIC objects at link time (build-qpdf-wasm.sh sets
# CMAKE_POSITION_INDEPENDENT_CODE=ON for this).
[[ -f "$QPDF_INSTALL/lib/libqpdf.a" ]] || {
  echo "error: libqpdf.a not found at $QPDF_INSTALL/lib/ — run build-qpdf-wasm.sh first" >&2; exit 1; }

mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

# ------------------------------------------------------- pyodide xbuildenv
# pyodide-build 0.39.x resolves the xbuildenv through
# PYODIDE_XBUILDENV_PATH, expects the CrossBuildEnvManager layout
# ($dir/<version>/xbuildenv/ with a "xbuildenv" symlink for the selected
# version), and requires a host python matching the xbuildenv's python
# (3.14 for xbuildenv 314.0.8 — the compat check compares major.minor).
XBUILD_DIR="$WORK_DIR/xbuildenv"
export PYODIDE_XBUILDENV_PATH="$XBUILD_DIR"
# The manager resolves pyodide-root as $XBUILD_DIR/xbuildenv -> <version>/
# xbuildenv/pyodide-root, so the tarball's top-level "xbuildenv/" dir must be
# kept: unpack straight into $XBUILD_DIR/$PYODIDE_VERSION, no --strip-components.
if [[ ! -d "$XBUILD_DIR/$PYODIDE_VERSION/xbuildenv/pyodide-root" ]]; then
  echo "Fetching Pyodide xbuildenv $PYODIDE_VERSION ..." >&2
  mkdir -p "$XBUILD_DIR/$PYODIDE_VERSION"
  curl -fsSL --retry 5 -o "$WORK_DIR/xbuildenv.tar.gz" \
    "https://github.com/pyodide/pyodide/releases/download/$PYODIDE_VERSION/xbuildenv-$PYODIDE_VERSION.tar.gz"
  tar xzf "$WORK_DIR/xbuildenv.tar.gz" -C "$XBUILD_DIR/$PYODIDE_VERSION"
fi

# The host python driving pyodide-build must match the xbuildenv's python
# version (else the compat check fails with "Version ... is not
# compatible"). Prefer a uv-managed interpreter; fall back to PATH.
XBUILD_PYTHON="${XBUILD_PYTHON:-}"
if [[ -z "$XBUILD_PYTHON" ]]; then
  if command -v uv >/dev/null; then
    uv python install 3.14 >/dev/null 2>&1 || true
    XBUILD_PYTHON="$(uv python find 3.14 2>/dev/null || true)"
  fi
  [[ -n "$XBUILD_PYTHON" ]] || XBUILD_PYTHON="python3.14"
  if ! command -v "$XBUILD_PYTHON" >/dev/null; then
    echo "error: host python 3.14 required for xbuildenv $PYODIDE_VERSION (found only $(python3 --version 2>&1)); install uv or python3.14" >&2
    exit 1
  fi
fi

# Build venv with pyodide-build + the xbuildenv's requirements. PIP_INDEX
# lets CI override the index (the default global index can be a mirror
# that lacks these packages). uv venvs ship no pip, so use uv pip.
PIP_INDEX="${PIP_INDEX_URL:-https://pypi.org/simple}"
VENV="$WORK_DIR/venv-$(basename "$XBUILD_PYTHON")"
if [[ ! -x "$VENV/bin/pyodide" ]]; then
  uv venv --python "$XBUILD_PYTHON" "$VENV"
  VIRTUAL_ENV="$VENV" uv pip install --quiet --index-url "$PIP_INDEX" \
    -r "$XBUILD_DIR/$PYODIDE_VERSION/xbuildenv/requirements.txt" "pyodide-build[resolve]"
fi
export PATH="$VENV/bin:$PATH"

# Select the xbuildenv version (creates the symlink pyodide_root resolves
# through). PYODIDE_XBUILDENV_PATH, exported above, points pyodide-build at
# this env dir; the resolved PYODIDE_ROOT is exported for consumers.
pyodide xbuildenv use "$PYODIDE_VERSION"
export PYODIDE_ROOT="$XBUILD_DIR/$PYODIDE_VERSION/xbuildenv/pyodide-root"

# The qpdf source-tree layout pikepdf's CMakeLists expects:
#   $QPDF_SOURCE_TREE/include        - qpdf headers
#   $QPDF_SOURCE_TREE/build/libqpdf  - libqpdf.a
export QPDF_SOURCE_TREE="$WORK_DIR/qpdf-tree"
export QPDF_BUILD_LIBDIR="$QPDF_SOURCE_TREE/build/libqpdf"
if [[ ! -e "$QPDF_BUILD_LIBDIR/libqpdf.a" ]]; then
  mkdir -p "$QPDF_SOURCE_TREE/build"
  ln -sfn "$QPDF_INSTALL/include" "$QPDF_SOURCE_TREE/include"
  ln -sfn "$QPDF_INSTALL/lib" "$QPDF_SOURCE_TREE/build/libqpdf"
fi

# ---------------------------------------------------------------- pikepdf
if [[ ! -d pikepdf-src ]]; then
  echo "Fetching pikepdf $PIKEPDF_VERSION ..." >&2
  curl -fsSL --retry 5 -o "pikepdf-$PIKEPDF_VERSION.tar.gz" \
    "https://github.com/pikepdf/pikepdf/archive/refs/tags/v$PIKEPDF_VERSION.tar.gz"
  mkdir pikepdf-src
  tar xzf "pikepdf-$PIKEPDF_VERSION.tar.gz" -C pikepdf-src --strip-components=1
fi
cd pikepdf-src

echo "Building pikepdf $PIKEPDF_VERSION wheel for pyodide ..." >&2
rm -rf dist

# _core links as a side module (-sSIDE_MODULE=1). Undefined symbols in a
# side module are resolved against the pyodide main module at load time;
# the main module exports zlib (it links -sUSE_ZLIB) but NOT libjpeg. The
# qpdf object files pikepdf pulls in reference the jpeg_* API (Pl_DCT),
# so libjpeg must be embedded in _core itself. With -sSIDE_MODULE=1,
# -sUSE_LIBJPEG does NOT link the port into the module — it only assumes
# an external library provides it (emcc leaves jpeg_* as GOT imports),
# and wasm-ld then strips them entirely since no archive supplies them.
# The fix is to pass the port's PIC archive explicitly on the link line;
# out_of_tree/build.py appends $LDFLAGS to SIDE_MODULE_LDFLAGS, which
# pyodide's cmake toolchain appends to the _core link. zlib is left to
# the main module's export list, which does provide it.
_pic_libdir="$EMSDK/upstream/emscripten/cache/sysroot/lib/wasm32-emscripten/pic"
# Ensure the PIC libjpeg port exists (embuilder caches per-toolchain-version;
# build-qpdf-wasm.sh also builds it, but don't depend on that ordering).
[[ -f "$_pic_libdir/libjpeg.a" ]] || embuilder build libjpeg --pic
export LDFLAGS="${LDFLAGS:-} -sUSE_ZLIB ${_pic_libdir}/libjpeg.a"

# pikepdf pins wheel.py-api = "cp314" in pyproject.toml, which selects the
# stable-ABI (limited API) build: scikit-build-core defines
# Py_LIMITED_API=0x030C0000 and nanobind compiles with STABLE_ABI. Under the
# limited API CPython's headers no longer include <stdio.h>, and nanobind's
# headers reference stderr without including <cstdio>, so the emscripten
# build fails with "use of undeclared identifier 'stderr'". Every package in
# the pyodide lock uses a full cp314-cp314 tag instead. The empty value
# resets py-api to its default, which means "use the interpreter's default
# tag" — scikit-build-core then builds without SABI and tags the wheel
# cp314-cp314, matching numpy/lxml/pillow in the 314.0.8 lock. (A literal
# "cp314-cp314" would be rejected: compute_best only accepts abi3-style
# like "cp314", free-threaded like "cp315t", or pythonless like "py2.py3".)
pyodide build --config-setting wheel.py-api= || exit 1

mkdir -p "$OUT_DIR"
shopt -s nullglob
wheels=(dist/*.whl)
if [[ ${#wheels[@]} -eq 0 ]]; then
  echo "error: no wheel produced" >&2; exit 1
fi
cp "${wheels[@]}" "$OUT_DIR/"
echo "pikepdf wheel(s):" >&2
ls -la "$OUT_DIR" >&2
