"""OCRmyPDF executor plugin for WebAssembly: sequential, no worker pool.

The wasm Python runtime is single-threaded and has no semaphores or fork, so
the standard ThreadPool/ProcessPool executors cannot be used. OCRmyPDF ships
a SerialExecutor for exactly this situation (also used by pdfinfo and the
optimizer); this plugin selects it for the whole pipeline and forwards
page-completion events to a JS callback so the web UI can show progress.
"""

from __future__ import annotations

import logging
import sys
from collections.abc import Callable

from ocrmypdf import Executor, hookimpl
from ocrmypdf._concurrent import SerialExecutor
from ocrmypdf._progressbar import NullProgressBar

log = logging.getLogger(__name__)

# The callback lives on `sys`, NOT in a module global: this file gets loaded
# TWICE as two distinct module instances — once by wasmenv.install_progress_hooks
# (spec_from_file_location under the name "sequential_executor") and once by
# OCRmyPDF's plugin manager (_plugin_manager.py loads each plugin path as a
# fresh module and replaces the sys.modules entry). A module-global _CALLBACK
# set on instance A would be invisible to the EventedSerialExecutor class from
# instance B that the pipeline actually runs. A sys attribute is shared.
_CALLBACK_ATTR = "ocrmypdf_wasm_progress_callback"


def set_event_callback(cb: Callable[[dict], None] | None) -> None:
    """Let the web app observe pipeline progress (called from wasmenv)."""
    setattr(sys, _CALLBACK_ATTR, cb)


def _callback() -> Callable[[dict], None] | None:
    return getattr(sys, _CALLBACK_ATTR, None)


class EventedSerialExecutor(SerialExecutor):
    """SerialExecutor that emits per-page progress events.

    Event types match what public/app.js consumes:
      ``{"type": "page-start", "page": i, "total": n}`` before each task
      ``{"type": "page-done",  "page": i, "total": n}`` after each task
      ``{"type": "finalize"}`` once all page tasks are done (the pipeline's
      finalization — merging text, optimization, PDF/A conversion — follows)

    The standard ``task_finished`` callback is still invoked per task so the
    pipeline's own bookkeeping (progress bar updates) is unaffected.
    """

    def _emit(self, event: dict) -> None:
        cb = _callback()
        if cb is not None:
            try:
                cb(event)
            except Exception:  # progress must never kill a job
                log.debug("progress callback failed", exc_info=True)

    def _execute(
        self,
        *,
        use_threads,
        max_workers,
        progress_kwargs,
        worker_initializer,
        task,
        task_arguments,
        task_finished,
    ):
        # Materialize so the page count is known up front (the default
        # implementation iterates lazily and only ever sees one task at a
        # time). SerialExecutor runs everything in the parent context, so
        # this is safe.
        all_args = list(task_arguments)
        total = len(all_args)
        with self.pbar_class(**progress_kwargs) as pbar:
            for page, args in enumerate(all_args):
                self._emit({"type": "page-start", "page": page, "total": total})
                result = task(*args)
                task_finished(result, pbar)
                self._emit({"type": "page-done", "page": page, "total": total})
        if total:
            self._emit({"type": "finalize", "detail": "assembling output PDF"})


@hookimpl
def get_executor(progressbar_class):
    return EventedSerialExecutor(pbar_class=progressbar_class)


@hookimpl
def get_progressbar_class():
    return NullProgressBar
