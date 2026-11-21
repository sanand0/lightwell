// @ts-check
import { createSegmenter } from "./segmentation.js";
import { createHands, fakeHands, loadModel, modelCached } from "./hands.js";
import { CaptureClient } from "./capture-client.js";
import { readAssets, writeAssets, removeOldAssets, savedScenes, saveSceneRecord } from "./publication.js";

const lab = globalThis.Lightwell;
const { W, H, types, mediaTypes, fonts, clips, blends, fits, effects, cameraFrames, transform, Compositor } = lab;
const $ = selector => document.querySelector(selector);
const extension = globalThis.chrome?.runtime?.id && chrome.storage?.local;
const demo = new URLSearchParams(location.search);
const names = ["Talking Head", "Presenter", "Glass Dashboard", "Portal", "Data Magic"];
const labelFor = {
  solid: "Solid", gradient: "Gradient", generated: "Generated Canvas", camera: "Camera", html: "Live HTML / SVG",
  text: "Text", markdown: "Markdown", media: "Media", image: "Image", video: "Local video", display: "Display capture", ink: "Drawing",
};
const stage = $("#stage");
const director = $("#director");
const layerList = $("#layers");
const selectionBox = $("#selection");
const presetSelect = $("#preset");
const notice = $("#notice");
const loadStudio = () => extension ? extension.get("studio").then(items => items.studio) : Promise.resolve(JSON.parse(localStorage.getItem("studio") || "null"));
const requestedPreset = names.find(name => location.hash.slice(1) === encodeURIComponent(name));
let scene = requestedPreset ? lab.preset(requestedPreset) : lab.defaultScene();
let library = [];
let libraryId = "";
let live = false;
let liveTimer;
let liveBusy = false;
let liveDirty = false;
let liveSources = false;
let selectedId = null;
let tool = "select";
let gesture = null;
const cameras = new Map();
let devices = [];
const inkHistory = new Map();
const htmlLoads = new Map();
let renameItem;
let dragged;
let permission = "unknown";
let saveTimer;
let recording;
let recordingTimer;
let reference;
let capture;
let lastReportedError = "";
const displayRequests = new Map();
const sessionFiles = new Map();

function tell(message, error = false) {
  notice.textContent = message;
  notice.dataset.error = String(error);
}

// A camera that starts clears its own earlier error, not unrelated notices.
function clearError() { if (notice.dataset.error === "true") tell(""); }
function option(value, label = value) {
  return new Option(label, value);
}
function button(id, click) { $(id).addEventListener("click", click); }
function make(tag, text = "", className = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
function editHTML(id, key) {
  const item = scene.layers.find(item => item.id === id);
  if (!item) return;
  item.source[key] = !item.source[key];
  if (selectedId === id) syncSourceFields(item);
  changed();
}

const renderer = new Compositor(stage, scene, { action: editHTML, fallback: demo.has("no-html") });
const segmenterForCamera = () => createSegmenter(demo.has("seg-fail"), demo.get("delegate") === "gpu" ? "GPU" : "CPU");
const diagnostics = new Map();
for (const key of ["Browser", "HTML-in-Canvas", "Camera permission", "Camera source", "OS background blur", "Segmentation", "Output", "Capture", "Display sources", "Hands", "Last error"]) {
  const value = make("dd");
  diagnostics.set(key, value);
  $("#diagnostic-values").append(make("dt", key), value);
}
function status() {
  const { stats } = renderer;
  if (stats.error && stats.error !== lastReportedError) {
    lastReportedError = stats.error;
    tell(stats.error, true);
  }
  const input = currentCamera();
  const camera = input?.track;
  const remote = input?.remote;
  const selectedId = currentCameraId();
  const frameState = capture?.frames.get(selectedId)?.state;
  const label = input?.state === "synthetic" ? "Synthetic camera" : remote?.label || camera?.label || input?.state || "Stage preview";
  $("#live-indicator").dataset.off = String(!live && !input);
  $("#stage-state").textContent = recording ? "Recording video" : label;
  $("#frame-info").textContent = W + " × " + H + " · " + Math.round(stats.fps) + " fps";
  const track = remote?.settings || camera?.getSettings();
  const os = remote?.blur || lab.blurSupport(camera);
  const values = [
    navigator.userAgent.match(/(?:Edg|Chrome)\/[\d.]+/g)?.join(" · ") || "Chromium API detection",
    renderer.mode + " · " + stats.native + " native layers · requestPaint " + (stage.requestPaint ? "available" : "unavailable"),
    permission, label + (track?.width ? " · " + track.width + " × " + track.height : ""),
    frameState?.includes("OS blur") ? frameState.split(" · MediaPipe")[0] + " · " + os : stats.osBlur || os,
    frameState || stats.segmentation,
    stage.width + " × " + stage.height + " · " + stats.fps.toFixed(1) + " fps · " + stats.ms.toFixed(1) + " ms render",
    (stage.captureStream ? "captureStream available" : "captureStream unavailable") + (recording ? " · recording" : ""),
    navigator.mediaDevices?.getDisplayMedia ? (capture ? [...capture.entries.values()].filter(entry => entry.kind === "display").length : [...renderer.cache.values()].filter(resource => resource.stream?.active).length) + " live · tab/window/screen picker available" : "unavailable",
    scene.hands ? renderer.hands?.status || "starting" : "off",
    stats.error || "—",
  ];
  const blurInfo = $("#camera-blur-info");
  if (blurInfo) blurInfo.textContent = os + (frameState ? " · " + frameState : "");
  $("#stop-captures").hidden = !capture?.entries.size;
  [...diagnostics.values()].forEach((node, index) => { if (node.textContent !== values[index]) node.textContent = values[index]; });
}

function persist() {
  const value = lab.normalize(scene);
  return extension ? extension.set({ studio: value, studioSceneId: libraryId }) : Promise.resolve().then(() => localStorage.setItem("studio", JSON.stringify(value)));
}
function changed(sources = false) {
  renderer.setScene(scene);
  queueLive(sources);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => persist().catch(error => tell("Autosave failed. " + error.message, true)), 280);
}
function selected() { return scene.layers.find(item => item.id === selectedId); }
function outline() {
  const item = selected();
  selectionBox.hidden = !item?.visible;
  if (!item?.visible) return;
  Object.assign(selectionBox.style, {
    left: item.x / W * 100 + "%", top: item.y / H * 100 + "%",
    width: item.w / W * 100 + "%", height: item.h / H * 100 + "%",
    transform: "rotate(" + item.rotation + "deg)",
  });
  selectionBox.classList.toggle("name-inside", item.y < 28);
  $("#selection-name").textContent = item.name;
}

