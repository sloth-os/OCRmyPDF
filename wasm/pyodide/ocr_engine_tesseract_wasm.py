"""OCRmyPDF OCR engine plugin backed by tesseract-wasm (WebAssembly).

The web app loads tesseract-wasm's synchronous OCREngine in the same Web
Worker that runs Pyodide, and exposes it to Python as a module-level ``js``
object convention: ``js.tesseractWasm`` with

    init()            -> None # instantiate engine + load model
    languages()       -> list[str]
    ocr(hocr_path, text_path, image_path, lang, progress_id) -> None
    orientation(image_path) -> {angle, confidence}
    wordBoxes(image_path, lang) -> list[{left, top, right, bottom, text, confidence}]

This plugin implements OCRmyPDF's OcrEngine interface on top of that bridge.
hOCR output is exactly Tesseract's own (the engine renders it), so
OCRmyPDF's hOCR parser consumes it as if a local tesseract binary had
produced it.
"""

from __future__ import annotations

import json
import logging
import math
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from ocrmypdf import hookimpl
from ocrmypdf.exceptions import MissingDependencyError
from ocrmypdf.pluginspec import OcrEngine, OrientationConfidence

if TYPE_CHECKING:
    from ocrmypdf._options import OcrOptions

log = logging.getLogger(__name__)

MIN_WORDS_FOR_DESKEW = 8


def _bridge():
    """Return the js.tesseractWasm bridge, raising a useful error if absent."""
    try:
        import js
    except ImportError as e:  # not under pyodide
        raise MissingDependencyError(
            "The tesseract-wasm engine only works inside the OCRmyPDF web app "
            "(Pyodide worker)."
        ) from e
    bridge = getattr(js, "tesseractWasm", None)
    if bridge is None:
        raise MissingDependencyError(
            "js.tesseractWasm is not initialized; the web app must set it up "
            "before running OCR."
        )
    return bridge


class TesseractWasmEngine(OcrEngine):
    """Implements OCR with tesseract compiled to WebAssembly."""

    @staticmethod
    def version() -> str:
        return str(_bridge().version())

    @staticmethod
    def creator_tag(options: OcrOptions) -> str:
        return f"OCRmyPDF hOCR + Tesseract WASM {TesseractWasmEngine.version()}"

    def __str__(self) -> str:
        return f"Tesseract WASM {TesseractWasmEngine.version()}"

    @staticmethod
    def languages(options: OcrOptions) -> set[str]:
        return {str(s) for s in _bridge().languages()}

    @staticmethod
    def get_orientation(input_file: Path, options: OcrOptions) -> OrientationConfidence:
        result = json.loads(str(_bridge().orientation(str(input_file))))
        # tesseract-wasm reports clockwise rotation of the text; OCRmyPDF's
        # OrientationConfidence.angle is the correction it will apply.
        angle = int(result.get("angle", 0)) % 360
        confidence = float(result.get("confidence", 0.0))
        return OrientationConfidence(angle=angle, confidence=confidence)

    @staticmethod
    def get_deskew(input_file: Path, options: OcrOptions) -> float:
        """Estimate the deskew angle from recognized line/word boxes.

        Classic tesseract reports a deskew angle directly (from its OSD);
        tesseract-wasm does not expose it, so we take the same approach as
        OCRmyPDF's RapidOCR engine: fit the slope through the centers of the
        recognized text lines. PIL rotates counter-clockwise for positive
        angles, matching the sign convention of the slope we compute.
        """
        boxes = json.loads(str(_bridge().word_boxes(str(input_file))))
        words = [b for b in boxes if b.get("text", "").strip()]
        if len(words) < MIN_WORDS_FOR_DESKEW:
            return 0.0

        # Least-squares slope of the line through word box centers,
        # x horizontal, y downward (screen coordinates).
        xs, ys = [], []
        for w in words:
            xs.append((w["left"] + w["right"]) / 2.0)
            ys.append((w["top"] + w["bottom"]) / 2.0)
        n = float(len(xs))
        mean_x = sum(xs) / n
        mean_y = sum(ys) / n
        num = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
        den = sum((x - mean_x) ** 2 for x in xs)
        if den == 0.0:
            return 0.0
        slope = num / den
        # y grows downward: a line ascending to the right has positive slope
        # here, and needs a counter-clockwise (positive) rotation to level.
        angle = math.degrees(math.atan(slope))
        # Ignore tiny angles; PIL rotate() expands the canvas and costs
        # quality for negligible gain.
        if abs(angle) < 0.25:
            return 0.0
        return angle

    @staticmethod
    def generate_hocr(
        input_file: Path,
        output_hocr: Path,
        output_text: Path,
        options: OcrOptions,
    ) -> None:
        bridge = _bridge()
        languages = list(options.languages or ["eng"])
        hocr = str(bridge.recognize_to_hocr(str(input_file), languages[0]))
        text = str(bridge.recognized_text())
        output_hocr.write_text(hocr, encoding="utf-8")
        output_text.write_text(text, encoding="utf-8")

    @staticmethod
    def generate_pdf(
        input_file: Path,
        output_pdf: Path,
        output_text: Path,
        options: OcrOptions,
    ) -> None:
        raise NotImplementedError(
            "The tesseract-wasm engine cannot produce PDFs directly. "
            "Use --pdf-renderer hocr instead of sandwich mode."
        )


@dataclass
class _EngineState:
    """Selected when options.ocr_engine is 'tesseract-wasm'."""


def _selected(options) -> bool:
    engine = getattr(options, "ocr_engine", "auto")
    return engine in ("auto", "tesseract", "tesseract-wasm")


@hookimpl
def get_ocr_engine(options):
    if options is not None and not _selected(options):
        return None
    return TesseractWasmEngine()


@hookimpl
def initialize(plugin_manager):
    """Neutralize subprocess-based external tool probes.

    OCRmyPDF's optimizer probes pngquant/jbig2enc availability by executing
    them (``ToolProbe.available()`` → ``subprocess.run``). Emscripten raises
    ``OSError(ENOTSUP)`` for any process spawn, which would kill the whole
    job during optimization. These tools do not exist in the wasm sandbox,
    so report them as unavailable without probing; the pikepdf-based
    optimization itself is unaffected.
    """
    from ocrmypdf._exec import jbig2enc, pngquant

    pngquant.available = lambda: False
    jbig2enc.available = lambda: False


@hookimpl
def check_options(options):
    """Reject options the wasm environment cannot honour."""
    if options is not None and not _selected(options):
        return
    if getattr(options, "pdf_renderer", "auto") == "sandwich":
        from ocrmypdf.exceptions import BadArgsError

        raise BadArgsError(
            "--pdf-renderer sandwich is not supported in the web build. "
            "Use --pdf-renderer hocr."
        )
    if getattr(options, "clean", False) or getattr(options, "clean_final", False):
        from ocrmypdf.exceptions import BadArgsError

        raise BadArgsError(
            "--clean/--clean-final (unpaper) is not available in the web build."
        )
