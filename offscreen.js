// @ts-check
import "./scene.js";
import { readAssets, frameSampler, replyWithMedia } from "./publication.js";
import { createSegmenter } from "./segmentation.js";
import { captureCommand, captureFrame } from "./captures.js";

const sessions = new Map();

function releaseAsset(asset) {
  if (asset.element instanceof HTMLVideoElement) {
    asset.element.pause();
    asset.element.removeAttribute("src");
    asset.element.load();
    asset.element.remove();
  }
  if (asset.url.startsWith("blob:")) URL.revokeObjectURL(asset.url);
}

function release(key) {
  const session = sessions.get(key);
  if (!session) return;
  sessions.delete(key);
  session.segmenter?.close();
  for (const asset of session.assets.values()) releaseAsset(asset);
}

function sessionFor(key) {
  if (!sessions.has(key)) sessions.set(key, { assets: new Map(), sample: frameSampler() });
  const session = sessions.get(key);
  session.usedAt = performance.now();
  return session;
}

async function openAsset(session, publication, layer, kind) {
  const files = await (session.files ??= readAssets(publication));
  const file = files?.get(layer);
  const remoteURL = typeof file === "string" && /^https?:\/\//i.test(file);
  if (!(file instanceof Blob) && !remoteURL) throw new Error("This published file needs to be selected again in Studio.");
  let asset = session.assets.get(layer);
  if (asset) return asset;
  const url = remoteURL ? file : URL.createObjectURL(file);
  asset = { url };
  session.assets.set(layer, asset);
  const load = video => {
    const element = document.createElement(video ? "video" : "img");
    if (remoteURL) element.crossOrigin = "anonymous";
    asset.element = element;
    if (video) {
      element.muted = true;
      element.playsInline = true;
      element.loop = true;
      document.body.append(element);
    } else if (kind === "auto") element.addEventListener("error", () => {
      if (session.assets.get(layer) === asset) load(true);
    }, { once: true });
    element.src = url;
    if (video) element.play().catch(error => { asset.error = error.message; });
  };
  load(kind === "video" || (kind === "auto" && (file.type?.startsWith("video/") || Lightwell.videoURL(file.name || url))));
  return asset;
}

async function media(message) {
  const { session: key, kind, publication, layer, type, frame } = message;
  if (kind === "release") { release(key); return {}; }
  if (kind === "capture") return captureFrame(layer, message.effect);
  const owner = sessionFor(key);
  if (kind === "mask") {
    const segmenter = owner.segmenter ??= createSegmenter();
    segmenter.step(frame, performance.now(), false);
    return { state: segmenter.status, frame: segmenter.mask ? await createImageBitmap(segmenter.mask) : null };
  }
  const asset = await openAsset(owner, publication, layer, type);
  if (sessions.get(key) !== owner) {
    if (owner.assets.delete(layer)) releaseAsset(asset);
    return {};
  }
  if (asset.error || asset.element.error || (type !== "auto" && asset.element instanceof HTMLImageElement && asset.element.complete && !asset.element.naturalWidth)) {
    return { error: asset.error || "The browser could not decode the published file." };
  }
  const still = asset.element instanceof HTMLImageElement;
  return { frame: owner.sample(asset.element, still ? 1600 : 960), still };
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.target === "lightwell-capture" && sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL("studio.html")) {
    void captureCommand(message).then(result => replyWithMedia(reply, result), error => reply({ error: error.message }));
    return true;
  }
  if (message?.target !== "lightwell-offscreen") return;
  if (message.kind === "mask" && !(message.frame instanceof ImageBitmap)) return;
  void media(message).then(result => replyWithMedia(reply, result), error => reply({ error: error.message })).finally(() => message.frame?.close());
  return true;
});

setInterval(() => {
  for (const [key, session] of sessions) if (performance.now() - session.usedAt > 30_000) release(key);
}, 10_000);