function updateLayerList() {
  const active = document.activeElement?.dataset;
  layerList.replaceChildren();
  for (const item of [...scene.layers].reverse()) {
    const row = make("li", "", "layer-row" + (item.id === selectedId ? " active" : ""));
    const control = (label, icon, role, action) => {
      const element = make("button", icon, role === "select" ? "" : "layer-icon");
      element.type = "button";
      element.setAttribute("aria-label", label);
      element.title = label;
      element.dataset.layerId = item.id;
      element.dataset.layerRole = role;
      if (action) element.addEventListener("click", action);
      return element;
    };
    const handle = control("Reorder " + item.name + " (Alt+Up or Alt+Down)", "⠿", "reorder");
    handle.classList.add("drag-handle");
    handle.draggable = true;
    handle.addEventListener("dragstart", event => {
      dragged = item;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", item.id);
      row.classList.add("dragging");
    });
    handle.addEventListener("dragend", () => {
      dragged = null;
      for (const entry of layerList.children) entry.classList.remove("dragging", "drop-before", "drop-after");
    });
    const before = event => event.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2;
    row.addEventListener("dragover", event => {
      if (!dragged || dragged === item) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      row.classList.toggle("drop-before", before(event));
      row.classList.toggle("drop-after", !before(event));
    });
    row.addEventListener("dragleave", event => {
      if (!row.contains(event.relatedTarget)) row.classList.remove("drop-before", "drop-after");
    });
    row.addEventListener("drop", event => {
      if (!dragged || dragged === item) return;
      event.preventDefault();
      const moving = dragged;
      dragged = null;
      scene.layers.splice(scene.layers.indexOf(moving), 1);
      scene.layers.splice(scene.layers.indexOf(item) + Number(before(event)), 0, moving);
      changed();
      select(moving);
      layerList.querySelector('[data-layer-role="reorder"][data-layer-id="' + CSS.escape(moving.id) + '"]')?.focus();
    });
    row.addEventListener("keydown", event => {
      if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      const from = scene.layers.indexOf(item);
      const to = from + (event.key === "ArrowUp" ? 1 : -1);
      if (to < 0 || to >= scene.layers.length) return;
      [scene.layers[from], scene.layers[to]] = [scene.layers[to], scene.layers[from]];
      changed(); select(item);
    });
    const choose = control("Select " + item.name, "", "select", () => select(item));
    choose.setAttribute("aria-pressed", String(item.id === selectedId));
    const cell = make("div", "", "layer-select");
    cell.append(make("span", labelFor[item.type], "layer-type"), choose);
    choose.append(make("span", item.name, "layer-name"));
    const visible = control((item.visible ? "Hide " : "Show ") + item.name, item.visible ? "◉" : "○", "visibility", () => {
      item.visible = !item.visible;
      changed(); updateLayerList(); outline();
    });
    const remove = control("Delete " + item.name, "×", "delete", () => removeLayer(item));
    const more = control("Options for " + item.name, "⋯", "more");
    const menu = make("div", "", "layer-menu");
    menu.id = "layer-options-" + crypto.randomUUID();
    menu.setAttribute("popover", "");
    more.setAttribute("popovertarget", menu.id);
    for (const [text, action] of [
      ["Rename", () => {
        renameItem = item;
        $("#layer-rename").value = item.name;
        $("#rename-dialog").showModal();
        $("#layer-rename").select();
      }],
      ["Duplicate", () => duplicateLayer(item)],
      ["Edit source", () => { select(item); sourceFields.querySelector("input, select, textarea, button")?.focus(); }],
    ]) {
      const entry = make("button", text);
      entry.type = "button";
      entry.addEventListener("click", () => { menu.hidePopover(); action(); });
      menu.append(entry);
    }
    row.append(handle, cell, visible, more, remove, menu);
    layerList.append(row);
    if (active?.layerId === item.id) [handle, choose, visible, more, remove].find(node => node.dataset.layerRole === active.layerRole)?.focus({ preventScroll: true });
  }
  $("#reset").disabled = !selected();
}

const transformInputs = [...$("#transform-controls").querySelectorAll("[data-property], [data-crop]")];
for (const [key, options] of Object.entries({ fit: fits, clip: clips, blend: blends })) {
  $("[data-property=" + key + "]").append(...options.map(value => option(value)));
}
function syncTransforms(item) {
  $("#transform-controls").disabled = !item;
  for (const field of transformInputs) {
    const key = field.dataset.property || field.dataset.crop;
    const value = field.dataset.crop ? item?.crop?.[key] ?? 0 : item?.[key];
    if (field.type === "checkbox") field.checked = value !== false;
    else if (document.activeElement !== field) field.value = typeof value === "number" ? String(Math.round(value * 100) / 100) : value ?? "";
    const output = $("[data-value=" + key + "]");
    if (output) output.value = item ? key === "rotation" ? Math.round(value) + "°" : Math.round(value * (key === "opacity" ? 100 : 1)) + "%" : "";
  }
  syncFx(item);
}

// Experiments: optional per-layer effects. The panel stays collapsed so the main controls stay primary.
const fxInputs = [...$("#fx-panel").querySelectorAll("[data-fx]")];
const fxDefault = { fill: "own", look: "none", move: "none", exit: "none", amount: .5, gone: false, at: 0, ix: .5, iy: .45 };
const fxNames = {
  own: "Own", camera: "Camera", glass: "Frosted glass", echo: "Echo", prism: "Prism",
  none: "None", knit: "Knit", halftone: "Halftone", tube: "CRT", neon: "Neon", rain: "Rain ✦", pool: "Pool ✦",
  silk: "Silk", jelly: "Jelly", melt: "Melt", rays: "Lamp rays", water: "Water ✦", lens: "Lens ✦", smudge: "Smudge ✦",
  shatter: "Shatter", swarm: "Swarm", burn: "Burn", vortex: "Black hole",
};
for (const [key, kinds] of Object.entries(lab.fxKinds)) $("[data-fx=" + key + "]").append(...kinds.map(kind => option(kind, fxNames[kind])));
function syncFx(item) {
  const fx = item?.fx || fxDefault;
  for (const input of fxInputs) if (document.activeElement !== input) input.value = String(fx[input.dataset.fx]);
  $("[data-value=amount]").value = Math.round(fx.amount * 100) + "%";
  const labels = lab.fx.exitLabels[fx.exit];
  $("#fx-play").hidden = !labels;
  if (labels) $("#fx-play").textContent = labels[Number(fx.gone)] + " · X";
  $("#fx-panel summary").textContent = lab.fx.active({ fx }) || scene.hands ? "Experiments ✦" : "Experiments";
  $("#fx-hands").checked = !!scene.hands;
}
for (const input of fxInputs) input.addEventListener("input", () => {
  const item = selected();
  if (!item) return;
  const key = input.dataset.fx;
  const value = input.type === "range" ? input.valueAsNumber : input.value;
  // A new exit starts with the layer present, so switching never leaves it invisible.
  updateItem(item, { fx: { ...fxDefault, ...item.fx, [key]: value, ...(key === "exit" && { gone: false, at: 0 }) } });
  syncFx(item);
});
// impact: where the exit starts, as fractions of the layer box (a double-tap point).
function playExit(item = selected(), impact = {}) {
  if (!item?.fx || item.fx.exit === "none") return;
  // smooth() is symmetric, so reversing mid-flight from the mirrored elapsed time continues without a jump.
  const ms = lab.fx.exitMs[item.fx.exit];
  const elapsed = item.fx.at ? Math.min(ms, Date.now() - item.fx.at) : ms;
  updateItem(item, { fx: { ...item.fx, ...impact, gone: !item.fx.gone, at: Date.now() - (ms - elapsed) } });
  if (item === selected()) syncFx(item);
  if (!live) tell("Played in Studio. Turn on Live to play exits in calls as they happen.");
}
button("#fx-play", () => playExit());

