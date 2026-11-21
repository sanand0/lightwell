// @ts-check
(() => {
  const lab = globalThis.Lightwell;
  const prototype = globalThis.MediaDevices?.prototype;
  const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, "getUserMedia");
  if (!descriptor?.value || globalThis.top !== globalThis) return;
  const nativeGet = descriptor.value;
  const competing = !Function.prototype.toString.call(nativeGet).includes("[native code]");

  let active = false;
  let configured = false;
  let generation = 0;
  let scene = lab.defaultScene();
  let publication = null;
  let panel;
  let panelObserver;
  let panelPosition;
  let line;
  const alive = new Set();
  const pending = new Set();
  let everEnabled = false;
  let message = competing ? "Another camera wrapper was present." : "Reloaded · waiting for camera";
  let ready;
  const configuredOnce = new Promise(resolve => { ready = resolve; });

  function status(label = message) {
    message = label;
    if (line) line.textContent = label;
    window.postMessage({ from: "lightwell-page", status: { label, active: alive.size } }, location.origin);
  }
  function dispose(event = true) {
    for (const pipe of [...alive]) pipe.close(event);
    for (const source of pending) source.stop();
    pending.clear();
    panelObserver?.disconnect();
    panel?.remove();
    panel = line = null;
  }
  function updateScene(value, media) {
    publication = media;
    try { scene = value ? lab.normalize(value) : lab.defaultScene(); }
    catch { scene = lab.defaultScene(); }
    for (const pipe of alive) {
      pipe.media.configure(publication);
      pipe.compositor.setScene(scene);
      if (document.hidden) {
        // A meeting tab may be backgrounded while its director is editing in Studio.
        pipe.compositor.prepare(performance.now());
        pipe.compositor.render();
      }
    }
    status(sceneStatus());
  }
  function sceneStatus() {
    if (!alive.size) return competing ? "Another camera wrapper was present." : "Ready · start the site's camera";
    const sample = [...alive][0];
    const { osBlur, segmentation } = sample.compositor.stats;
    const hands = scene.hands && (sample.media.handStatus || "Hands starting");
    return [scene.name, sample.compositor.mode + " HTML", osBlur, segmentation !== "idle" && segmentation, hands, sample.media.summary(scene)].filter(Boolean).join(" · ");
  }
  function placePanel() {
    if (!panel || !panelPosition) return;
    const width = document.documentElement.clientWidth;
    const height = document.documentElement.clientHeight;
    const { width: cardWidth, height: cardHeight } = panel.getBoundingClientRect();
    const limit = (value, space) => Math.max(8, Math.min(value, space - 8));
    panel.style.inset = limit(panelPosition.y, height - cardHeight) + "px auto auto " + limit(panelPosition.x, width - cardWidth) + "px";
  }
  function savePanelPosition() {
    if (!panel) return;
    const { x, y } = panel.getBoundingClientRect();
    panelPosition = { x, y };
    window.postMessage({ from: "lightwell-page", panelPosition }, location.origin);
  }
  function wirePanelHandle(handle) {
    let drag;
    handle.addEventListener("pointerdown", event => {
      if (!event.isTrusted || !event.isPrimary || event.button !== 0) return;
      const { left, top } = panel.getBoundingClientRect();
      drag = { x: event.clientX - left, y: event.clientY - top };
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", event => {
      if (!drag || !handle.hasPointerCapture(event.pointerId)) return;
      panelPosition = { x: event.clientX - drag.x, y: event.clientY - drag.y };
      placePanel();
    });
    handle.addEventListener("lostpointercapture", () => {
      if (drag && panelPosition) savePanelPosition();
      drag = null;
    });
    handle.addEventListener("keydown", event => {
      const shift = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (!shift) return;
      event.preventDefault();
      event.stopPropagation();
      const { x, y } = panel.getBoundingClientRect();
      const step = event.shiftKey ? 36 : 9;
      panelPosition = { x: x + shift[0] * step, y: y + shift[1] * step };
      placePanel();
      savePanelPosition();
    });
  }
  window.addEventListener("resize", placePanel);

  function showDirector() {
    if (panel) return;
    panel = document.createElement("aside");
    panel.setAttribute("aria-label", "Lightwell call controls");
    const shadow = panel.attachShadow({ mode: "closed" });
    const styles = new CSSStyleSheet();
    styles.replaceSync(`
      :host{position:fixed;inset:auto auto 12px 12px;z-index:2147483646;font:12px/1.4 system-ui;color:#f1f5dd}
      div{border:1px solid #686f59;border-radius:8px;background:#181c1c;max-width:min(300px,calc(100vw - 36px));padding:7px 9px;box-shadow:0 3px 10px #0008}
      span{display:block;margin:3px 0 5px} button{color:#e4ff9c;background:#243126;border:1px solid #68745a;border-radius:4px;padding:4px 6px;margin-right:4px;cursor:pointer} button:focus-visible{outline:2px solid #dcff91}
      .move{display:flex;width:100%;justify-content:space-between;gap:10px;margin:0;padding:1px;color:inherit;background:none;border:0;font:inherit;font-weight:bold;text-align:left;cursor:grab;touch-action:none;user-select:none}
      .move:active{cursor:grabbing} .move b{color:#aebb9e}`);
    shadow.adoptedStyleSheets = [styles];
    const box = document.createElement("div");
    const title = document.createElement("button");
    title.type = "button";
    title.className = "move";
    title.textContent = "◈ Lightwell camera";
    title.title = "Drag to move, or use the arrow keys";
    title.setAttribute("aria-description", title.title);
    const grip = document.createElement("b");
    grip.textContent = "⠿";
    grip.setAttribute("aria-hidden", "true");
    title.append(grip);
    wirePanelHandle(title);
    line = document.createElement("span");
    line.setAttribute("role", "status");
    const open = document.createElement("button");
    open.textContent = "Open Studio";
    open.addEventListener("click", event => {
      if (event.isTrusted) window.postMessage({ from: "lightwell-page", openStudio: true }, location.origin);
    });
    box.append(title, line, open);
    shadow.append(box);
    document.documentElement.append(panel);
    panelObserver = new ResizeObserver(placePanel);
    panelObserver.observe(panel);
    placePanel();
  }

  function mountDirector() {
    if (!active) return;
    try { showDirector(); status(); }
    catch (error) { console.warn("Lightwell director", error); }
  }

  window.addEventListener("message", event => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin || data?.from !== "lightwell-extension") return;
    if (data.media) {
      if (!Number.isSafeInteger(data.media.request) || (data.media.frame && !(data.media.frame instanceof ImageBitmap))) return;
      const pipe = [...alive].find(pipe => pipe.media.id === data.media.session);
      if (pipe) pipe.media.receive(data.media);
      else data.media.frame?.close();
      return;
    }
    if (typeof data.config?.enabled !== "boolean") return;
    if (!active && data.config.panelPosition && Number.isFinite(data.config.panelPosition.x) && Number.isFinite(data.config.panelPosition.y)) {
      panelPosition = data.config.panelPosition;
    }
    active = data.config.enabled;
    configured = true;
    ready(undefined);
    if (!active) {
      generation++;
      dispose();
      status(data.config.disconnected ? "Extension disconnected · reload to reattach" : "Disabled on this origin");
      return;
    }
    everEnabled = true;
    updateScene(data.config.scene, data.config.publication);
    if (document.documentElement) mountDirector();
    else document.addEventListener("DOMContentLoaded", mountDirector, { once: true });
  });
  window.addEventListener("pagehide", () => { generation++; dispose(); });

  function releaseWhenUnused(pipe) {
    if (!pipe.outputs.size) pipe.close(false);
  }
  function decorate(out, pipe) {
    const { source, outputs } = pipe;
    const nativeStop = out.stop.bind(out);
    const nativeClone = out.clone.bind(out);
    const nativeSettings = out.getSettings.bind(out);
    const enabled = Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, "enabled");
    const cleanup = ended => {
      if (!outputs.delete(out)) return;
      nativeStop();
      if (ended) out.dispatchEvent(new Event("ended"));
      releaseWhenUnused(pipe);
    };
    Object.defineProperties(out, {
      label: { configurable: true, get: () => source.label },
      stop: { configurable: true, value: () => cleanup(false) },
      clone: { configurable: true, value: () => {
        const clone = nativeClone();
        return out.readyState === "live" ? decorate(clone, pipe) : clone;
      } },
      enabled: { configurable: true, get: () => enabled.get.call(out), set: value => {
        enabled.set.call(out, value);
        if (out.readyState === "live") source.enabled = [...outputs.keys()].some(track => track.enabled && track.readyState === "live");
      } },
      getSettings: { configurable: true, value: () => {
        const settings = source.getSettings();
        const actual = nativeSettings();
        const { canvas } = pipe.compositor;
        return { ...settings, width: canvas.width, height: canvas.height, aspectRatio: canvas.width / canvas.height,
          frameRate: Math.min(settings.frameRate || pipe.fps, actual.frameRate || pipe.fps) };
      } },
      getConstraints: { configurable: true, value: source.getConstraints.bind(source) },
      getCapabilities: { configurable: true, value: source.getCapabilities.bind(source) },
      applyConstraints: { configurable: true, value: constraints => out.readyState === "ended" ? Promise.resolve() : source.applyConstraints(constraints) },
    });
    outputs.set(out, cleanup);
    return out;
  }

  async function compose(stream, source, token) {
    const video = lab.cameraVideo(source);
    const shell = document.createElement("div");
    // A connected shadow subtree gives native HTML a layout box without placing it over site controls.
    Object.assign(shell.style, { position: "fixed", right: "0", bottom: "0", width: "320px", opacity: "0.001", pointerEvents: "none", zIndex: "-1" });
    shell.setAttribute("aria-hidden", "true");
    shell.inert = true;
    const shadow = shell.attachShadow({ mode: "closed" });
    const canvas = document.createElement("canvas");
    Object.assign(canvas.style, { display: "block", width: "100%", height: "auto" });
    shadow.append(canvas);
    let compositor;
    let outgoing;
    try {
      await lab.waitForVideo(video);
      if (token !== generation || !active || source.readyState !== "live") throw new Error("Camera composition was cancelled.");
      const settings = source.getSettings();
      const fps = Math.max(1, Math.min(settings.frameRate || 30, 60));
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      document.documentElement.append(shell);
      compositor = new lab.Compositor(canvas, scene, { fps });
      compositor.call = true;
      const media = new lab.CallMedia();
      media.configure(publication);
      compositor.segmenter = media;
      compositor.hands = media;
      compositor.remoteMedia = item => media.media(item);
      compositor.resizeToCamera = true;
      compositor.setCamera(video);
      compositor.prepare(performance.now());
      compositor.render();
      outgoing = canvas.captureStream(fps).getVideoTracks()[0];
      if (!outgoing) throw new Error("Canvas capture returned no video track.");
      compositor.start();

      let closed = false;
      const pipe = {
        compositor, media, source, fps, outputs: new Map(),
        close(event) {
          if (closed) return;
          closed = true;
          clearInterval(reaper);
          alive.delete(pipe);
          source.removeEventListener("ended", end);
          for (const cleanup of [...pipe.outputs.values()]) cleanup(event);
          source.stop();
          compositor.destroy();
          shell.remove();
          status(sceneStatus());
        },
      };
      const end = () => pipe.close(true);
      const reaper = setInterval(() => {
        if (source.readyState !== "live") { end(); return; }
        for (const [out, cleanup] of pipe.outputs) if (out.readyState === "ended") cleanup(false);
        const current = sceneStatus();
        if (current !== message) status(current);
      }, 450);
      decorate(outgoing, pipe);
      source.addEventListener("ended", end, { once: true });
      alive.add(pipe);
      stream.removeTrack(source);
      stream.addTrack(outgoing);
      mountDirector();
      status(sceneStatus());
      return stream;
    } catch (error) {
      outgoing?.stop();
      compositor?.destroy();
      shell.remove();
      video.srcObject = null;
      if (token !== generation || !active) {
        source.stop();
        stream.removeTrack(source);
        if (!stream.getAudioTracks().length) throw new DOMException("Camera composition cancelled", "AbortError");
        return stream;
      }
      status("Using the original camera · " + error.message);
      return stream;
    }
  }

  const wrapped = { async getUserMedia() {
    const requestedGeneration = generation;
    const stream = await Reflect.apply(nativeGet, this, arguments);
    const source = stream.getVideoTracks()[0];
    if (!source) return stream;
    if (!configured) {
      let timer;
      await Promise.race([configuredOnce, new Promise(resolve => { timer = setTimeout(resolve, 1400); })]);
      clearTimeout(timer);
    }
    if (requestedGeneration !== generation && everEnabled && source.readyState === "live") {
      source.stop();
      stream.removeTrack(source);
      if (!stream.getAudioTracks().length) throw new DOMException("Camera composition cancelled", "AbortError");
      return stream;
    }
    if (!active) return stream;
    pending.add(source);
    try { return await compose(stream, source, generation); }
    finally { pending.delete(source); }
  } }.getUserMedia;
  Object.defineProperty(prototype, "getUserMedia", { ...descriptor, value: wrapped });
})();
