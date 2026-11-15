#!/usr/bin/env bash
# Assemble the runtime bundle for the OCRmyPDF web app.
#
# Layout produced under $OUT (mirrored into the web app's public/ dir):
#   pyodide/ Pyodide runtime (js/mjs/wasm/stdlib/lock)
#   wheels/                wheels the app installs at runtime with micropip
#   tesseract/             tesseract-wasm dist files (wasm + worker + lib)
#   tessdata/eng.traineddata  default language model
#   pyodide-glue/          wasm/pyodide/*.py runtime glue (wasmenv, plugins)
#   runtime-meta.json      versions + sha256 of every file (cache busting)
#
# Inputs (environment):
#   PYODIDE_VERSION - runtime version (default 314.0.8)
#   OCRMYPDF_GIT    - path to a local OCRmyPDF clone (default ~/software/OCRmyPDF)
#   PIKEPDF_WHEEL   - path/dir of the pikepdf wasm wheel (default $WORK_DIR/dist)
#   TESSERACT_WASM_VERSION - npm version (default 0.11.0)
#   WORK_DIR        - scratch (default: ./build under script dir)
#   OUT             - output dir (default $WORK_DIR/site)
set -euo pipefail

PYODIDE_VERSION="${PYODIDE_VERSION:-314.0.8}"
OCRMYPDF_GIT="${OCRMYPDF_GIT:-$HOME/software/OCRmyPDF}"
TESSERACT_WASM_VERSION="${TESSERACT_WASM_VERSION:-0.11.0}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="${WORK_DIR:-$SCRIPT_DIR/build}"
OUT="${OUT:-$WORK_DIR/site}"

mkdir -p "$WORK_DIR" "$OUT"
cd "$WORK_DIR"

# ------------------------------------------------------------- pyodide core
echo "== Pyodide $PYODIDE_VERSION runtime ==" >&2
# Prefer a local pyodide dist tree when present: the xbuildenv unpacked by
# build-pikepdf-wasm.sh ($WORK_DIR/xbuildenv/<v>/xbuildenv/pyodide-root/dist)
# ships the same runtime files as the pyodide-core release tarball, avoiding
# a ~30MB download and github.com flakiness. Otherwise download the tarball.
PYODIDE_LOCAL_DIST="$WORK_DIR/xbuildenv/$PYODIDE_VERSION/xbuildenv/pyodide-root/dist"
if [[ ! -d pyodide-dist ]]; then
  if [[ -f "$PYODIDE_LOCAL_DIST/pyodide.mjs" ]]; then
    ln -sfn "$PYODIDE_LOCAL_DIST" pyodide-dist
  else
    curl -fsSL --retry 5 --retry-all-errors -o pyodide-core.tar.bz2 \
      "https://github.com/pyodide/pyodide/releases/download/$PYODIDE_VERSION/pyodide-core-$PYODIDE_VERSION.tar.bz2"
    mkdir pyodide-dist
    tar xjf pyodide-core.tar.bz2 -C pyodide-dist --strip-components=1
  fi
fi
rm -rf "$OUT/pyodide"
mkdir -p "$OUT/pyodide"
# pyodide 314.x loads pyodide.asm.mjs (ESM) — there is no pyodide.asm.js.
cp -L pyodide-dist/pyodide.js pyodide-dist/pyodide.mjs \
   pyodide-dist/pyodide.asm.mjs pyodide-dist/pyodide.asm.wasm \
   pyodide-dist/python_stdlib.zip pyodide-dist/pyodide-lock.json \
   "$OUT/pyodide/"
cp -L pyodide-dist/python* "$OUT/pyodide/" 2>/dev/null || true

# Pyodide "lock" wheels that micropip/loadPackage resolve at runtime. The
# dist tree ships only the core runtime — every package resolved from
# pyodide-lock.json (micropip itself plus the ocrmypdf dependency closure
# that pyodide provides: pillow, rich, lxml, fonttools, ...) is fetched
# relative to indexURL. Without local copies, pyodide/micropip silently fall
# back to cdn.jsdelivr.net: the Node smoke test stays green (it has network)
# while the deployed PWA breaks its offline guarantee. Fetch the exact
# closure from the lock so everything resolves same-origin.
# (pydantic/pydantic-core are NOT in this closure: the lock ships pydantic
# 2.12.5, but upstream ocrmypdf pins >=2.14 — those two come from PyPI via
# fetch-wheels.py into wheels/ instead.)
echo "== pyodide lock wheels (offline closure) ==" >&2
python3 - "$OUT/pyodide" "$PYODIDE_VERSION" <<'EOF'
import json, sys, urllib.request
from pathlib import Path

out, pyodide_v = Path(sys.argv[1]), sys.argv[2]
lock = json.load(open(out / "pyodide-lock.json"))
pkgs = lock["packages"]

SEEDS = ["micropip", "packaging", "pillow", "pluggy", "rich", "fonttools",
         "cffi", "pycparser", "lxml", "annotated-types"]
# NOT seeded: typing-extensions / typing-inspection / pydantic — the lock's
# pydantic 2.12.5 + typing-extensions 4.15.0 are older than ocrmypdf's
# pydantic>=2.14 pin (which needs typing-extensions>=4.16); fetch-wheels.py
# ships the newer pure/wasm wheels into wheels/ instead.

def norm(n):
    return n.lower().replace("_", "-")

