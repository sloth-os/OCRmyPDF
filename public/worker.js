/* OCRmyPDF worker: Pyodide (CPython wasm + OCRmyPDF) + tesseract-wasm in one
 * Web Worker, with a synchronous bridge between them.
 *
 * Why one worker: OCRmyPDF's plugin API is synchronous Python, and
 * tesseract-wasm's OCREngine is a synchronous JS API. Co-hosting both
 * runtimes here lets the plugin call the engine directly, exactly like it
 * would call a native tesseract binary.
 *
 * Protocol (postMessage):
 *   in:  {id, type:"prewarm"} | {id, type:"ocr", file, options}
 *   out: {id, result|error}      — reply to a call
 *   out: {id:"progress", event}  — progress events during a job
 */

import { createOCREngine, supportsFastBuild } from "./tesseract/lib.js";

const TESSERACT_VERSION = "5.5-wasm";

let pyodide = null;
let engine = null;
let lastText = "";
let booted = false;
let bootPromise = null;
let currentLanguage = null;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

function progress(event) {
  post({ id: "progress", event });
}

/* --------------------------------------------------------- tesseract engine */
async function ensureEngine(language) {
  if (engine && currentLanguage === language) return engine;

  if (!engine) {
    progress({ type: "model", detail: "loading tesseract" });
    const wasmName = supportsFastBuild()
      ? "tesseract-core.wasm"
      : "tesseract-core-fallback.wasm";
    const wasmBinary = await (await fetch(`tesseract/${wasmName}`)).arrayBuffer();
    engine = await createOCREngine({ wasmBinary });
  }
  progress({ type: "model", detail: `loading ${language}.traineddata` });
  const model = await (await fetch(`tessdata/${language}.traineddata`)).arrayBuffer();
  engine.loadModel(new Uint8Array(model));
  currentLanguage = language;
  return engine;
}

/* ------------------------------------------------------------- image decode */
/* The pipeline writes PNGs to the pyodide MEMFS; tesseract wants pixels.
 * Pillow (already loaded in Pyodide) does the decode, and returns
 * [width, height, rgba-bytes] as JSON. The byte list round trip is O(w*h)
 * small ints — not fast, but simple, and only used per page.
 * (A base64+atob typed-array path would be ~3x faster if it ever matters.)
 */
function decodeImage(pyPath) {
  const code = `import json as _json
from PIL import Image as _Image
im = _Image.open(${JSON.stringify(pyPath)}).convert("RGBA")
_json.dumps([im.width, im.height, list(im.tobytes())])`;
  const [w, h, bytes] = JSON.parse(pyodide.runPython(code));
  return { width: w, height: h, data: Uint8Array.from(bytes) };
}

/* The object exposed to Python as js.tesseractWasm. JS methods here are
 * wrapped in staticmethod() on the Python side (see SETUP_BRIDGE_PY). */
function makeBridgeShim() {
  return {
    version: () => TESSERACT_VERSION,
    languages: () => ["eng"],
    orientation: (pyPath) => {
      engine.loadImage(decodeImage(pyPath));
      const o = engine.getOrientation();
      return JSON.stringify({ angle: o.rotation, confidence: o.confidence });
    },
    recognize_to_hocr: (pyPath) => {
      engine.loadImage(decodeImage(pyPath));
      const hocr = engine.getHOCR();
      lastText = engine.getText();
      return hocr;
    },
    recognized_text: () => lastText,
    word_boxes: (pyPath) => {
      engine.loadImage(decodeImage(pyPath));
      return JSON.stringify(engine.getTextBoxes("word"));
    },
  };
}

/* Python glue: wrap the JS shim as js.tesseractWasm (methods become
 * staticmethods so the plugin's class-level calls work), and relay wasmenv
 * progress events to the JS function tw_post_event (a global, set from JS
 * before this runs). */
const SETUP_BRIDGE_PY = `import js, json as _json
import wasmenv

_shim = js.tw_engine_shim

class _Bridge:
    version = staticmethod(_shim.version)
    languages = staticmethod(_shim.languages)
    orientation = staticmethod(_shim.orientation)
    recognize_to_hocr = staticmethod(_shim.recognize_to_hocr)
    recognized_text = staticmethod(_shim.recognized_text)
    word_boxes = staticmethod(_shim.word_boxes)

js.tesseractWasm = _Bridge

def _tw_post_event(ev):
    tw_post_event(_json.dumps(ev))

wasmenv.set_event_callback(_tw_post_event)
print("[worker] js.tesseractWasm bridge + progress relay installed")
`;

