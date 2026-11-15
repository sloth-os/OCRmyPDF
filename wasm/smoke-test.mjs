// Smoke test: run the full OCRmyPDF wasm pipeline in Node against a generated
// test PDF, with no browser.
//
// Both Pyodide and tesseract-wasm run in this thread. The bridge object
// (engine + model) is the same shape as the browser app's js.tesseractWasm,
// so the Python plugins are exercised exactly as in production. Images are
// decoded on the Python side (Pillow) because the engine needs ImageData.
//
// Exit0 iff the OCR'd output PDF contains the expected text.
//
// Env/args: SITE_DIR or --site <dir> (default build/site under this file).

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const ai = argv.indexOf("--site");
// Resolve to an absolute path: ESM import() treats a relative specifier
// ("wasm/build/site/...") as a bare package name → ERR_MODULE_NOT_FOUND.
// CI invokes this as `node wasm/smoke-test.mjs --site wasm/build/site`.
const siteDir = resolve(
  (ai !== -1 ? argv[ai + 1] : process.env.SITE_DIR) || join(here, "build", "site")
);
console.log(`[smoke] site: ${siteDir}`);

function fail(msg) {
  console.error(`[smoke] FAIL: ${msg}`);
  process.exit(1);
}

// ------------------------------------------------------------------ engine
const { createOCREngine, supportsFastBuild } = await import(
  pathToFileURL(join(siteDir, "tesseract", "lib.js")).href
);
const wasmPath = join(
  siteDir,
  "tesseract",
  supportsFastBuild() ? "tesseract-core.wasm" : "tesseract-core-fallback.wasm"
);
console.log(`[smoke] tesseract wasm: ${wasmPath} (${supportsFastBuild() ? "fast" : "fallback"})`);
const engine = await createOCREngine({
  wasmBinary: readFileSync(wasmPath).buffer.slice(0),
});
engine.loadModel(new Uint8Array(readFileSync(join(siteDir, "tessdata", "eng.traineddata"))));
console.log("[smoke] tesseract engine + eng model loaded");

// ------------------------------------------------------------------ pyodide
const { loadPyodide } = await import(pathToFileURL(join(siteDir, "pyodide", "pyodide.mjs")).href);
const pyodide = await loadPyodide({
  indexURL: join(siteDir, "pyodide") + "/",
});
console.log("[smoke] pyodide booted");

// The Python image decoder: called from the JS bridge below. Runs
// synchronously inside runPython.
pyodide.globals.set("tw_decode_image_json", (path) => {
  const code = `
import json as _json
from PIL import Image as _Image
im = _Image.open(${JSON.stringify(path)}).convert("RGBA")
print("[smoke] decode", ${JSON.stringify(path)}, im.size)
_json.dumps([im.width, im.height, list(im.tobytes())])
`;
  return pyodide.runPython(code);
});

function imageDataFor(path) {
  const [w, h, bytes] = JSON.parse(pyodide.globals.get("tw_decode_image_json")(path));
  return { width: w, height: h, data: Uint8Array.from(bytes) };
}

let lastText = "";
const bridge = {
  version: () => "5.5-wasm",
  languages: () => ["eng"],
  orientation: (path) => {
    engine.loadImage(imageDataFor(path));
    const o = engine.getOrientation();
    return JSON.stringify({ angle: o.rotation, confidence: o.confidence });
  },
  recognize_to_hocr: (path, lang) => {
    engine.loadImage(imageDataFor(path));
    const hocr = engine.getHOCR();
    lastText = engine.getText();
    return hocr;
  },
  recognized_text: () => lastText,
  word_boxes: (path) => {
    engine.loadImage(imageDataFor(path));
    return JSON.stringify(engine.getTextBoxes("word"));
  },
};

// Register as js.tesseractWasm (what ocr_engine_tesseract_wasm.py expects).
// The glue reads it through "import js", i.e. the JS globalThis — NOT the
// pyodide.globals namespace — so it must be a real JS global.
globalThis.tesseractWasm = bridge;

// ----------------------------------------------------------------- install
await pyodide.loadPackage("micropip");
await pyodide.loadPackage("pillow"); // from pyodide dist, used for decoding
const wheels = readdirSync(join(siteDir, "wheels")).map((f) => "file://" + join(siteDir, "wheels", f));
console.log(`[smoke] installing ${wheels.length} wheels via micropip`);
await pyodide.runPythonAsync(`
import micropip
await micropip.install(${JSON.stringify(wheels)})
`);

// glue on the path: pyodide's MEMFS cannot see host files, so materialize
// the .py files into the FS first (the browser worker does the same via
// fetch; here we read from the site dir on disk).
const glueDir = join(siteDir, "pyodide-glue");
pyodide.FS.mkdirTree("pyodide-glue");
for (const f of readdirSync(glueDir).filter((f) => f.endsWith(".py"))) {
  pyodide.FS.writeFile(`pyodide-glue/${f}`, readFileSync(join(glueDir, f)));
}
pyodide.runPython(`import sys; sys.path.insert(0, "pyodide-glue")`);

// ----------------------------------------------------------------- test run
pyodide.runPython(`
from fpdf import FPDF
pdf = FPDF()
pdf.set_font("Helvetica", size=24)
pdf.add_page()
pdf.text(20, 40, "The quick brown fox jumps over the lazy dog")
pdf.text(20, 60, "Pack my box with five dozen liquor jugs")
pdf.output("/input.pdf")
print("[smoke] input.pdf created (2 lines of text)")
`);

console.log("[smoke] running ocrmypdf (mode=force, pdf)...");
const resultJson = pyodide.runPython(`
import json, wasmenv
result = wasmenv.ocr("/input.pdf", "/output.pdf", language="eng", mode="force", output_type="pdf")
for ev in result["events"]:
    if ev["type"] == "log":
        print(" [ocr]", ev["message"][:160])
print("[smoke] ok:", result["ok"], "events:", len(result["events"]))
if result["message"]:
    print("[smoke] message:", result["message"][:1000])
json.dumps({"ok": result["ok"], "message": result["message"]})
`);
const result = JSON.parse(resultJson);
if (!result.ok) fail(result.message || "ocr() returned failure");

// -------------------------------------------------------------- validation
const extracted = pyodide.runPython(`
from pypdfium2 import PdfDocument
doc = PdfDocument("/output.pdf")
print("[smoke] output pages:", len(doc))
tp = doc[0].get_textpage()
tp.get_text_bounded()
`);
console.log("[smoke] extracted:", JSON.stringify(extracted.slice(0, 120)));
if (!/quick brown fox/i.test(extracted)) {
  fail("output PDF does not contain the expected OCR text");
}

// ---------------------------------------------------------------- artifact
mkdirSync(join(here, "build", "smoke-out"), { recursive: true });
const outBytes = pyodide.FS.readFile("/output.pdf");
writeFileSync(join(here, "build", "smoke-out", "output.pdf"), Buffer.from(outBytes));
console.log(`[smoke] artifact: build/smoke-out/output.pdf (${outBytes.length} bytes)`);

engine.destroy();
console.log("[smoke] PASS");
process.exit(0);
