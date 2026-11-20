// @ts-check
const main = ["scene.js", "html-sources.js", "compositor.js", "call-media.js", "call-main.js"];
const prefix = "lightwell";
import "./scene.js";
const mediaTypes = globalThis.Lightwell.mediaTypes;
const ports = new Map();
let creatingOffscreen;
let queue = Promise.resolve();
const intentKey = "pendingPermission";
const intentTTL = 120_000;

function address(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Choose an HTTP or HTTPS tab.");
  return { origin: url.origin, pattern: url.protocol + "//" + url.hostname + "/*" };
}
async function enabledOrigins() {
  return (await chrome.storage.local.get("origins")).origins || [];
}
async function reconcile(origins) {
  const permitted = [];
  for (const origin of origins) {
    const { pattern } = address(origin);
    if (await chrome.permissions.contains({ origins: [pattern] })) permitted.push(origin);
  }
  const matches = [...new Set(permitted.map(origin => address(origin).pattern))];
  const specs = [
    { id: prefix + "-main", js: main, world: "MAIN", runAt: "document_start", matches },
    { id: prefix + "-isolated", js: ["call-isolated.js"], world: "ISOLATED", runAt: "document_start", matches },
  ];
  const current = new Set((await chrome.scripting.getRegisteredContentScripts()).map(item => item.id));
  if (!matches.length) {
    const ids = specs.map(spec => spec.id).filter(id => current.has(id));
    if (ids.length) await chrome.scripting.unregisterContentScripts({ ids });
  } else {
    const updates = specs.filter(spec => current.has(spec.id));
    const additions = specs.filter(spec => !current.has(spec.id));
    if (updates.length) await chrome.scripting.updateContentScripts(updates);
    if (additions.length) await chrome.scripting.registerContentScripts(additions);
  }
  return permitted;
}

async function pendingPermission() {
  const { [intentKey]: intents = {} } = await chrome.storage.session.get(intentKey);
  return Object.fromEntries(Object.entries(intents).filter(([, intent]) => Date.now() - intent.at < intentTTL));
}
async function clearPermissionIntent(pattern, token) {
  const intents = await pendingPermission();
  if (!intents[pattern] || (token && token !== intents[pattern].token)) return;
  delete intents[pattern];
  await chrome.storage.session.set({ [intentKey]: intents });
}
async function activate(origin) {
  const origins = [...new Set([...await enabledOrigins(), origin])];
  await reconcile(origins);
  await chrome.storage.local.set({ origins });
  return origins;
}

function enqueue(work) {
  const task = queue.then(work);
  queue = task.catch(error => console.warn("Lightwell:", error));
  return task;
}
async function ensureOffscreen() {
  if (!creatingOffscreen) creatingOffscreen = (async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [chrome.runtime.getURL("offscreen.html")] });
    if (!contexts.length) await chrome.offscreen.createDocument({
      url: "offscreen.html", reasons: ["BLOBS", "USER_MEDIA", "DISPLAY_MEDIA"],
      justification: "Decode published local visual sources and compute camera masks inside the browser.",
    });
  })().finally(() => { creatingOffscreen = null; });
  await creatingOffscreen;
}

function releaseMedia(info, id) {
  const session = info.media.get(id);
  if (!session) return;
  info.media.delete(id);
  if (session.offscreen) void chrome.runtime.sendMessage({ target: "lightwell-offscreen", kind: "release", session: session.key }).catch(() => {});
}
function closePort(port, info) {
  ports.delete(port);
  for (const id of info.media.keys()) releaseMedia(info, id);
}
async function notify(port, info) {
  const sequence = info.sequence = (info.sequence || 0) + 1;
  const { origins = [], callScene, callMedia } = await chrome.storage.local.get(["origins", "callScene", "callMedia"]);
  if (ports.get(port) !== info || sequence !== info.sequence) return;
  info.enabled = origins.includes(info.origin);
  if (!info.enabled || info.publication?.id !== callMedia?.id) {
    for (const id of info.media.keys()) releaseMedia(info, id);
  }
  info.scene = info.enabled ? callScene : null;
  info.publication = info.enabled ? callMedia : null;
  const key = "panelPosition:" + info.origin;
  const panelPosition = info.enabled && !info.configured ? (await chrome.storage.session.get(key))[key] : undefined;
  if (ports.get(port) !== info || sequence !== info.sequence) return;
  info.configured = info.enabled;
  try { port.postMessage({ enabled: info.enabled, scene: info.scene, publication: info.publication, panelPosition }); }
  catch { closePort(port, info); }
}