// Touch tool: taps and drags become scene pokes, which effects react to here and in calls.
let lastPoke = { at: 0, x: 0, y: 0 };
function poke(point, kind) {
  const at = Date.now();
  if (kind === "drag" && at - lastPoke.at < 30) return;
  const dt = Math.max(16, at - lastPoke.at) / 1000;
  const motion = kind === "drag" ? { vx: (point.x - lastPoke.x) / dt, vy: (point.y - lastPoke.y) / dt } : {};
  lastPoke = { at, ...point };
  scene.pokes = [...(scene.pokes || []).filter(old => at - old.at < 3000), { ...point, at, kind, ...motion }].slice(-16);
  changed();
}
director.addEventListener("dblclick", event => {
  if (tool !== "touch") return;
  const point = pointer(event);
  const target = lab.ordered(scene.layers).toReversed().find(item => {
    if (item.fx?.exit === undefined || item.fx.exit === "none") return false;
    const local = lab.toLocal(item, point);
    return local.x >= 0 && local.y >= 0 && local.x <= item.w && local.y <= item.h;
  }) || scene.layers.toReversed().find(item => item.fx?.gone && item.fx.exit !== "none");
  if (!target) return;
  const local = lab.toLocal(target, point);
  playExit(target, { ix: Math.min(1, Math.max(0, local.x / target.w)), iy: Math.min(1, Math.max(0, local.y / target.h)) });
});

// Hand gestures are opt-in: turning them on downloads the model once (about 8 MB), with progress.
function handTracker() {
  if (!scene.hands) { renderer.hands?.close(); renderer.hands = null; return; }
  renderer.hands ??= demo.has("fake-hands") ? fakeHands() : createHands();
}
$("#fx-hands").addEventListener("change", async event => {
  const input = event.target;
  if (input.checked && !demo.has("fake-hands") && !await modelCached()) {
    input.disabled = true;
    try {
      await loadModel(fraction => tell("Downloading the hand gesture model (8 MB) · " + Math.round(fraction * 100) + "%"));
      tell("Hand gestures on. Show a hand to the camera.");
    } catch (error) {
      input.checked = false;
      tell("Could not download the hand model. " + error.message, true);
      return;
    } finally { input.disabled = false; }
  }
  scene.hands = input.checked;
  handTracker();
  changed();
});
function nativeRatio(item) {
  if (!item.lockAspect) return undefined;
  const [w, h] = renderer.sourceSize(item) || [item.w, item.h];
  return w / h;
}
function updateItem(item, properties, sources = false) {
  Object.assign(item, lab.normalize({ version: 1, layers: [{ ...item, ...properties }] }).layers[0]);
  changed(sources);
  outline();
}
for (const field of transformInputs) field.addEventListener("input", () => {
  const item = selected();
  if (!item) return;
  const key = field.dataset.property;
  const value = field.type === "checkbox" ? field.checked : ["number", "range"].includes(field.type) ? field.valueAsNumber : field.value;
  if (typeof value === "number" && !Number.isFinite(value)) return;
  const props = field.dataset.crop ? { crop: { ...item.crop, [field.dataset.crop]: value } } : { [key]: value };
  const ratio = ["w", "h"].includes(key) ? nativeRatio(item) : null;
  if (ratio) props[key === "w" ? "h" : "w"] = key === "w" ? value / ratio : value * ratio;
  updateItem(item, props);
  syncTransforms(item);
});
button("#reset-crop", () => { const item = selected(); if (item) { updateItem(item, { crop: {} }); syncTransforms(item); } });
$("#layer-rename").addEventListener("input", event => {
  if (!renameItem || !scene.layers.includes(renameItem)) return;
  updateItem(renameItem, { name: event.target.value });
  updateLayerList();
});

