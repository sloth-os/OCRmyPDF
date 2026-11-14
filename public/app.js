/* OCRmyPDF web app.
 *
 * Architecture:
 *  - Main thread: UI. Registers the service worker, handles file input
 *    (picker, drag&drop, and the File Handling API launchQueue), drives the
 *    job, and offers downloads.
 *  - OCR worker (worker.js): hosts Pyodide (CPython/wasm, OCRmyPDF) and
 *    tesseract-wasm's OCREngine in one worker. The worker posts progress
 *    events back; the app keeps the UI responsive.
 *
 * Everything the worker needs is served same-origin and precached by the
 * service worker, so the app runs fully offline after first load.
 */

const $ = (id) => document.getElementById(id);
const state = {
  file: null,
  resultBlob: null,
  resultSidecar: null,
  worker: null,
  busy: false,
  ocrJob: null,
};

/* ------------------------------------------------------------------ i18n-ish language list
 * Tesseract traineddata (tessdata_fast). Models are fetched from this app's
 * origin (tessdata/<lang>.traineddata) and cached by the service worker.
 * eng ships with the build; others are fetched on first use.
 */
const LANGUAGES = [
  ["eng", "English"],
  ["deu", "German"],
  ["fra", "French"],
  ["spa", "Spanish"],
  ["ita", "Italian"],
  ["por", "Portuguese"],
  ["nld", "Dutch"],
  ["pol", "Polish"],
  ["rus", "Russian"],
  ["ukr", "Ukrainian"],
  ["swe", "Swedish"],
  ["nor", "Norwegian"],
  ["dan", "Danish"],
  ["fin", "Finnish"],
  ["ces", "Czech"],
  ["slk", "Slovak"],
  ["hun", "Hungarian"],
  ["ron", "Romanian"],
  ["ell", "Greek"],
  ["tur", "Turkish"],
  ["heb", "Hebrew"],
  ["ara", "Arabic"],
  ["hin", "Hindi"],
  ["ben", "Bengali"],
  ["tha", "Thai"],
  ["vie", "Vietnamese"],
  ["ind", "Indonesian"],
  ["jpn", "Japanese"],
  ["kor", "Korean"],
  ["chi_sim", "Chinese (Simplified)"],
  ["chi_tra", "Chinese (Traditional)"],
];

/* --------------------------------------------------------------- UI helpers */
function show(sectionId) {
  for (const id of ["drop-section", "settings", "progress-section", "done-section", "error-section"]) {
    $(id).classList.toggle("hidden", id !== sectionId);
  }
}

function showError(message) {
  $("error-detail").textContent = message;
  show("error-section");
}

function setProgress(title, frac, step, pages) {
  $("progress-title").textContent = title;
  $("progress-bar").style.width = `${Math.round(frac * 100)}%`;
  if (step !== undefined) $("progress-step").textContent = step;
  if (pages !== undefined) $("progress-pages").textContent = pages;
}

function logLine(text) {
  const box = $("log-lines");
  const div = document.createElement("div");
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  while (box.childNodes.length > 200) box.removeChild(box.firstChild);
}

