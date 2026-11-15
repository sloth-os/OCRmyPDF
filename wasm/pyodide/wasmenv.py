"""Runtime shims and entry points for OCRmyPDF under Pyodide.

Imported (not installed) by the web worker after Pyodide boots. Sets up:

* plugin paths that select the wasm-friendly executor and OCR engine
* Pillow decompression bomb allowance appropriate for scanned pages
* a high-level ``run_ocr()`` that the worker calls once per job, with
  progress events forwarded to the JS side via ``pyodide.ffi.run_sync``-free
  callbacks (the pipeline is synchronous; events are buffered and flushed
  through the bridge object the worker polls between steps).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import PIL.Image

import ocrmypdf
from ocrmypdf import OcrOptions
from ocrmypdf.exceptions import ExitCode as OcrmypdfExitCode

log = logging.getLogger(__name__)

# Plugins shipped next to this file; loaded by module name.
PLUGIN_MODULES = (
    "sequential_executor",
    "ocr_engine_tesseract_wasm",
)

# scanned pages are routinely > 100 MP when rasterized at 300 dpi
PIL.Image.MAX_IMAGE_PIXELS = 1_000_000_000


@dataclass
class JobProgress:
    """Events emitted during a run; drained by the JS worker."""

    events: list[dict[str, Any]] = field(default_factory=list)
    pages_done: int = 0
    total_pages: int = 0
    current_step: str = ""


_ACTIVE_PROGRESS: JobProgress | None = None
_JS_EVENT_CALLBACK: Any = None


def set_event_callback(cb: Any) -> None:
    """Register the worker's live progress relay.

    Called once from the JS worker glue (``wasmenv.set_event_callback(
    _tw_post_event)`` in public/worker.js). Events are both buffered on the
    active :class:`JobProgress` (returned by :func:`run_ocr`) and pushed live
    through this callback so the web UI updates while a job is still running.
    """
    global _JS_EVENT_CALLBACK
    _JS_EVENT_CALLBACK = cb


def _emit(event: dict[str, Any]) -> None:
    p = _ACTIVE_PROGRESS
    if p is not None:
        p.events.append(event)
    cb = _JS_EVENT_CALLBACK
    if cb is not None:
        try:
            cb(event)
        except Exception:  # progress must never kill a job
            pass


def install_progress_hooks() -> None:
    """Wire executor events + logging into the progress buffer."""
    import importlib.util
    import sys

    here = Path(__file__).parent
    mod_path = here / "sequential_executor.py"
    if "sequential_executor" not in sys.modules:
        spec = importlib.util.spec_from_file_location("sequential_executor", mod_path)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        sys.modules["sequential_executor"] = module
        spec.loader.exec_module(module)
    set_event_callback = sys.modules["sequential_executor"].set_event_callback

    set_event_callback(_emit)

    class _ProgressHandler(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            if record.levelno >= logging.INFO:
                _emit(
                    {
                        "type": "log",
                        "level": record.levelname,
                        "message": record.getMessage(),
                    }
                )

    root = logging.getLogger()
    # idempotent
    for h in list(root.handlers):
        if isinstance(h, _ProgressHandler):
            return
    handler = _ProgressHandler()
    root.addHandler(handler)


def default_plugins() -> list[str]:
    """Plugin list for OcrOptions(plugins=...)."""
    here = Path(__file__).parent
    return [str(here / f"{name}.py") for name in PLUGIN_MODULES]


def build_options(
    input_path: str,
    output_path: str,
    *,
    language: str = "eng",
    deskew: bool = False,
    rotate_pages: bool = False,
    rotate_pages_threshold: float = 14.0,
    output_type: str = "pdf",
    image_dpi: int | None = None,
    sidecar: str | None = None,
    optimize: int = 1,
    mode: str = "default",
    pages: str | None = None,
    max_image_mpixels: float = 250.0,
    keep_temporary_files: bool = False,
) -> OcrOptions:
    """Build OcrOptions pinned to the wasm-supported configuration.

    ``mode`` is one of default/skip/redo/force (legacy force_ocr etc. are
    translated by OcrOptions itself).
    """
    kwargs: dict[str, Any] = dict(
        input_file=input_path,
        output_file=output_path,
        languages=[language],
        # Explicit engine name: the builtin tesseract plugin's check_options
        # probes for a tesseract *binary* (subprocess) whenever ocr_engine is
        # 'auto' or 'tesseract'. Naming our engine disables that probe and
        # selects ours (pluginspec get_ocr_engine is firstresult, plugins
        # registered later win).
        ocr_engine="tesseract-wasm",
        # Web build has no ghostscript: rasterize with pypdfium2, render with
        # hOCR, and use pikepdf's speculative PDF/A conversion.
        rasterizer="pypdfium",
        pdf_renderer="hocr",
        pdfa_backend="internal",
        output_type=output_type,
        optimize=optimize,
        deskew=deskew,
        rotate_pages=rotate_pages,
        rotate_pages_threshold=rotate_pages_threshold,
        jobs=1,
        use_threads=True,
        max_image_mpixels=max_image_mpixels,
        keep_temporary_files=keep_temporary_files,
        plugins=default_plugins(),
        progress_bar=False,
        mode=mode,
    )
    if image_dpi:
        kwargs["image_dpi"] = image_dpi
    if sidecar:
        kwargs["sidecar"] = sidecar
    if pages:
        kwargs["pages"] = pages
    return OcrOptions(**kwargs)


def run_ocr(options: OcrOptions) -> dict[str, Any]:
    """Run one OCR job, buffering progress events.

    Returns {ok, exit_code, events, message}.
    """
    global _ACTIVE_PROGRESS
    progress = JobProgress()
    _ACTIVE_PROGRESS = progress

    install_progress_hooks()

    exit_code: OcrmypdfExitCode | int
    try:
        exit_code = ocrmypdf.ocr(options)
        ok = int(exit_code) == 0
        message = "" if ok else f"OCRmyPDF exited with code {int(exit_code)}"
    except Exception as e:  # noqa: BLE001 - surfaced to the UI
        log.exception("OCR job failed")
        ok = False
        message = f"{type(e).__name__}: {e}"
        exit_code = -1
    finally:
        _ACTIVE_PROGRESS = None

    return {
        "ok": ok,
        "exit_code": int(exit_code),
        "events": progress.events,
        "message": message,
    }


def ocr(
    input_path: str,
    output_path: str,
    **kwargs: Any,
) -> dict[str, Any]:
    """Convenience one-shot used by the smoke test and the worker."""
    options = build_options(input_path, output_path, **kwargs)
    return run_ocr(options)


def version_info() -> dict[str, Any]:
    """Report component versions for the UI's about panel."""
    import importlib.metadata

    out = {"ocrmypdf": ocrmypdf.__version__}
    for pkg in ("pikepdf", "pypdfium2", "Pillow", "fpdf2"):
        try:
            out[pkg] = importlib.metadata.version(pkg)
        except importlib.metadata.PackageNotFoundError:
            out[pkg] = None
    try:
        from pikepdf import __version__ as _pq
    except Exception:
        _pq = None
    if _pq:
        out["pikepdf"] = _pq
    return out
