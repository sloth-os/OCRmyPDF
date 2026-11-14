#!/usr/bin/env python3
"""Build an ocrmypdf wheel from a source checkout, offline.

Hatchling (ocrmypdf's build backend) works fine without network as long as
it is importable, but calling it as a subprocess drags in build isolation.
We replicate what it does for this project: copy src/ocrmypdf plus the
package data, and write metadata derived from pyproject.toml.

Usage: make-ocrmypdf-wheel.py --src /path/to/OCRmyPDF --out DIR [--ref REF]
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
import re
import sys
import zipfile
from pathlib import Path

SETUPTOOLS_STUB = None


def read_metadata(src: Path) -> dict[str, str]:
    """Parse the minimal [project] table fields from pyproject.toml."""
    text = (src / "pyproject.toml").read_text(encoding="utf-8")
    fields: dict[str, str] = {}
    m = re.search(r"^\[project\]\n((?:.*\n)*?)(?=^\[)", text, re.M)
    assert m, "no [project] table"
    body = m.group(1)
    for line in body.splitlines():
        mm = re.match(r"^(\w+)\s*=\s*(.+)$", line.strip())
        if not mm:
            continue
        key, raw = mm.groups()
        if key in ("name", "version", "description", "requires-python"):
            fields[key] = raw.strip().strip('"').strip("'")
    assert "name" in fields and "version" in fields, "missing name/version"
    return fields


def file_digest(data: bytes) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--ref", default="")
    args = ap.parse_args()

    src = args.src.resolve()
    meta = read_metadata(src)
    name = meta["name"].replace("-", "_")
    version = meta["version"]

    distinfo = f"{name}-{version}.dist-info"
    pkg_dir = src / "src" / "ocrmypdf"

    out_whl = args.out / f"{name}-{version}-py3-none-any.whl"
    args.out.mkdir(parents=True, exist_ok=True)

    # Collect package files
    files: list[tuple[str, Path]] = []
    for p in sorted(pkg_dir.rglob("*")):
        if p.is_file():
            rel = p.relative_to(pkg_dir.parent)
            files.append((str(rel), p))
    # top-level data: LICENSE for dist-info
    license_file = src / "LICENSE"

    with zipfile.ZipFile(out_whl, "w", zipfile.ZIP_DEFLATED) as z:
        for rel, p in files:
            z.write(p, rel)

        # METADATA
        # Mirrors upstream's [project] dependencies, with one wasm-specific
        # deviation: Pillow>=13 (upstream) is relaxed to >=12.2 because
        # pyodide 314.0.8's lock ships pillow 12.2.0 and no Pillow 13 wasm
        # wheel exists — micropip would refuse to install otherwise.
        requires = [
            "fpdf2>=2.9.0",
            "img2pdf>=0.6",
            "packaging>=20",
            "pdfminer.six>=20260107",
            "pikepdf[pdfa]>=10.18",
            "Pillow>=12.2",
            "pluggy>=1",
            "pydantic>=2.14",
            "pypdfium2>=5.15.0",
            "rich>=13",
            "uharfbuzz>=0.53.2",
        ]
        md = io.StringIO()
        md.write(f"Metadata-Version: 2.4\n")
        md.write(f"Name: {meta['name']}\n")
        md.write(f"Version: {version}\n")
        md.write(f"Summary: {meta.get('description', '')}\n")
        md.write(f"Requires-Python: {meta.get('requires-python', '>=3.11')}\n")
        for r in requires:
            md.write(f"Requires-Dist: {r}\n")
        if args.ref:
            md.write(f"Project-URL: Upstream, https://github.com/ocrmypdf/OCRmyPDF/tree/{args.ref}\n")
        metadata = md.getvalue().encode()

        # WHEEL
        wheel_md = (
            "Wheel-Version: 1.0\n"
            "Generator: ocrmypdf-web (manual)\n"
            "Root-Is-Purelib: true\n"
            "Tag: py3-none-any\n"
        ).encode()

        # RECORD
        record = io.StringIO()
        entries: list[tuple[str, str, str, int]] = []
        for rel, p in files:
            data = p.read_bytes()
            entries.append((rel, file_digest(data), str(len(data))))
        entries.append((f"{distinfo}/METADATA", file_digest(metadata), str(len(metadata))))
        entries.append((f"{distinfo}/WHEEL", file_digest(wheel_md), str(len(wheel_md))))
        for rel, digest, size in entries:
            record.write(f"{rel},{digest},{size}\n")
        record.write(f"{distinfo}/RECORD,,\n")

        z.writestr(f"{distinfo}/METADATA", metadata)
        z.writestr(f"{distinfo}/WHEEL", wheel_md)
        if license_file.exists():
            z.write(license_file, f"{distinfo}/licenses/LICENSE")
        z.writestr(f"{distinfo}/RECORD", record.getvalue().encode())

    print(f"wrote {out_whl} ({out_whl.stat().st_size} bytes, {len(files)} files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