/* ---------------------------------------------------------------- file intake */
function acceptFile(file) {
  if (!file) return;
  if (state.busy) return;
  if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
    showError(`${file.name}: only PDF files are supported.`);
    return;
  }
  state.file = file;
  state.resultBlob = null;
  state.resultSidecar = null;
  $("file-name").textContent = file.name;
  $("file-meta").textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB`;
  show("settings");
}

function wireFileIntake() {
  const zone = $("drop-zone");
  const input = $("file-input");

  $("btn-pick").addEventListener("click", (e) => {
    e.stopPropagation();
    input.click();
  });
  zone.addEventListener("click", () => input.click());
  zone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") input.click();
  });
  input.addEventListener("change", () => acceptFile(input.files[0]));

  ["dragenter", "dragover"].forEach((ev) =>
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.add("dragging");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.remove("dragging");
    })
  );
  zone.addEventListener("drop", (e) => {
    const file = e.dataTransfer?.files?.[0];
    acceptFile(file);
  });

  // Global drop (outside the zone) also accepted
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) acceptFile(file);
  });

  $("btn-change-file").addEventListener("click", () => input.click());
}

/* ------------------------------------------------- PWA file handling (launch) */
function wireLaunchHandler() {
  if ("launchQueue" in window) {
    window.launchQueue.setConsumer(async (launchParams) => {
      if (!launchParams.files || launchParams.files.length === 0) return;
      const handle = launchParams.files[0];
      try {
        const file = await handle.getFile();
        acceptFile(file);
        // If the runtime is already warm, kick off OCR immediately.
        if (state.file && !state.busy && $("settings").offsetParent !== null) {
          // user can still adjust settings; just surface the file
        }
      } catch (e) {
        showError(`Could not open file: ${e}`);
      }
    });
  }
}

/* ------------------------------------------------------------ service worker */
async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register("sw.js", { scope: "./" });
    reg.addEventListener("updatefound", () => {
      const nw = reg.installing;
      nw?.addEventListener("statechange", () => {
        if (nw.state === "installed" && navigator.serviceWorker.controller) {
          // New version precached; prompt next reload
          console.info("[app] new version installed — refresh to update");
        }
      });
    });
  } catch (e) {
    console.warn("[app] service worker registration failed:", e);
  }
}

/* --------------------------------------------------------- install prompt UI */
let installEvent = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installEvent = e;
  $("btn-install").classList.remove("hidden");
});
$("btn-install").addEventListener("click", async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  $("btn-install").classList.add("hidden");
});

/* --------------------------------------------------------------- OCR worker */
function getWorker() {
  if (state.worker) return state.worker;
  const worker = new Worker("worker.js", { type: "module", name: "ocrmypdf" });
  worker.onmessage = (e) => onWorkerMessage(e.data);
  worker.onerror = (e) => {
    showError(`Worker error: ${e.message || "unknown"}`);
    state.busy = false;
  };
  state.worker = worker;
  return worker;
}

function workerCall(message, transfer = []) {
  return new Promise((resolve, reject) => {
    const worker = getWorker();
    const id = message.id;
    const onReply = (e) => {
      if (e.data.id !== id) return;
      worker.removeEventListener("message", onReply);
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(e.data.result);
    };
    worker.addEventListener("message", onReply);
    worker.postMessage(message, transfer);
  });
}

async function ensureTessdata(lang) {
  // The worker fetches the model itself (from same origin, cached by SW);
  // this is just a pre-check to give a fast, friendly error.
  const url = `tessdata/${lang}.traineddata`;
  try {
    const head = await fetch(url, { method: "HEAD" });
    if (!head.ok) throw new Error(`HEAD ${url} -> ${head.status}`);
  } catch (e) {
    throw new Error(
      `Language model "${lang}" is not available (${e}). ` +
        (lang !== "eng"
          ? "Only English is bundled with this build; add more tessdata to the runtime to enable other languages."
          : "The English model should have been precached — try reloading the page.")
    );
  }
}

/* ------------------------------------------------------------- run pipeline */
async function runOcr() {
  if (state.busy || !state.file) return;
  state.busy = true;
  $("log-lines").textContent = "";
  show("progress-section");
  setProgress("Preparing…", 0.02, "Starting worker");

  const opts = {
    language: $("opt-language").value,
    outputType: $("opt-output").value,
    deskew: $("opt-deskew").checked,
    rotatePages: $("opt-rotate").checked,
    sidecar: $("opt-sidecar").checked,
    fileName: state.file.name,
  };

  try {
    await ensureTessdata(opts.language);
    const result = await workerCall(
      {
        id: "ocr",
        file: state.file,
        options: opts,
      },
      [state.file]
    );
    state.resultBlob = result.pdfBlob;
    state.resultSidecar = result.sidecarBlob || null;

    const sizeText =
      state.resultBlob.size > state.file.size
        ? `${(state.file.size / 1024 / 1024).toFixed(2)} MB → ${(state.resultBlob.size / 1024 / 1024).toFixed(2)} MB`
        : `${(state.resultBlob.size / 1024 / 1024).toFixed(2)} MB`;
    $("done-info").textContent =
      `${state.file.name} OCR'd (${sizeText}, ${result.pages} page${result.pages === 1 ? "" : "s"}, ` +
      `${opts.outputType === "pdfa" ? "PDF/A-2b" : "PDF"}).`;

    $("btn-download-sidecar").classList.toggle("hidden", !state.resultSidecar);
    show("done-section");
  } catch (e) {
    showError(e.message || String(e));
  } finally {
    state.busy = false;
  }
}

