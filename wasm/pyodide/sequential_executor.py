"""OCRmyPDF executor plugin for WebAssembly: sequential, no worker pool.

The wasm Python runtime is single-threaded and has no semaphores or fork, so
the standard ThreadPool/ProcessPool executors cannot be used. OCRmyPDF ships
a SerialExecutor for exactly this situation (also used by pdfinfo and the
optimizer); this plugin selects it for the whole pipeline and forwards
page-completion events to a JS callback so the web UI can show progress.
"""

from __future__ import annotations

import logging
from collections.abc import Callable

from ocrmypdf import Executor, hookimpl
from ocrmypdf._concurrent import SerialExecutor
from ocrmypdf._progressbar import NullProgressBar

log = logging.getLogger(__name__)

_CALLBACK: Callable[[dict], None] | None = None


def set_event_callback(cb: Callable[[dict], None] | None) -> None:
    """Let the web app observe pipeline progress (called from wasmenv)."""
    global _CALLBACK
    _CALLBACK = cb


class EventedSerialExecutor(SerialExecutor):
    """SerialExecutor that emits a page_done event per finished task."""

    def _execute(self, *, task_finished, **kwargs):
        orig_finished = task_finished

        def wrapped_finished(result, pbar):
            orig_finished(result, pbar)
            if _CALLBACK is not None:
                try:
                    _CALLBACK({"type": "page_done", "result": repr(result)})
                except Exception:  # progress must never kill a job
                    log.debug("progress callback failed", exc_info=True)

        super()._execute(task_finished=wrapped_finished, **kwargs)


@hookimpl
def get_executor(progressbar_class):
    return EventedSerialExecutor(pbar_class=progressbar_class)


@hookimpl
def get_progressbar_class():
    return NullProgressBar