const sourceFields = $("#source-fields");
function sourceField(item, key, label, kind, choices = [], action) {
  const wrapper = make("label", label, kind === "checkbox" ? "checkbox" : "");
  const input = make(kind === "select" ? "select" : kind === "textarea" ? "textarea" : "input");
  input.dataset.sourceProperty = key;
  if (kind === "select") input.append(...choices.map(choice => Array.isArray(choice) ? option(...choice) : option(choice)));
  if (input instanceof HTMLInputElement) input.type = kind;
  if (kind === "range" || kind === "number") {
    input.min = key === "size" ? "8" : "0";
    input.max = String({ crop: 25, grayscale: 100, size: 240 }[key] || 200);
  }
  input.addEventListener("input", () => {
    const value = kind === "checkbox" ? input.checked : ["range", "number"].includes(kind) ? input.valueAsNumber : input.value;
    if (typeof value === "number" && !Number.isFinite(value)) return;
    if (action) action(value);
    else updateItem(item, { source: { ...item.source, [key]: value } }, key === "kind");
  });
  wrapper.append(input);
  sourceFields.append(wrapper);
  return input;
}
function syncSourceFields(item) {
  for (const input of sourceFields.querySelectorAll("[data-source-property]")) {
    const value = item.source[input.dataset.sourceProperty];
    if (input.type === "checkbox") input.checked = value;
    else if (document.activeElement !== input) input.value = value ?? "";
  }
}
function buildSourceFields(item) {
  sourceFields.replaceChildren();
  $("#source-controls").hidden = !item || item.type === "ink";
  if (!item) return;
  const field = (...args) => sourceField(item, ...args);
  if (["solid", "gradient"].includes(item.type)) field("color", "Color", "color");
  if (item.type === "gradient") field("color2", "End color", "color");
  if (item.type === "generated") field("style", "Generator", "select", [["orbit", "Orbital field"], ["chart", "Animated spectrum"]]);
  if (item.type === "camera") {
    addCameraControls(item);
    const frames = make("div", "", "inline");
    for (const [name, frame] of Object.entries(cameraFrames)) {
      const control = make("button", name);
      control.type = "button";
      control.addEventListener("click", () => { Object.assign(item, frame); changed(); outline(); syncTransforms(item); });
      frames.append(control);
    }
    sourceFields.append(frames);
    field("effect", "Camera background", "select", effects.map((value, index) => [value, ["Original", "OS blur", "Segmented blur", "Person cutout"][index]]));
    const switches = make("div", "", "inline");
    for (const [key, label] of [["mirror", "Mirror"], ["flip", "Flip vertical"]]) switches.append(field(key, label, "checkbox").parentElement);
    sourceFields.append(switches);
    const tune = make("div", "", "grid");
    for (const label of ["Brightness", "Contrast", "Saturation", "Grayscale"]) tune.append(field(label.toLowerCase(), label, "range").parentElement);
    sourceFields.append(tune);
    const reset = make("button", "Reset camera");
    reset.type = "button";
    reset.addEventListener("click", () => {
      updateItem(item, { ...transform, source: { ...lab.layer("camera").source, device: item.source.device, cameraOff: item.source.cameraOff } });
      syncTransforms(item); syncSourceFields(item);
    });
    sourceFields.append(reset);
  }
  if (item.type === "html") {
    field("url", "HTML / SVG URL", "url", [], value => loadHTML(item, value));
    addFileInput(item, "text/html,image/svg+xml,.html,.htm,.svg", async file => {
      if (file.size > 120000) throw new Error("Choose an HTML or SVG file under 120 KB.");
      const markup = await file.text();
      if (!scene.layers.includes(item)) return;
      cancelHTML(item);
      updateItem(item, { source: { template: "custom", markup, title: file.name, filename: file.name, url: "" } });
    });
    if (item.source.template !== "custom") sourceFields.append(make("p", "Choose a file or URL to replace this saved HTML source."));
  }
  if (item.type === "markdown" || item.type === "text") {
    if (item.type === "markdown") {
      field("text", "Markdown", "textarea").spellcheck = false;
      field("font", "Font family", "select", [["serif", "Georgia"], ["sans", "System sans"], ["mono", "Monospace"], ["rounded", "Trebuchet"]]);
    } else field("text", "Text", "textarea");
    field("color", "Text color", "color");
    field("size", "Font size", "number");
  }
  if (mediaTypes.includes(item.type)) {
    field("url", "Media URL (CORS-enabled)", "url", [], value => {
      sessionFiles.delete(item.id);
      renderer.setFile(item, null);
      updateItem(item, { source: { ...item.source, url: value, filename: "" } }, true);
    });
    addFileInput(item, item.type === "image" ? "image/*,.svg" : item.type === "video" ? "video/*" : "image/*,video/*,.svg", async file => {
      const portable = file.size <= 2_000_000 && /^(?:image\/(?:png|jpeg|webp|gif|avif|svg\+xml)|video\/(?:webm|mp4|ogg))$/.test(file.type);
      const url = portable ? await fileDataURL(file) : "";
      if (!scene.layers.includes(item)) return;
      if (portable) sessionFiles.delete(item.id);
      else sessionFiles.set(item.id, file);
      renderer.setFile(item, portable ? null : file);
      const kind = file.type.startsWith("video/") || lab.videoURL(file.name) ? "video" : "image";
      updateItem(item, { source: { ...item.source, url, filename: file.name, kind } }, true);
    });
    if (item.type === "media") field("kind", "Media type", "select", [["auto", "Detect automatically"], ["image", "Image"], ["video", "Video"]]);
    field("background", "Letterbox color", "color");
  }
  if (item.type === "display") {
    const controls = make("div", "", "inline");
    for (const [label, action] of [["Choose display", () => shareDisplay(item)], ["Stop display", () => { displayRequests.delete(item); void stopCapture(item).then(() => changed(true)); }]]) {
      const control = make("button", label);
      control.type = "button";
      control.addEventListener("click", action);
      controls.append(control);
    }
    sourceFields.append(controls);
    sourceFields.append(make("p", "Choose a tab, window or screen. Audio stays off.", "display-status"));
    updateDisplayStatus(item);
  }
  syncSourceFields(item);
}

function addFileInput(item, accept, load) {
  const wrapper = make("label", item.source.filename || "Choose a local file");
  const input = make("input");
  input.type = "file";
  input.accept = accept;
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    try { await load(file); if (selectedId === item.id) buildSourceFields(item); }
    catch (error) { tell(error.message, true); }
  });
  wrapper.append(input);
  sourceFields.append(wrapper);
}
function cancelHTML(item) {
  const request = htmlLoads.get(item.id);
  clearTimeout(request?.timer);
  request?.abort.abort();
  htmlLoads.delete(item.id);
}
function loadHTML(item, url) {
  cancelHTML(item);
  updateItem(item, { source: { ...item.source, template: "custom", url, filename: "", markup: "" } });
  if (!item.source.url) return;
  const abort = new AbortController();
  const timer = setTimeout(async () => {
    try {
      const response = await fetch(item.source.url, { signal: abort.signal, credentials: "omit" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const markup = await response.text();
      if (markup.length > 120000) throw new Error("HTML exceeds 120 KB");
      if (!scene.layers.includes(item) || abort.signal.aborted) return;
      updateItem(item, { source: { ...item.source, markup, title: new URL(item.source.url).hostname } });
    } catch (error) {
      if (!abort.signal.aborted) tell("HTML source: " + error.message + ". Use a CORS-enabled URL or share a browser tab.", true);
    } finally { if (htmlLoads.get(item.id)?.abort === abort) htmlLoads.delete(item.id); }
  }, 270);
  htmlLoads.set(item.id, { abort, timer });
}

function fileDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
async function shareDisplay(item) {
  if (displayRequests.has(item)) return;
  const token = Symbol();
  displayRequests.set(item, token);
  try {
    if (capture) {
      await capture.command("start", { id: item.id, kind: "display" });
      if (!scene.layers.includes(item) || displayRequests.get(item) !== token) await capture.command("stop", { id: item.id });
      else changed(true);
      return;
    }
    if (extension) throw new Error("Background capture is unavailable. Reopen Studio and try again.");
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("Display capture is unavailable.");
    const controller = globalThis.CaptureController?.prototype.setFocusBehavior ? new CaptureController() : null;
    controller?.setFocusBehavior("no-focus-change");
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false, ...(controller && { controller }) });
    if (!scene.layers.includes(item) || displayRequests.get(item) !== token) stream.getTracks().forEach(track => track.stop());
    else { renderer.setDisplay(item, stream); changed(true); }
  } catch (error) { if (displayRequests.get(item) === token) tell("Display capture: " + error.message, true); }
  finally { if (displayRequests.get(item) === token) displayRequests.delete(item); }
}

