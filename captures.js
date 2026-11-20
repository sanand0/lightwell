// @ts-check
import "./scene.js";
import "./compositor.js";
import { createSegmenter } from "./segmentation.js";
import { frameSampler } from "./publication.js";

const lab = globalThis.Lightwell;
const captures = new Map();
const pending = new Map();
const sample = frameSampler();

const publishStatus = () => void chrome.runtime.sendMessage({ target: "lightwell-capture-status", captures: listCaptures() }).catch(() => {});

function dispose(entry) {
  entry.processor?.destroy();
  entry.video.srcObject = null;
  entry.track.stop();
}

function stop(id) {
  pending.delete(id);
  const entry = captures.get(id);
  if (!entry) return;
  captures.delete(id);
  dispose(entry);
}

function listCaptures() {
  return [...captures].map(([id, entry]) => ({
    id, kind: entry.kind, device: entry.device, label: entry.track.label,
    settings: entry.track.getSettings(), blur: entry.kind === "camera" ? lab.blurSupport(entry.track) : "",
    effect: entry.processor?.stats.osBlur || entry.processor?.stats.segmentation || "",
  }));
}

async function start({ id, kind, device, delegate }) {
  if (pending.has(id)) throw new Error("This capture is already opening.");
  const token = Symbol();
  pending.set(id, token);
  let stream;
  let entry;
  try {
    if (kind === "display") {
      const controller = globalThis.CaptureController?.prototype.setFocusBehavior ? new CaptureController() : null;
      controller?.setFocusBehavior("no-focus-change");
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false, ...(controller && { controller }) });
    } else {
      const exact = device === "default" ? {} : { deviceId: { exact: device } };
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: lab.W }, height: { ideal: lab.H }, ...exact }, audio: false });
    }
    if (pending.get(id) !== token) throw new Error("Capture was canceled.");
    const track = stream.getVideoTracks()[0];
    const video = lab.cameraVideo(track);
    await lab.waitForVideo(video);
    if (pending.get(id) !== token) throw new Error("Capture was canceled.");
    entry = { kind, device, track, video };
    if (kind === "camera") {
      entry.processor = new lab.Compositor(document.createElement("canvas"), { layers: [] }, { fallback: true });
      entry.processor.setCamera(video);
      entry.processor.segmenter = createSegmenter(false, delegate === "GPU" ? "GPU" : "CPU");
    }
    const previous = captures.get(id);
    captures.set(id, entry);
    if (previous) dispose(previous);
    track.addEventListener("ended", () => {
      if (captures.get(id) !== entry) return;
      stop(id);
      publishStatus();
    }, { once: true });
    publishStatus();
    return { captures: listCaptures() };
  } catch (error) {
    if (entry) dispose(entry);
    else stream?.getTracks().forEach(track => track.stop());
    return { error: error.message, code: error.name };
  } finally {
    if (pending.get(id) === token) pending.delete(id);
  }
}

export function captureFrame(id, effect) {
  const entry = captures.get(id);
  if (!entry || entry.track.readyState !== "live") return { error: "Capture stopped. Reconnect it in Studio." };
  const processor = entry.processor;
  let source = entry.video;
  if (processor && lab.effects.includes(effect)) {
    const item = processor.scene.layers[0] || lab.layer("camera");
    item.source.effect = effect;
    if (!processor.scene.layers.length) processor.scene = { layers: [item] };
    processor.prepare(performance.now());
    source = processor.cameraImage(item);
  }
  return {
    frame: source ? sample(source, 1280) : null,
    state: [processor?.stats.osBlur, processor?.stats.segmentation].filter(value => value && value !== "idle").join(" · "),
  };
}

export async function captureCommand(message) {
  if (message.action === "list") return { captures: listCaptures() };
  if (message.action === "stopAll") {
    for (const id of new Set([...captures.keys(), ...pending.keys()])) stop(id);
    publishStatus();
    return { captures: [] };
  }
  const id = message.id;
  if (typeof id !== "string" || !id || id.length > 200) return {};
  if (message.action === "frame") return captureFrame(id, message.effect);
  if (message.action === "stop") {
    stop(id);
    publishStatus();
    return { captures: listCaptures() };
  }
  if (message.action === "start" && ["camera", "display"].includes(message.kind)) return start(message);
  return {};
}
