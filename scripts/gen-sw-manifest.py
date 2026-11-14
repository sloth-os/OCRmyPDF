#!/usr/bin/env python3
"""Rewrite public/sw.js with the exact precache manifest for a built site.

Usage: gen-sw-manifest.py SITE_DIR [--version V]

Precaches (relative to the site root, i.e. the Pages base path):
  - app shell: index.html, app.js, worker.js, styles.css, manifest, icons
  - the full runtime bundle: pyodide/, tesseract/, wheels/, pyodide-glue/,
    tessdata/eng.traineddata, runtime-meta.json

Everything else (other tessdata models) is runtime-cached on first use.

The service worker is written with an immutable asset list under a unique
build VERSION, so a deploy invalidates old caches on activate.
"""

from __future__ import annotations

import argparse
import datetime
import json
import re
import sys
from pathlib import Path

SHELL_FILES = [
    "index.html",
    "app.js",
    "worker.js",
    "styles.css",
    "manifest.webmanifest",
    "runtime-meta.json",
    "icons/icon-192.png",
    "icons/icon-512.png",
    "icons/icon-maskable-512.png",
]

SHELL_DIRS = ["pyodide", "tesseract", "wheels", "pyodide-glue", "tessdata"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("site", type=Path)
    ap.add_argument("--version", default=None)
    args = ap.parse_args()

    site = args.site
    sw_path = site / "sw.js"
    if not sw_path.exists():
        # when run from repo root before copying public/
        sw_path = Path(__file__).parent.parent / "public" / "sw.js"
        if not sw_path.exists():
            print(f"error: sw.js not found in {site}", file=sys.stderr)
            return 1

    version = args.version or datetime.datetime.now(datetime.timezone.utc).strftime(
        "%Y%m%d%H%M%S"
    )

    # Collect relative URLs (site-root-relative, no leading slash so it works
    # under a Pages subpath).
    urls: list[str] = []
    for name in SHELL_FILES:
        if (site / name).exists():
            urls.append(name)
    for d in SHELL_DIRS:
        droot = site / d
        if not droot.is_dir():
            continue
        for p in sorted(droot.rglob("*")):
            if p.is_file():
                # Never precache bytecode caches: stale host-python .pyc
                # files don't belong in the shipped site.
                if "__pycache__" in p.parts:
                    continue
                urls.append(str(p.relative_to(site)))

    # sanity: everything must exist
    for u in urls:
        assert (site / u).exists(), u

    # total size warning
    total = sum((site / u).stat().st_size for u in urls)
    print(f"precache: {len(urls)} files, {total / 1e6:.1f} MB")

    sw = sw_path.read_text(encoding="utf-8")
    sw = re.sub(
        r'const VERSION = "[^"]*";', f'const VERSION = "{version}";', sw, count=1
    )
    url_list = ", ".join(json.dumps(u) for u in urls)
    sw = re.sub(
        r"const PRECACHE_URLS = [^;]+;",
        f"const PRECACHE_URLS = [{url_list}];",
        sw,
        count=1,
        flags=re.S,
    )
    sw_path.write_text(sw, encoding="utf-8")
    print(f"wrote {sw_path} (version {version})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