function select(item) {
  selectedId = item?.id ?? null;
  updateLayerList();
  syncTransforms(item);
  buildSourceFields(item);
  outline();
  if (reference) syncReference();
}
function replaceScene(value, id = "", files = null) {
  const next = lab.normalize(value);
  for (const item of scene.layers) {
    if (sessionFiles.has(item.id)) renderer.setFile(item, null);
    if (item.type === "display") renderer.setDisplay(item, null);
    cancelHTML(item);
  }
  for (const id of cameras.keys()) closeCamera(id);
  scene = next;
  libraryId = id;
  handTracker();
  sessionFiles.clear();
  displayRequests.clear();
  inkHistory.clear();
  for (const item of scene.layers) {
    if (files?.has(item.id)) {
      sessionFiles.set(item.id, files.get(item.id));
      renderer.setFile(item, files.get(item.id));
    }
    if (item.type === "camera") initCamera(item);
  }
  if (id) history.replaceState(null, "", "#scene-" + id);
  else if (names.includes(scene.name)) history.replaceState(null, "", "#" + encodeURIComponent(scene.name));
  else history.replaceState(null, "", location.pathname + location.search);
  changed(true);
  select(scene.layers.find(item => item.type === "camera") || scene.layers.at(-1));
  refreshLibrary();
}
function refreshLibrary() {
  presetSelect.replaceChildren(option("", libraryId ? "Choose a saved scene" : scene.name), ...library.map(entry => option(entry.id, entry.scene.name)));
  presetSelect.value = libraryId;
}
presetSelect.addEventListener("change", () => {
  const entry = library.find(entry => entry.id === presetSelect.value);
  if (entry) replaceScene(entry.scene, entry.id, entry.files);
});
button("#new-scene", () => replaceScene({ version: 1, name: "Untitled scene", layers: [] }));
button("#save-scene", () => {
  $("#scene-name").value = scene.name;
  $("#scene-dialog").showModal();
  $("#scene-name").select();
});
button("#cancel-save", () => $("#scene-dialog").close());
$("#scene-form").addEventListener("submit", async event => {
  event.preventDefault();
  const name = $("#scene-name").value.trim();
  if (!name) return;
  const id = libraryId || crypto.randomUUID();
  const entry = { id, scene: lab.normalize({ ...scene, name }), files: new Map(sessionFiles) };
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  try {
    await saveSceneRecord(entry);
    const index = library.findIndex(existing => existing.id === id);
    if (index < 0) library.push(entry);
    else library[index] = entry;
    library.sort((a, b) => a.scene.name.localeCompare(b.scene.name));
    libraryId = id;
    scene.name = name;
    history.replaceState(null, "", "#scene-" + id);
    refreshLibrary();
    changed();
    $("#scene-dialog").close();
    tell("Saved " + name);
  } catch (error) { $("#scene-dialog").close(); tell("Could not save scene. " + error.message, true); }
  finally { if (submit) submit.disabled = false; }
});

function add(type) {
  if (scene.layers.length >= 40) {
    tell("Scene is full. Remove a layer to add another.", true);
    return;
  }
  const framing = { camera: cameraFrames.Corner, html: { x: 760, y: 110, w: 430, h: 310 }, markdown: { x: 90, y: 90, w: 680, h: 240 }, media: { x: 48, y: 48, w: 760, h: 428, fit: "contain" } };
  const label = labelFor[type];
  let name = label;
  for (let index = 2; scene.layers.some(item => item.name === name); index++) name = label + " " + index;
  const item = lab.layer(type, { name, ...framing[type], ...(type === "html" && { source: { template: "custom", title: "HTML / SVG" } }) });
  scene.layers.push(item);
  if (item.type === "camera") initCamera(item);
  changed();
  select(item);
  return item;
}
for (const type of types) {
  const control = make("button", labelFor[type]);
  control.type = "button";
  control.addEventListener("click", () => { $("#layer-menu").hidePopover(); add(type); });
  $("#layer-types").append(control);
}
button("#reset", () => {
  const item = selected();
  if (!item) return;
  updateItem(item, { ...transform, crop: {} });
  outline(); syncTransforms(item);
});
function duplicateLayer(item) {
  if (scene.layers.length >= 40) return;
  const copy = lab.layer(item.type, { ...structuredClone(item), id: crypto.randomUUID(), name: item.name + " copy", x: item.x + 20, y: item.y + 20 });
  scene.layers.splice(scene.layers.indexOf(item) + 1, 0, copy);
  const file = sessionFiles.get(item.id);
  if (file) { sessionFiles.set(copy.id, file); renderer.setFile(copy, file); }
  if (copy.type === "camera") initCamera(copy);
  changed(mediaTypes.includes(copy.type)); select(copy);
}
function removeLayer(item) {
  const index = scene.layers.indexOf(item);
  if (index < 0) return;
  scene.layers.splice(index, 1);
  sessionFiles.delete(item.id);
  displayRequests.delete(item);
  cancelHTML(item);
  if (item.type === "display" || item.type === "camera") void stopCapture(item);
  inkHistory.delete(item.id);
  closeCamera(item.id);
  changed();
  select(selected() || scene.layers[Math.min(index, scene.layers.length - 1)]);
}

