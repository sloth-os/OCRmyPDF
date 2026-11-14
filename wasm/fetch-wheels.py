#!/usr/bin/env python3
"""Fetch exact wheels for the OCRmyPDF wasm runtime.

Downloads, from PyPI and the Pyodide CDN, the wheels the web app needs:

- wasm wheels (pyemscripten_2026_0 / wasm32) for native modules
- pure wheels (py3-none-any) for pure-Python modules

Pyodide itself provides: pillow, numpy, pydantic, rich, lxml, fonttools,
jsonschema, referencing, attrs, annotated-types, cryptography, packaging,
pluggy, typing-extensions... those are installed from the pyodide-lock at
runtime (micropip resolves them from the CDN or our mirrored dist).

Usage:
  fetch-wheels.py --out DIR [--pyodide 314.0.8]
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path

WASM_TAG = "pyemscripten_2026_0_wasm32"

# package -> version; every entry must have either a wasm wheel or be pure
PYPI_WHEELS: dict[str, str] = {
    "pypdfium2": "5.15.2", # wasm wheel: py3-none-pyemscripten_2026_0
    "uharfbuzz": "0.57.0",          # wasm wheel: cp311-abi3-pyemscripten_2026_0
    "charset-normalizer": "3.5.2",  # wasm wheel cp314... and pure wheel too
    "fpdf2": "2.9.0",               # pure
    "img2pdf": "0.6.3",             # pure
    "pdfminer.six": "20260107",     # pure
    "defusedxml": "0.7.1",          # pure
    "pydyf": None,                  # fpdf2 dep, pure - resolve latest
    "pypdf": None,                  # img2pdf dep, pure
    # rich's deps: the pyodide lock lists rich with depends=[], so micropip
    # never pulls these transitively — they must be shipped explicitly.
    "markdown-it-py": None,         # rich dep, pure
    "mdurl": None,                  # markdown-it-py dep, pure
    "pygments": None,               # rich.traceback dep, pure
}

# from the Pyodide CDN (built for the exact runtime version)
CDN_WHEELS: dict[str, str] = {
    "cryptography": "47.0.0",       # wasm wheel exists on CDN
    "pycryptodome": None,           # cryptography dep on some versions
}


def pypi_files(pkg: str, version: str | None) -> list[dict]:
    url = (
        f"https://pypi.org/pypi/{pkg}/{version}/json"
        if version
        else f"https://pypi.org/pypi/{pkg}/json"
    )
    with urllib.request.urlopen(url) as r:
        data = json.load(r)
    if version:
        return data["urls"]
    return data["urls"]  # latest release files


def pick_wasm(files: list[dict], pkg: str) -> dict:
    for f in files:
        if WASM_TAG in f["filename"]:
            return f
    raise SystemExit(f"no {WASM_TAG} wheel for {pkg}: " + ", ".join(
        f["filename"] for f in files[:5]))


def pick_pure(files: list[dict], pkg: str) -> dict:
    for f in files:
        if f["filename"].endswith("py3-none-any.whl"):
            return f
    raise SystemExit(f"no pure wheel for {pkg}")


def download(url: str, dest: Path) -> None:
    if dest.exists():
        print(f"  cached: {dest.name}")
        return
    print(f"  fetching {dest.name}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url) as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    tmp.rename(dest)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--pyodide", default="314.0.8")
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)

    print("PyPI wheels:")
    for pkg, ver in PYPI_WHEELS.items():
        files = pypi_files(pkg, ver)
        if pkg in ("pypdfium2", "uharfbuzz", "charset-normalizer"):
            target = pick_wasm(files, pkg)
        else:
            target = pick_pure(files, pkg)
        download(target["url"], args.out / target["filename"])

    print("Pyodide CDN wheels:")
    base = f"https://cdn.jsdelivr.net/pyodide/v{args.pyodide}/full"
    # Discover exact filenames via the lock file
    lock_url = f"{base}/pyodide-lock.json"
    with urllib.request.urlopen(lock_url) as r:
        lock = json.load(r)
    pkgs = lock["packages"]
    for pkg in ("cryptography",):
        if pkg not in pkgs:
            print(f"  {pkg}: not in pyodide lock; skipping (pyodide provides at runtime)")
            continue
        fname = pkgs[pkg]["file_name"]
        download(f"{base}/{fname}", args.out / fname)

    print("done:", len(list(args.out.glob('*.whl'))), "wheels")
    return 0


if __name__ == "__main__":
    sys.exit(main())