/* ------------------------------------------------------------- pyodide boot */
async function bootPyodide() {
  if (booted) return;
  if (bootPromise) return bootPromise;

  bootPromise = (async () => {
    progress({ type: "boot", detail: "loading Pyodide" });
    const { loadPyodide } = await import("./pyodide/pyodide.mjs");
    pyodide = await loadPyodide({ indexURL: "./pyodide/" });

    progress({ type: "install", detail: "installing wheels" });
    await pyodide.loadPackage("micropip");
    const meta = await (await fetch("runtime-meta.json")).json();
    const wheelUrls = Object.keys(meta.files)
      .filter((p) => p.startsWith("wheels/") && p.endsWith(".whl"))
      .map((p) => new URL(p, self.location.href).href);
    await pyodide.runPythonAsync(
      `import micropip, json
await micropip.install(json.loads(${JSON.stringify(JSON.stringify(wheelUrls))}))`
    );

    // Materialize the runtime Python glue into the pyodide FS. The glue is
    // plain .py files served over HTTP; pyodide's import machinery only sees
    // its own MEMFS, so sys.path.insert("pyodide-glue") finds nothing until
    // the files are fetched and written there.
    progress({ type: "install", detail: "loading python glue" });
    const gluePaths = Object.keys(meta.files).filter(
      (p) => p.startsWith("pyodide-glue/") && p.endsWith(".py")
    );
    pyodide.FS.mkdirTree("pyodide-glue");
    for (const p of gluePaths) {
      const res = await fetch(new URL(p, self.location.href).href);
      if (!res.ok) throw new Error(`glue fetch failed: ${p} (${res.status})`);
      pyodide.FS.writeFile(p, new Uint8Array(await res.arrayBuffer()));
    }
    await pyodide.runPythonAsync(`import sys
sys.path.insert(0, "pyodide-glue")
import wasmenv`);

    // JS objects the glue references as Python globals
    pyodide.globals.set("tw_engine_shim", makeBridgeShim());
    pyodide.globals.set(
      "tw_post_event",
      (jsonEv) => {
        try {
          progress(JSON.parse(jsonEv));
        } catch {
          /* progress must never kill a job */
        }
      }
    );
    // Make them visible on the js module too (the glue imports js)
    pyodide.runPython("import js\njs.tw_engine_shim = tw_engine_shim");

    await pyodide.runPythonAsync(SETUP_BRIDGE_PY);

    booted = true;
    progress({ type: "boot", detail: "ready" });
  })();

  try {
    await bootPromise;
  } catch (e) {
    bootPromise = null; // allow retry
    throw e;
  }
  return bootPromise;
}

/* ------------------------------------------------------------------- run OCR */
async function runOcr(file, options) {
  await bootPyodide();
  await ensureEngine(options.language);

  // Stage the file into the pyodide FS
  const bytes = new Uint8Array(await file.arrayBuffer());
  pyodide.FS.mkdirTree("/work");
  pyodide.FS.writeFile("/work/input.pdf", bytes);

  const runCode = `import json, wasmenv
result = wasmenv.ocr(
    "/work/input.pdf",
    "/work/output.pdf",
    language=${JSON.stringify(options.language)},
    deskew=${options.deskew ? "True" : "False"},
    rotate_pages=${options.rotatePages ? "True" : "False"},
    output_type=${JSON.stringify(options.outputType)},
    ${options.sidecar ? 'sidecar="/work/sidecar.txt",' : ""}
    mode="default",
)
out = dict(result)
out.pop("events", None)
json.dumps(out)`;
  const resultJson = pyodide.runPython(runCode);
  const result = JSON.parse(resultJson);
  if (!result.ok) {
    throw new Error(result.message || "OCR failed");
  }

  // Extract outputs
  const outBytes = pyodide.FS.readFile("/work/output.pdf");
  const pdfBlob = new Blob([outBytes], { type: "application/pdf" });
  let sidecarBlob = null;
  if (options.sidecar) {
    try {
      const txt = pyodide.FS.readFile("/work/sidecar.txt");
      sidecarBlob = new Blob([txt], { type: "text/plain" });
    } catch {}
  }

  const pages = Number(
    pyodide.runPython(
      `from pypdfium2 import PdfDocument; print(len(PdfDocument("/work/output.pdf")))`
    )
  );

  // Clean workspace for the next job
  for (const f of ["/work/input.pdf", "/work/output.pdf", "/work/sidecar.txt"]) {
    try {
      pyodide.FS.unlink(f);
    } catch {}
  }

  return { pdfBlob, sidecarBlob, pages };
}

/* ------------------------------------------------------------------ dispatch */
self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    if (type === "prewarm") {
      await bootPyodide();
      post({ id, result: { ok: true } });
      return;
    }
    if (type === "ocr") {
      const { file, options } = e.data;
      const result = await runOcr(file, options);
      // No transfer list: Blobs structured-clone fine (bytes are shared, not
      // copied) and are NOT transferable — including one throws DataCloneError.
      post({ id, result });
      return;
    }
    throw new Error(`unknown message: ${type}`);
  } catch (err) {
    post({ id, error: err.message || String(err) });
  }
};