by_norm = {norm(k): k for k in pkgs}
need, stack = set(), list(SEEDS)
while stack:
    n = norm(stack.pop())
    if n in need:
        continue
    need.add(n)
    key = by_norm.get(n)
    if key:
        stack.extend(pkgs[key].get("depends") or [])

base = f"https://cdn.jsdelivr.net/pyodide/v{pyodide_v}/full"
missing = []
for n in sorted(need):
    key = by_norm.get(n)
    if not key:
        missing.append(n)
        continue
    fname = pkgs[key]["file_name"]
    dest = out / fname
    if dest.exists():
        print(f"  cached: {fname}")
        continue
    print(f"  fetching {fname}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(f"{base}/{fname}") as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    tmp.rename(dest)
if missing:
    sys.exit(f"error: lock packages not in pyodide-lock.json: {missing}")
print(f"  {len(list(out.glob('*.whl')))} lock wheels in {out}")
EOF

# ------------------------------------------------------------- tesseract-wasm
echo "== tesseract-wasm $TESSERACT_WASM_VERSION ==" >&2
if [[ ! -d tesseract-wasm-pkg ]]; then
  mkdir -p tesseract-wasm-pkg
  curl -fsSL --retry 5 -o tw.tgz \
    "https://registry.npmjs.org/tesseract-wasm/-/tesseract-wasm-$TESSERACT_WASM_VERSION.tgz"
  tar xzf tw.tgz -C tesseract-wasm-pkg --strip-components=1
fi
mkdir -p "$OUT/tesseract"
cp tesseract-wasm-pkg/dist/lib.js \
   tesseract-wasm-pkg/dist/tesseract-worker.js \
   tesseract-wasm-pkg/dist/tesseract-core.wasm \
   tesseract-wasm-pkg/dist/tesseract-core-fallback.wasm \
   "$OUT/tesseract/"

# ------------------------------------------------------------------- wheels
echo "== wheels ==" >&2
WHEELS="$OUT/wheels"
rm -rf "$WHEELS"; mkdir -p "$WHEELS"

# pikepdf (wasm, built by build-pikepdf-wasm.sh)
if [[ -n "${PIKEPDF_WHEEL:-}" && -d "$PIKEPDF_WHEEL" ]]; then
  cp "$PIKEPDF_WHEEL"/pikepdf-*.whl "$WHEELS/"
elif [[ -n "${PIKEPDF_WHEEL:-}" && -f "$PIKEPDF_WHEEL" ]]; then
  cp "$PIKEPDF_WHEEL" "$WHEELS/"
else
  found=$(ls "$WORK_DIR"/dist/pikepdf-*.whl 2>/dev/null | head -1 || true)
  [[ -n "$found" ]] || { echo "error: pikepdf wasm wheel not found (run build-pikepdf-wasm.sh)" >&2; exit 1; }
  cp "$found" "$WHEELS/"
fi

# ocrmypdf wheel from the upstream clone
echo "Packaging ocrmypdf from $OCRMYPDF_GIT ..." >&2
rm -rf "$WORK_DIR/wheels-src"; mkdir -p "$WORK_DIR/wheels-src"
python3 "$SCRIPT_DIR/make-ocrmypdf-wheel.py" --src "$OCRMYPDF_GIT" \
  --out "$WORK_DIR/wheels-src"
cp "$WORK_DIR"/wheels-src/ocrmypdf-*.whl "$WHEELS/"

# PyPI + CDN wheels
python3 "$SCRIPT_DIR/fetch-wheels.py" --out "$WHEELS" --pyodide "$PYODIDE_VERSION"

# --------------------------------------------------------------- tessdata
echo "== tessdata (eng) ==" >&2
mkdir -p "$OUT/tessdata"
if [[ ! -s "$OUT/tessdata/eng.traineddata" ]]; then
  curl -fsSL --retry 5 -o "$OUT/tessdata/eng.traineddata" \
    "https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata"
fi

# ---------------------------------------------------------- glue (pyodide/)
# __pycache__ from local dev runs must not ship: stale .pyc files (often
# built by the host python, not pyodide's 3.14) bloat the bundle and would
# be swept into the service worker precache.
rm -rf "$SCRIPT_DIR/pyodide/__pycache__"
rm -rf "$OUT/pyodide-glue"
cp -r "$SCRIPT_DIR/pyodide" "$OUT/pyodide-glue"
find "$OUT/pyodide-glue" -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true

# --------------------------------------------------------------- metadata
python3 - "$OUT" "$PYODIDE_VERSION" "$TESSERACT_WASM_VERSION" <<'EOF'
import hashlib, json, os, sys
out, pyodide_v, tw_v = sys.argv[1], sys.argv[2], sys.argv[3]
def sha256(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()
manifest = {'pyodide': pyodide_v, 'tesseract_wasm': tw_v, 'files': {}}
for root, _, files in os.walk(out):
    for name in files:
        p = os.path.join(root, name)
        rel = os.path.relpath(p, out)
        manifest['files'][rel] = {'sha256': sha256(p), 'size': os.path.getsize(p)}
with open(os.path.join(out, 'runtime-meta.json'), 'w') as f:
    json.dump(manifest, f, indent=1, sort_keys=True)
print('runtime-meta.json:', len(manifest['files']), 'files')
EOF

echo "== runtime bundle ready ==" >&2
du -sh "$OUT" >&2
