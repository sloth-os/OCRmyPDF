# OCRmyPDF WebAssembly

Run [OCRmyPDF](https://github.com/ocrmypdf/OCRmyPDF) entirely in your browser —
no server, no upload. Your PDFs never leave your machine.

Published weekly to GitHub Pages from the latest upstream OCRmyPDF `main`:

**https://sloth-os.github.io/OCRmyPDF/**

## How it works

- **Pyodide** (CPython compiled to WebAssembly) runs OCRmyPDF's Python pipeline
- **pikepdf** is cross-compiled to wasm (with **qpdf**) by our weekly build
- **pypdfium2** rasterizes pages to images (PyPI wasm wheel)
- **fpdf2** renders the OCR text layer into the PDF
- **Tesseract** runs via [tesseract-wasm](https://github.com/robertknight/tesseract-wasm)
  in a dedicated Web Worker, driven from Python through a synchronous JS bridge
- **PDF/A** conversion uses pikepdf's speculative (internal) backend, so
  Ghostscript is not needed
- **img2pdf / pdfminer.six** come from pure-Python wheels

Everything below the drag-and-drop UI happens offline, on your device.

## Features

- **100% client-side** — files are processed in your browser and never uploaded
- **Installable PWA** — works fully offline after the first visit
- **File handling** — register the app as a handler for PDF files
  (Chrome/Edge: open a PDF with "OCRmyPDF" from the OS file dialog)
- **Language selection** — Tesseract traineddata models for many languages,
  fetched once and cached offline by the service worker
- **PDF output options** — PDF, PDF/A-2b; deskew; rotation detection; sidecar text
- **Drag & drop or file picker**, with per-page progress

## Supported OCRmyPDF options

The web UI exposes the most useful options. The pipeline runs with:

| Option | Web default | Notes |
|---|---|---|
| `--output-type pdf` | ✓ | always available |
| `--output-type pdfa` | ✓ | via pikepdf's internal backend |
| `--rasterizer pypdfium` | fixed | Ghostscript rasterizer not available in wasm |
| `--pdf-renderer hocr` | fixed | tesseract-wasm produces hOCR; OCRmyPDF's own hOCR→PDF renderer is used |
| `--deskew` | optional | implemented in Python/Pillow |
| `--rotate-pages` | optional | tesseract-wasm orientation detection |
| `--optimize 1` | fixed | safe lossless optimization via pikepdf; pngquant/jbig2enc unavailable |
| `--image-dpi` | auto | for image inputs, when the format carries no DPI |
| `--sidecar` | ✓ | plain-text output |

## Build & deployment

A [GitHub Actions workflow](.github/workflows/deploy.yml) runs weekly (and on
push to `main`) to:

1. Download the Pyodide cross-build environment (Python 3.14 + emscripten 5.0.3)
2. Compile qpdf → libqpdf for wasm32-emscripten
3. Build pikepdf against it (scikit-build-core + nanobind)
4. Assemble the runtime: Pyodide + micropip-installed wheels + OCRmyPDF from upstream
5. Smoke-test the pipeline headlessly in Node (`ocrmypdf.ocr()` end to end)
6. Deploy everything to GitHub Pages with a hashed service worker manifest

Manual runs are possible from the Actions tab ("Run workflow"); add
`skip-caches=true` to ignore build caches.

### Repo layout

```
wasm/                  build scripts (qpdf, pikepdf, runtime bundle)
  build-pikepdf-wasm.sh
  build-qpdf-wasm.sh
  build-runtime.sh
  smoke-test.mjs
  pyodide/ runtime Python glue
    ocr_engine_tesseract_wasm.py   OCRmyPDF plugin → tesseract-wasm bridge
    sequential_executor.py          OCRmyPDF plugin → single-threaded executor
    wasmenv.py                      platform shims (path, multiprocessing)
    package.py micropip install driver
public/                static web app (PWA)
  index.html  app.js  manifest.webmanifest  sw.js  styles.css
scripts/               local helper scripts
.github/workflows/deploy.yml
```

## Privacy

No telemetry, no analytics, no uploads. The only network traffic is the one-time
download of the app itself, and — on first use of a language — its Tesseract
model. Models are cached by the service worker and reused offline.

## License

This repository's glue code is MPL-2.0 (matching OCRmyPDF). It ships these
components, each under its own license: OCRmyPDF (MPL-2.0), CPython (PSF),
Pyodide (MPL-2.0), pikepdf + qpdf (MPL-2.0 / Apache-2.0), pypdfium2 (Apache-2.0
/BSD), fpdf2 (LGPL-3.0), tesseract-wasm (BSD-2-Clause) and Tesseract
(Apache-2.0), tessdata models (Apache-2.0).