async function mediaRequest(port, info, message) {
  const { session: id, request, kind, layer, publication, frame } = message;
  try {
    if (!/^[0-9a-f-]{36}$/.test(id) || ports.get(port) !== info) return;
    if (kind === "release") { releaseMedia(info, id); return; }
    if (!Number.isSafeInteger(request) || !info.enabled || publication !== (info.publication?.id ?? null)) return;
    const item = kind === "mask" ? null : info.scene?.layers.find(item => item.id === layer && item.visible && item.opacity > 0);
    if (kind === "mask") {
      const maskAllowed = info.scene?.layers.some(item => item.type === "camera" && item.visible && item.opacity > 0 && ["os", "blur", "cutout"].includes(item.source.effect));
      if (!maskAllowed || !(frame instanceof ImageBitmap) || !frame.width || !frame.height || frame.width > 256 || frame.height > 256) return;
    } else if (kind === "asset") {
      if (!item || !mediaTypes.includes(item.type) || !info.publication?.assets?.includes(layer)) return;
    } else if (kind === "display") {
      if (!["display", "camera"].includes(item?.type) || !info.publication?.display?.includes(layer)) return;
    } else return;
    if (!info.media.has(id) && info.media.size < 8) info.media.set(id, { key: crypto.randomUUID(), slots: new Map() });
    const session = info.media.get(id);
    if (!session) return;
    const slotKey = kind === "mask" ? kind : layer;
    const prior = session.slots.get(slotKey);
    if (prior?.busy || performance.now() - (prior?.at ?? -Infinity) < 54) {
      port.postMessage({ media: { session: id, request, skipped: true } });
      return;
    }
    const slot = { busy: true, at: performance.now() };
    session.slots.set(slotKey, slot);
    let result;
    try {
      if (kind === "display") {
        await ensureOffscreen();
        if (info.media.get(id) !== session) return;
        result = await chrome.runtime.sendMessage({ target: "lightwell-offscreen", kind: "capture", layer, effect: item.source.effect });
      } else {
        await ensureOffscreen();
        if (info.media.get(id) !== session) return;
        session.offscreen = true;
        result = await chrome.runtime.sendMessage({ target: "lightwell-offscreen", session: session.key, kind, layer, publication, type: item?.type === "media" ? item.source.kind : item?.type, frame });
      }
      result ??= { error: kind === "display" ? "Open Studio, share a display and publish the scene." : "The local media processor is unavailable." };
    } catch (error) {
      result = { error: kind === "display" ? "Open Studio, share a display and publish the scene." : error.message };
    } finally { slot.busy = false; }
    try {
      if (ports.get(port) === info && info.enabled && info.media.get(id) === session) port.postMessage({ media: { session: id, request, ...result } });
    } finally { result?.frame?.close(); }
  } finally { frame?.close?.(); }
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== prefix || port.sender?.frameId !== 0) return;
  let origin;
  try { ({ origin } = address(port.sender.url)); }
  catch { port.disconnect(); return; }
  const info = { origin, tab: port.sender.tab?.id, status: null, media: new Map() };
  ports.set(port, info);
  port.onDisconnect.addListener(() => closePort(port, info));
  port.onMessage.addListener(message => {
    if (message?.openStudio === true && info.enabled) void chrome.runtime.openOptionsPage();
    const position = message?.panelPosition;
    if (info.enabled && [position?.x, position?.y].every(value => Number.isFinite(value) && value >= 0 && value < 100_000)) {
      void chrome.storage.session.set({ ["panelPosition:" + info.origin]: position }).catch(() => {});
    }
    if (message?.media) void mediaRequest(port, info, message.media).catch(error => console.warn("Lightwell media:", error.message));
    if (message?.status && typeof message.status.label === "string") {
      info.status = { label: message.status.label.slice(0, 250), active: Number(message.status.active) || 0 };
    }
  });
  void notify(port, info).catch(() => port.disconnect());
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.origins || changes.callScene || changes.callMedia)) {
    for (const [port, info] of ports) void notify(port, info).catch(() => port.disconnect());
  }
});
function repairRegistration() {
  void enqueue(async () => {
    const before = await enabledOrigins();
    const origins = await reconcile(before);
    if (origins.length !== before.length) await chrome.storage.local.set({ origins });
  });
}
chrome.runtime.onStartup.addListener(repairRegistration);
chrome.runtime.onInstalled.addListener(repairRegistration);
chrome.permissions.onRemoved.addListener(repairRegistration);
// Chrome can close the toolbar popup while accepting its permission prompt.
chrome.permissions.onAdded.addListener(grant => {
  void enqueue(async () => {
    const intents = await pendingPermission();
    for (const pattern of grant.origins || []) {
      const intent = intents[pattern];
      if (!intent) continue;
      await activate(intent.origin);
      delete intents[pattern];
    }
    await chrome.storage.session.set({ [intentKey]: intents });
  });
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.tab && !sender.url?.startsWith(chrome.runtime.getURL(""))) return;
  if (message?.type === "prepareCapture" && sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL("studio.html")) {
    void ensureOffscreen().then(() => reply({ ready: true }), error => reply({ error: error.message }));
    return true;
  }
  if (!["state", "enable", "disable", "prepare", "cancel"].includes(message?.type)) return;
  void enqueue(async () => {
    const { origin, pattern } = address(message.origin);
    if (message.type === "prepare") {
      const intents = await pendingPermission();
      intents[pattern] = { origin, token: message.token, at: Date.now() };
      await chrome.storage.session.set({ [intentKey]: intents });
      return { enabled: false };
    }
    if (message.type === "cancel") {
      await clearPermissionIntent(pattern, message.token);
      return { enabled: false };
    }
    let origins = await enabledOrigins();
    if (message.type === "enable") {
      if (!await chrome.permissions.contains({ origins: [pattern] })) throw new Error("Site permission was declined.");
      origins = await activate(origin);
      await clearPermissionIntent(pattern);
    } else if (message.type === "disable") {
      origins = origins.filter(item => item !== origin);
      await chrome.storage.local.set({ origins });
      await reconcile(origins);
      if (!origins.some(item => address(item).pattern === pattern)) {
        try { await chrome.permissions.remove({ origins: [pattern] }); }
        catch (error) { console.warn("Lightwell released the call; site permission could not be removed:", error.message); }
      }
    }
    const status = [...ports.values()].find(info => info.origin === origin && info.tab === message.tab)?.status;
    return { enabled: origins.includes(origin), status };
  }).then(reply, error => reply({ error: error.message }));
  return true;
});