function setTool(next) {
  tool = next;
  director.classList.toggle("interact", next === "interact");
  director.classList.toggle("draw", !["interact", "select"].includes(next));
  for (const button of document.querySelectorAll("[data-tool]")) button.setAttribute("aria-pressed", String(button.dataset.tool === next));
}
for (const button of document.querySelectorAll("[data-tool]")) button.addEventListener("click", () => setTool(button.dataset.tool));
function inkLayer(create = false) {
  const item = selected();
  if (item?.type === "ink" && (item.visible || !create)) return item;
  return scene.layers.findLast(item => item.type === "ink" && item.visible) || (create ? add("ink") : null);
}
function inkPoint(item, point) {
  const local = lab.toLocal(item, point);
  return [Math.round(local.x * W / item.w), Math.round(local.y * H / item.h)];
}
function showSnap(guides = {}) {
  for (const axis of ["x", "y"]) {
    const node = $(".snap-" + axis);
    const size = axis === "x" ? W : H;
    const position = guides[axis];
    node.hidden = position === undefined || position < 0 || position > size;
    if (!node.hidden) node.style[axis === "x" ? "left" : "top"] = "clamp(0px, " + 100 * position / size + "%, calc(100% - 1px))";
  }
}
const pointer = event => lab.stagePoint(stage.getBoundingClientRect(), event.clientX, event.clientY);
director.addEventListener("pointerdown", event => {
  if (!event.isPrimary || event.button !== 0 || tool === "interact" || gesture) return;
  const start = pointer(event);
  if (tool === "touch") {
    poke(start, "tap");
    gesture = { touch: true };
    director.setPointerCapture(event.pointerId);
    return;
  }
  if (tool === "select") {
    const corner = event.target.dataset.corner;
    const hits = lab.ordered(scene.layers).filter(item => {
      if (item.type === "ink") return false;
      const p = lab.toLocal(item, start);
      if (p.x < 0 || p.y < 0 || p.x > item.w || p.y > item.h) return false;
      if (item.clip === "ellipse") return ((2 * p.x / item.w - 1) ** 2 + (2 * p.y / item.h - 1) ** 2) <= 1;
      return true;
    });
    const current = selected();
    const item = corner ? current : hits.at(-1);
    if (!item) return;
    if (current !== item) select(item);
    gesture = { item, start, base: { ...item }, corner, ratio: nativeRatio(item), targets: lab.snapTargets(scene.layers, item.id) };
  } else {
    const item = inkLayer(true);
    if (!item) return;
    const stroke = { tool, color: $("#ink-color").value, width: Number($("#ink-width").value), points: [inkPoint(item, start)] };
    rememberInk(item);
    item.source.strokes.push(stroke);
    if (item.source.strokes.length > 250) item.source.strokes.shift();
    gesture = { item, stroke };
    changed();
  }
  director.focus({ preventScroll: true });
  director.setPointerCapture(event.pointerId);
});
director.addEventListener("pointermove", event => {
  if (!gesture || !director.hasPointerCapture(event.pointerId)) return;
  const { item, stroke, start, base, corner, ratio, targets } = gesture;
  const point = pointer(event);
  if (gesture.touch) { poke(point, "drag"); return; }
  if (stroke) {
    const next = inkPoint(item, point);
    const last = stroke.points.at(-1);
    if (stroke.points.length < 1800 && Math.hypot(last[0] - next[0], last[1] - next[1]) >= 1) { stroke.points.push(next); changed(); }
    return;
  }
  const delta = { x: point.x - start.x, y: point.y - start.y };
  const bounds = stage.getBoundingClientRect();
  const tolerance = { x: 7 * W / bounds.width, y: 7 * H / bounds.height };
  const moved = { ...base, x: base.x + delta.x, y: base.y + delta.y };
  const frame = event.shiftKey ? corner ? lab.resize(base, corner, delta, ratio) : moved
    : corner ? lab.snapResize(base, corner, delta, ratio, targets, tolerance) : lab.snapMove(moved, targets, tolerance);
  const { guides, ...geometry } = frame;
  Object.assign(item, geometry);
  showSnap(guides);
  outline(); syncTransforms(item); changed();
});
for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) director.addEventListener(event, () => {
  if (!gesture) return;
  const { item, stroke, touch } = gesture;
  gesture = null;
  if (touch) return;
  showSnap();
  if (!stroke) updateItem(item, {});
  else changed();
});
function rememberInk(item) {
  if (!inkHistory.has(item.id)) inkHistory.set(item.id, []);
  const history = inkHistory.get(item.id);
  history.push(item.source.strokes.slice());
  if (history.length > 100) history.shift();
}
function undo() {
  const item = inkLayer();
  if (!item) return;
  const previous = inkHistory.get(item.id)?.pop();
  if (previous) item.source.strokes = previous;
  else item.source.strokes.pop();
  changed();
}
button("#undo", undo);
button("#clear", () => {
  const item = inkLayer();
  if (item?.source.strokes.length) { rememberInk(item); item.source.strokes = []; changed(); }
});
window.addEventListener("keydown", event => {
  const origin = event.composedPath()[0];
  if (event.defaultPrevented || origin.closest?.("input, select, textarea, [contenteditable], dialog[open]")) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); undo(); return; }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const next = { v: "select", p: "pen", h: "highlighter", e: "eraser", i: "interact", t: "touch" }[event.key.toLowerCase()];
  if (next) setTool(next);
  if (event.key.toLowerCase() === "x") playExit();
  if (event.key === "Escape") setTool("select");
  const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
  const item = selected();
  if (!delta || !item) return;
  event.preventDefault();
  const step = event.shiftKey ? 12 : 2;
  updateItem(item, { x: item.x + step * delta[0], y: item.y + step * delta[1] });
  syncTransforms(item);
});

function currentCameraId() {
  return cameras.has(selectedId) ? selectedId
    : [...cameras].find(([, entry]) => entry.track || entry.remote || entry.state === "synthetic")?.[0] ?? cameras.keys().next().value;
}
function currentCamera() { return cameras.get(currentCameraId()); }
function syncReference() {
  if (!reference) return;
  const active = currentCamera();
  const item = scene.layers.find(item => item.id === currentCameraId());
  reference.remoteMedia = active?.remote && item ? () => capture.sample(item, true) : null;
  if (active?.state === "synthetic") reference.setSynthetic();
  else reference.setCamera(active?.track ? lab.cameraVideo(active.track) : null);
}
async function stopCapture(item) {
  try {
    if (capture) await capture.command("stop", { id: item.id });
    if (item.type === "display") renderer.setDisplay(item, null);
  } catch (error) { tell("Could not stop the capture. " + error.message, true); }
}
function updateDisplayStatus(item) {
  const label = $(".display-status");
  if (!label || selectedId !== item.id) return;
  const active = capture?.entries.get(item.id) || renderer.cache.get(item.id)?.stream?.active;
  label.textContent = active ? "Sharing " + (active.label || "a display") : "Choose a tab, window or screen. Audio stays off.";
}
function syncRemoteCaptures() {
  for (const item of scene.layers.filter(item => item.type === "camera")) {
    const input = cameras.get(item.id);
    if (!input) continue;
    const remote = capture.entries.get(item.id);
    if (remote?.device === item.source.device) {
      input.remote = remote;
      input.state = "live";
    } else if (input.remote) {
      input.remote = null;
      input.state = "off";
    }
    syncCameraButton(item);
  }
  const item = selected();
  if (item?.type === "display") updateDisplayStatus(item);
  status();
}