/* ----------------------------------------------------------- worker progress */
function onWorkerMessage(data) {
  if (data.id !== "progress") return;
  const ev = data.event;
  switch (ev.type) {
    case "boot":
      setProgress("Loading engine…", 0.08, ev.detail || "booting Pyodide");
      break;
    case "install":
      setProgress("Installing OCRmyPDF…", 0.18, ev.detail);
      break;
    case "model":
      setProgress("Loading language model…", 0.3, ev.detail);
      break;
    case "page-start":
      setProgress("OCR in progress", 0.35 + 0.6 * (ev.page / ev.total), `Page ${ev.page + 1} of ${ev.total}`);
      logLine(`— page ${ev.page + 1}/${ev.total} —`);
      break;
    case "log":
      logLine(ev.message);
      break;
    case "page-done":
      setProgress("OCR in progress", 0.35 + 0.6 * ((ev.page + 1) / ev.total), undefined, `${ev.page + 1}/${ev.total}`);
      break;
    case "finalize":
      setProgress("Finalizing PDF…", 0.96, ev.detail || "writing output");
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------------ downloads */
function wireDownloads() {
  $("btn-download").addEventListener("click", () => {
    if (!state.resultBlob) return;
    const name = state.file.name.replace(/\.pdf$/i, "") + ".ocr.pdf";
    const url = URL.createObjectURL(state.resultBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  });
  $("btn-download-sidecar").addEventListener("click", () => {
    if (!state.resultSidecar) return;
    const name = state.file.name.replace(/\.pdf$/i, "") + ".txt";
    const url = URL.createObjectURL(state.resultSidecar);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  });
  $("btn-again").addEventListener("click", () => {
    state.file = null;
    state.resultBlob = null;
    state.resultSidecar = null;
    show("drop-section");
  });
}

/* --------------------------------------------------------------------- boot */
async function boot() {
  // language select
  const sel = $("opt-language");
  for (const [code, label] of LANGUAGES) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = `${label} (${code})`;
    sel.appendChild(opt);
  }

  wireFileIntake();
  wireLaunchHandler();
  wireDownloads();
  $("btn-ocr").addEventListener("click", runOcr);
  $("btn-retry").addEventListener("click", () => show("settings"));
  $("btn-cancel").addEventListener("click", () => {
    if (state.worker) {
      state.worker.terminate();
      state.worker = null;
    }
    state.busy = false;
    show("settings");
  });

  await registerServiceWorker();

  // Build info line
  try {
    const meta = await (await fetch("runtime-meta.json", { cache: "no-store" })).json();
    $("build-info").textContent =
      `ocrmypdf ${meta.ocrmypdf || ""} · pyodide ${meta.pyodide} · tesseract-wasm ${meta.tesseract_wasm} · built ${meta.built || ""}`;
  } catch {
    $("build-info").textContent = "";
  }

  // Prewarm the worker in the background after idle so the first OCR is fast
  const prewarm = () => {
    getWorker().postMessage({ id: "prewarm" });
  };
  if ("requestIdleCallback" in window) requestIdleCallback(prewarm, { timeout: 8000 });
  else setTimeout(prewarm, 4000);
}

boot();