function closeCamera(id) {
  const entry = cameras.get(id);
  cameras.delete(id);
  entry?.track?.stop();
  renderer.removeLayerCamera(id);
}
function initCamera(item) {
  closeCamera(item.id);
  const synthetic = !item.source.cameraOff && item.source.device === "synthetic";
  const remote = capture?.entries.get(item.id);
  const active = remote?.device === item.source.device ? remote : null;
  cameras.set(item.id, { state: synthetic ? "synthetic" : active ? "live" : "off", remote: active });
  renderer.setLayerCamera(item.id, synthetic ? "synthetic" : null, synthetic ? segmenterForCamera() : null);
}
function addCameraControls(item) {
  const row = make("div", "", "camera-controls");
  const wrap = make("label", "Camera source");
  const picker = make("select");
  picker.id = "camera-device";
  const list = [["synthetic", "Synthetic camera"], ["default", "Default webcam"], ...devices];
  if (!list.some(([id]) => id === item.source.device)) list.push([item.source.device, "Previously selected webcam"]);
  picker.append(...list.map(([id, name]) => option(id, name)));
  picker.value = item.source.device;
  picker.addEventListener("input", () => {
    if (capture?.entries.has(item.id) || cameras.get(item.id)?.state === "requesting") void stopCapture(item);
    item.source.device = picker.value;
    item.source.cameraOff = false;
    initCamera(item);
    changed(true); syncReference(); syncCameraButton(item); status();
  });
  const toggle = make("button");
  toggle.type = "button";
  toggle.id = "camera-toggle";
  toggle.addEventListener("click", async () => {
    if (cameras.get(item.id)?.state === "off") { void startCamera(item); return; }
    item.source.cameraOff = true;
    await stopCapture(item);
    if (!scene.layers.includes(item)) return;
    initCamera(item);
    changed(true); syncReference(); syncCameraButton(item); status();
  });
  wrap.append(picker);
  row.append(wrap, toggle);
  const details = make("p");
  details.id = "camera-blur-info";
  sourceFields.append(row, details);
  syncCameraButton(item);
  status();
}
function syncCameraButton(item) {
  const control = $("#camera-toggle");
  if (!control || selectedId !== item.id) return;
  const state = cameras.get(item.id)?.state || "off";
  control.textContent = state === "off" ? "Start camera" : state === "requesting" ? "Cancel camera" : "Stop camera";
}
async function updateDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const found = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === "videoinput" && device.deviceId && device.deviceId !== "default");
    devices = found.map((device, i) => [device.deviceId, device.label || "Webcam " + (i + 1)]);
    if (selected()?.type === "camera" && document.activeElement?.id !== "camera-device") {
      const picker = $("#camera-device");
      const value = selected().source.device;
      if (picker) {
        while (picker.options.length > 2) picker.remove(2);
        picker.append(...devices.map(([id, label]) => option(id, label)));
        if (![...picker.options].some(entry => entry.value === value)) picker.append(option(value, "Previously selected webcam"));
        picker.value = value;
      }
    }
  } catch (error) { renderer.report(error.message); }
}
async function startCamera(item) {
  item.source.cameraOff = false;
  initCamera(item);
  const attempt = cameras.get(item.id);
  const device = item.source.device;
  if (device === "synthetic") {
    changed(true); syncCameraButton(item); syncReference(); status();
    return;
  }
  attempt.state = "requesting";
  syncCameraButton(item);
  tell("Waiting for permission…");
  let track;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera capture requires a secure browser context.");
    const constraints = { video: { width: { ideal: W }, height: { ideal: H }, ...(device !== "default" && { deviceId: { exact: device } }) }, audio: false };
    if (capture) {
      const options = { id: item.id, kind: "camera", device, delegate: demo.get("delegate") === "gpu" ? "GPU" : "CPU" };
      try { await capture.command("start", options); }
      catch (error) {
        const consent = await navigator.permissions?.query({ name: "camera" }).catch(() => null);
        if (error.name !== "NotAllowedError" || consent?.state === "denied") throw error;
        // The visible editor can request permission when the background context cannot show it.
        const permissionStream = await navigator.mediaDevices.getUserMedia(constraints);
        permissionStream.getTracks().forEach(track => track.stop());
        if (cameras.get(item.id) !== attempt) return;
        await capture.command("start", options);
      }
      if (cameras.get(item.id) !== attempt) return;
      permission = "granted";
      clearError();
      void updateDevices();
      changed(true); syncCameraButton(item); syncReference(); status();
      return;
    }
    if (extension) throw new Error("Background capture is unavailable. Reopen Studio and try again.");
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    track = stream.getVideoTracks()[0];
    if (cameras.get(item.id) !== attempt) { track.stop(); return; }
    attempt.track = track;
    const video = lab.cameraVideo(track);
    await lab.waitForVideo(video);
    if (cameras.get(item.id) !== attempt) { video.srcObject = null; return; }
    attempt.state = "live";
    renderer.setLayerCamera(item.id, video, segmenterForCamera());
    permission = "granted";
    track.addEventListener("ended", () => {
      if (cameras.get(item.id) !== attempt) return;
      item.source.cameraOff = true;
      initCamera(item);
      changed(true); syncCameraButton(item); syncReference();
      tell("Camera disconnected.", true);
    }, { once: true });
    void updateDevices();
    clearError();
  } catch (error) {
    track?.stop();
    if (cameras.get(item.id) !== attempt) return;
    if (error.name === "NotAllowedError") permission = "denied or dismissed";
    initCamera(item);
    renderer.report(error.name + ": " + error.message);
    lastReportedError = renderer.stats.error;
    tell("Camera unavailable. " + error.message + " You can switch to Synthetic camera.", true);
  }
  changed(true); syncCameraButton(item); syncReference(); status();
}
navigator.mediaDevices?.addEventListener("devicechange", () => void updateDevices());
navigator.permissions?.query({ name: "camera" }).then(state => {
  permission = state.state;
  state.addEventListener("change", () => { permission = state.state; status(); });
}).catch(() => {});

button("#compare", () => {
  const control = $("#compare");
  const comparison = $("#comparison");
  comparison.hidden = !comparison.hidden;
  control.setAttribute("aria-pressed", String(!comparison.hidden));
  if (!comparison.hidden) {
    reference = new Compositor($("#reference"), lab.preset("Talking Head"), { fps: 20 });
    syncReference();
    reference.start();
  } else {
    reference.destroy();
    reference = null;
  }
});

function download(blob, filename) {
  const a = make("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}
const slug = () => scene.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "lightwell";
button("#export-png", () => {
  try { stage.toBlob(blob => blob ? download(blob, slug() + ".png") : tell("The PNG encoder returned no image.", true), "image/png"); }
  catch (error) { tell("PNG export: " + error.message, true); }
});
button("#record", () => {
  if (recording) {
    if (recording.state === "recording") recording.stop();
    return;
  }
  let stream;
  try {
    stream = stage.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
    const chunks = [];
    const filename = slug() + ".webm";
    recorder.addEventListener("dataavailable", event => { if (event.data.size) chunks.push(event.data); });
    const finish = error => {
      clearTimeout(recordingTimer);
      stream.getTracks().forEach(track => track.stop());
      recording = null;
      $("#record").textContent = "Record";
      $("#record").dataset.recording = "false";
      if (error) tell("Recording: " + error.message, true);
      else if (chunks.length) download(new Blob(chunks, { type: recorder.mimeType }), filename);
      status();
    };
    recorder.addEventListener("stop", () => { if (recording === recorder) finish(); }, { once: true });
    recorder.addEventListener("error", event => finish(event.error), { once: true });
    recorder.start();
    recording = recorder;
    recordingTimer = setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, 8000);
    $("#record").textContent = "Stop recording";
    $("#record").dataset.recording = "true";
    status();
  } catch (error) {
    stream?.getTracks().forEach(track => track.stop());
    tell("Recording: " + error.message, true);
  }
});
button("#save-json", () => download(new Blob([JSON.stringify(lab.normalize(scene), null, 2) + "\n"], { type: "application/json" }), slug() + ".json"));
button("#open-json", () => $("#json-file").click());
$("#json-file").addEventListener("change", async event => {
  const input = event.target;
  const file = input.files[0];
  if (!file) return;
  try {
    if (file.size > 9_000_000) throw new Error("Scene JSON exceeds 9 MB.");
    replaceScene(JSON.parse(await file.text()));
    tell("Loaded " + file.name);
  } catch (error) { tell("Scene import: " + error.message, true); }
  input.value = "";
});
async function publishScene(quiet = false) {
  const value = lab.normalize(scene);
  const files = new Map();
  const displays = [];
  const missing = [];
  await Promise.all(value.layers.map(async item => {
    if (item.type === "camera") {
      const entry = cameras.get(item.id);
      if (!item.source.cameraOff && entry?.remote) displays.push(item.id);
      return;
    }
    if (item.type === "display") {
      if (capture?.entries.has(item.id)) displays.push(item.id);
      else if (item.visible) missing.push(item.name);
      return;
    }
    if (!mediaTypes.includes(item.type)) return;
    let file = sessionFiles.get(item.id);
    if (!file && item.source.url.startsWith("data:")) {
      const response = await fetch(item.source.url);
      if (!response.ok) throw new Error("Could not read " + item.name + " for publishing.");
      file = await response.blob();
    }
    if (file || item.source.url) files.set(item.id, file || item.source.url);
    else if (item.visible && !item.source.url && item.source.filename) missing.push(item.name);
  }));
  const id = crypto.randomUUID();
  await writeAssets(id, files);
  if (quiet && !live) return;
  await extension.set({
    studio: lab.normalize(scene), studioSceneId: libraryId, callScene: lab.callScene(value),
    callMedia: { id, assets: [...files.keys()], display: displays },
  });
  await removeOldAssets(id).catch(error => console.warn("Lightwell asset cleanup:", error));
  if (!quiet || missing.length) tell(missing.length ? "Scene published. Reconnect: " + missing.join(", ") : displays.length ? "Scene published. Captures continue in the background." : "Scene published to enabled origins.");
}

function queueLive(sources = false) {
  if (!live) return;
  liveDirty = true;
  liveSources ||= sources;
  if (!liveTimer && !liveBusy) liveTimer = setTimeout(flushLive, 24);
}
async function flushLive() {
  liveTimer = null;
  if (!live || !liveDirty) return;
  const sources = liveSources;
  liveDirty = liveSources = false;
  liveBusy = true;
  try {
    await navigator.locks.request("lightwell-publish", async () => {
      if (!live) return;
      if (sources) await publishScene(true);
      else await extension.set({ callScene: lab.callScene(lab.normalize(scene)) });
    });
  } catch (error) { tell("Live update failed. " + error.message, true); }
  finally {
    liveBusy = false;
    if (liveDirty) queueLive();
  }
}
button("#live-mode", () => {
  live = !live;
  void chrome.storage.session.set({ studioLive: live }).catch(error => tell(error.message, true));
  $("#live-mode").setAttribute("aria-pressed", String(live));
  if (live) {
    tell("Live · Studio edits are sent to enabled calls.");
    queueLive(true);
  } else {
    clearTimeout(liveTimer);
    liveTimer = null;
    liveDirty = liveSources = false;
    tell("Live paused.");
  }
  status();
});
button("#publish", async () => {
  if (!extension) { tell("Open the unpacked extension’s Studio to use the call bridge.", true); return; }
  const control = $("#publish");
  control.disabled = true;
  try {
    await navigator.locks.request("lightwell-publish", () => publishScene());
  } catch (error) { tell("Unable to publish. " + error.message, true); }
  finally { control.disabled = false; }
});
button("#open-bridge", () => $("#bridge-dialog").showModal());
function theme(value) {
  document.documentElement.dataset.theme = value;
  localStorage.setItem("theme", value);
}
button("#theme", () => theme(document.documentElement.dataset.theme === "light" ? "dark" : "light"));
theme(localStorage.getItem("theme") || "dark");

if (extension) {
  try {
    const reply = await chrome.runtime.sendMessage({ type: "prepareCapture" });
    if (!reply?.ready) throw new Error(reply?.error || "Background capture unavailable");
    capture = new CaptureClient(syncRemoteCaptures);
    await capture.command("list");
    renderer.remoteMedia = item => item.type === "camera" && capture.entries.get(item.id)?.device !== item.source.device
      ? undefined : capture.sample(item);
  } catch (error) { tell("Could not start background capture. " + error.message, true); }
}
button("#stop-captures", async () => {
  if (!capture) return;
  try {
    const ids = new Set(capture.entries.keys());
    await capture.command("stopAll");
    for (const item of scene.layers) if (item.type === "camera" && ids.has(item.id)) item.source.cameraOff = true;
    changed(true);
    tell("Background captures stopped.");
  } catch (error) { tell(error.message, true); }
});

try {
  library = (await savedScenes()).sort((a, b) => a.scene.name.localeCompare(b.scene.name));
  const previous = await loadStudio();
  const savedId = extension ? (await extension.get("studioSceneId")).studioSceneId : "";
  const linkedId = location.hash.startsWith("#scene-") ? location.hash.slice(7) : "";
  const link = library.find(entry => entry.id === linkedId);
  const restore = !demo.has("fresh") && (!requestedPreset || previous?.name === requestedPreset) && (!link || link.id === savedId);
  const draft = restore && previous;
  const current = draft ? library.find(entry => entry.id === savedId) : link;
  replaceScene(draft || current?.scene || scene, current?.id, current?.files);
  if (restore && previous && extension) {
    const { callScene, callMedia } = await extension.get(["callScene", "callMedia"]);
    const files = callMedia?.assets?.length ? await readAssets(callMedia.id) : null;
    const priorLayers = files && callScene ? lab.normalize(callScene).layers : [];
    for (const item of scene.layers) {
      const file = files?.get(item.id);
      const prior = priorLayers.find(layer => layer.id === item.id && layer.type === item.type);
      if (!(file instanceof Blob) || item.source.url || sessionFiles.has(item.id) || prior?.source.filename !== item.source.filename) continue;
      sessionFiles.set(item.id, file);
      renderer.setFile(item, file);
    }
  }
} catch (error) { replaceScene(scene); tell("Saved scene could not be loaded. " + error.message, true); }
if (extension && !demo.has("fresh")) {
  live = (await chrome.storage.session.get("studioLive")).studioLive === true;
  $("#live-mode").setAttribute("aria-pressed", String(live));
}
// Chrome keeps registered call scripts in memory until they are registered again. Without this,
// edited or added files reach Studio (read from disk) but not call tabs, which keep the old code.
async function refreshCallScripts() {
  const [main] = await chrome.scripting.getRegisteredContentScripts({ ids: ["lightwell-main"] });
  if (!main) return;
  const text = (await Promise.all(lab.callScripts.map(async file => {
    const response = await fetch(file);
    if (!response.ok) throw new Error(file + " " + response.status);
    return response.text();
  }))).join("\0");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const digest = btoa(String.fromCharCode(...new Uint8Array(hash)));
  const { callScriptsDigest } = await extension.get("callScriptsDigest");
  const listChanged = main.js.join() !== lab.callScripts.join();
  if (!listChanged && digest === callScriptsDigest) return;
  await chrome.scripting.updateContentScripts([{ id: main.id, js: lab.callScripts }]);
  await extension.set({ callScriptsDigest: digest });
  if (listChanged || callScriptsDigest) tell("Updated Lightwell for call tabs. Reload open call tabs to use it.");
}
if (extension) refreshCallScripts().catch(error => tell("Could not update call tabs. Reload Lightwell on the extensions page. " + error.message, true));
handTracker();
void updateDevices();
renderer.start();
$("#live-mode").disabled = !extension;
$("#publish").disabled = false;
const statusTimer = setInterval(status, 700);
window.addEventListener("pagehide", () => {
  clearInterval(statusTimer);
  if (recording?.state === "recording") recording.stop();
  clearTimeout(liveTimer);
  capture?.close();
  for (const id of cameras.keys()) closeCamera(id);
  reference?.destroy();
  renderer.destroy();
});

if (!extension && demo.has("dev")) {
  const watch = new EventSource("/watch");
  watch.onmessage = () => location.reload();
}
