// @ts-check
(() => {
  const lab = globalThis.Lightwell;
  const { W, H, ordered, fitRect, cropRect, mediaTypes, videoURL, fonts } = lab;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

  function htmlMode(canvas) {
    if (typeof canvas.getContext("2d")?.drawElementImage !== "function") return "fallback";
    canvas.setAttribute("content", "drawable");
    if (canvas.content === "drawable") return "native";
    if ("layoutSubtree" in canvas) {
      canvas.setAttribute("layoutsubtree", "");
      return "legacy";
    }
    return "fallback";
  }

  function surface(w, h) {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    return canvas;
  }
  function videoElement() {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    return video;
  }
  function waitForVideo(video, timeout = 3000) {
    if (video.readyState >= 2) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const close = () => {
        clearTimeout(timer);
        video.removeEventListener("loadeddata", ready);
        video.removeEventListener("error", failed);
      };
      const ready = () => { close(); resolve(undefined); };
      const failed = () => { close(); reject(new Error("No camera frame arrived.")); };
      const timer = setTimeout(failed, timeout);
      video.addEventListener("loadeddata", ready);
      video.addEventListener("error", failed);
    });
  }
  function cameraVideo(track) {
    const video = videoElement();
    video.srcObject = new MediaStream([track]);
    video.play().catch(() => {});
    return video;
  }
  const canToggleBlur = track => {
    const blur = track?.getCapabilities?.().backgroundBlur;
    return !!(blur?.includes(true) && blur.includes(false));
  };
  function blurSupport(track) {
    const native = track?.getSettings?.().backgroundBlur;
    if (native === true) return "OS blur active";
    if (canToggleBlur(track)) return "Native OS blur available";
    if (!globalThis.navigator?.mediaDevices?.getSupportedConstraints().backgroundBlur) return "This browser and OS do not expose native background blur. Use Segmented blur.";
    if (!track) return "Select and start a physical webcam to check native blur";
    if (track.getCapabilities().backgroundBlur?.includes(false)) return "Selected camera exposes blur as off and read-only";
    return "Selected camera or driver does not expose background blur";
  }
  async function setOSBlur(track, enabled) {
    if (!canToggleBlur(track)) throw new Error("OS background blur cannot be toggled on this camera.");
    await track.applyConstraints({ ...track.getConstraints(), backgroundBlur: { exact: enabled } });
    if (track.getSettings().backgroundBlur !== enabled) throw new Error("The camera did not confirm the requested OS blur setting.");
  }

  function osBlurControl(track) {
    let desired = false;
    let queue = Promise.resolve();
    let owned;
    let state = "";
    return {
      get native() { return !!(track?.readyState === "live" && track.getSettings().backgroundBlur === true); },
      get status() {
        if (!desired) return state;
        if (this.native) return "OS blur active";
        return state === "OS blur active" ? "OS blur no longer active · segmented fallback" : state;
      },
      update(enabled) {
        if (desired === enabled) return;
        desired = enabled;
        state = enabled ? "OS blur unavailable · segmented fallback" : "";
        if (!track || track.readyState !== "live") return;
        if (enabled && (this.native || canToggleBlur(track))) state = "Applying OS blur…";
        queue = queue.then(async () => {
          if (track.readyState !== "live" || desired !== enabled) return;
          if (!enabled) {
            if (!owned) return;
            const constraints = track.getConstraints();
            if (constraints.backgroundBlur?.exact === true) {
              await track.applyConstraints({ ...constraints, backgroundBlur: owned.original ?? { exact: false } });
            }
            owned = undefined;
            return;
          }
          if (this.native || !canToggleBlur(track)) {
            state = this.native ? "OS blur active" : "OS blur unavailable · segmented fallback";
            return;
          }
          const original = track.getConstraints().backgroundBlur;
          owned = { original };
          await setOSBlur(track, true);
          if (desired) state = "OS blur active";
        }).catch(error => {
          state = desired ? "OS blur unavailable · segmented fallback: " + error.message : "OS blur reset: " + error.message;
        });
      },
    };
  }

  function generate(ctx, w, h, now, style) {
    const gradient = ctx.createLinearGradient(0, 0, w, h);
    gradient.addColorStop(0, "#18142c");
    gradient.addColorStop(.58, "#343968");
    gradient.addColorStop(1, "#182b39");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#d2cdff24";
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 42) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = 0; y < h; y += 42) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    if (style === "chart") {
      for (let i = 0; i < 34; i++) {
        const x = w * (.08 + i * .025);
        const bar = h * (.14 + .47 * Math.abs(Math.sin(i * .34 + now / 2050)));
        ctx.fillStyle = i % 4 === 0 ? "#e7ff9ea8" : "#91c9ff80";
        ctx.fillRect(x, h * .86 - bar, w * .012, bar);
      }
      return;
    }
    const radius = Math.min(w, h);
    ctx.save();
    ctx.translate(w * .73, h * .4);
    ctx.rotate(-.35);
    for (let ring = 1; ring < 10; ring++) {
      ctx.strokeStyle = ring % 3 === 0 ? "#d8ff946e" : "#bed2ff40";
      ctx.beginPath();
      ctx.ellipse(0, 0, radius * (.18 + ring * .049), radius * (.10 + ring * .027), 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    const t = now / 3150;
    ctx.fillStyle = "#e3ffad";
    ctx.beginPath();
    ctx.arc(radius * .52 * Math.cos(t), radius * .29 * Math.sin(t), Math.max(3, radius / 100), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // The synthetic camera has a sharp subject and a high-frequency background for effect comparisons.
  function syntheticFrame(canvas, now) {
    const ctx = canvas.getContext("2d");
    const { width: w, height: h } = canvas;
    const bg = ctx.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, "#645e87"); bg.addColorStop(1, "#262b48");
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#d9c3a938";
    for (let x = 18; x < w; x += 29) ctx.fillRect(x, 0, 8, h);
    ctx.fillStyle = "#332c43";
    ctx.fillRect(0, h * .81, w, h * .19);
    const pilot = Math.sin(now / 2400) * 12;
    ctx.save();
    ctx.translate(w / 2 + pilot, h / 2);
    ctx.fillStyle = "#252236";
    ctx.beginPath(); ctx.ellipse(0, 159, 142, 107, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#dda17d";
    ctx.fillRect(-23, 25, 46, 65);
    ctx.beginPath(); ctx.ellipse(0, -16, 59, 73, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#332634";
    ctx.beginPath(); ctx.ellipse(-6, -58, 57, 36, -.24, Math.PI, Math.PI * 2); ctx.lineTo(42, -30); ctx.lineTo(-59, -49); ctx.fill();
    ctx.strokeStyle = "#2e2837"; ctx.lineWidth = 4;
    ctx.strokeRect(-48, -28, 42, 26); ctx.strokeRect(7, -28, 42, 26);
    ctx.beginPath(); ctx.moveTo(-6, -17); ctx.lineTo(7, -17); ctx.moveTo(-12, 24); ctx.quadraticCurveTo(0, 34, 13, 24); ctx.stroke();
    ctx.restore();
    ctx.font = "11px monospace";
    ctx.fillStyle = "#f6e6ce";
    ctx.fillText("SYNTHETIC CAMERA", 18, h - 17);
  }

  function paintClip(ctx, item) {
    const { w, h, clip } = item;
    ctx.beginPath();
    if (clip === "ellipse") ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    else if (clip === "rounded") ctx.roundRect(0, 0, w, h, Math.min(w, h) * .09);
    else ctx.rect(0, 0, w, h);
    ctx.clip();
  }

  function clipLayer(ctx, item) {
    paintClip(ctx, item);
    if (!item.crop || [...mediaTypes, "camera", "display", "html"].includes(item.type)) return;
    ctx.beginPath();
    ctx.rect(...cropRect(item.w, item.h, item.crop));
    ctx.clip();
  }

  function strokes(cache, list) {
    if (cache.list === list && cache.count === list.length && cache.tail === list.at(-1)?.points.length) return;
    cache.list = list;
    cache.count = list.length;
    cache.tail = list.at(-1)?.points.length;
    const ctx = cache.canvas.getContext("2d");
    ctx.clearRect(0, 0, W, H);
    for (const { tool, color, width, points } of list) {
      if (!points.length) continue;
      ctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
      ctx.globalAlpha = tool === "highlighter" ? .32 : 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = tool === "highlighter" ? width * 2.5 : width;
      ctx.lineJoin = ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(...points[0]);
      for (const point of points.slice(1)) ctx.lineTo(...point);
      if (points.length === 1) ctx.lineTo(points[0][0] + .01, points[0][1]);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }

  function drawMarkdown(ctx, item) {
    const { text, color, size, font } = item.source;
    let y = 0;
    let fenced = false;
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("```")) { fenced = !fenced; continue; }
      const block = /^(#{1,6}|[-*+]|>|\d+\.)\s+(.*)$/.exec(line);
      const tag = block?.[1] || "";
      const heading = tag.startsWith("#");
      const scale = heading ? 1.65 - tag.length * .09 : 1;
      const fontSize = size * scale;
      const row = fontSize * 1.25;
      const indent = /^[-*+>]|^\d+\.$/.test(tag) ? fontSize * .7 : 0;
      const prefix = tag === ">" ? "│ " : indent ? (/^\d/.test(tag) ? tag + " " : "• ") : "";
      const content = prefix + (block?.[2] ?? line);
      let x = indent;
      ctx.textBaseline = "top";
      const parts = fenced ? [content] : content.split(/(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)/);
      for (const part of parts) {
        if (!part) continue;
        const code = fenced || part.startsWith("`") && part.endsWith("`");
        const bold = /^(\*\*|__)(.+)\1$/.test(part);
        const italic = !bold && /^(\*|_)(.+)\1$/.test(part);
        const spelling = !fenced && code ? part.slice(1, -1) : bold ? part.slice(2, -2) : italic ? part.slice(1, -1) : part;
        ctx.font = (italic || tag === ">" ? "italic " : "") + (heading || bold ? "bold " : "") + fontSize + "px " + (code ? fonts.mono : fonts[font] || fonts.serif);
        for (const word of spelling.match(/\s+|\S+/g) || []) {
          const width = ctx.measureText(word).width;
          if (x > indent && x + width > item.w) { x = indent; y += row; }
          if (y >= item.h) return;
          if (code) { ctx.fillStyle = "#30334a"; ctx.fillRect(x, y, width, row * .92); }
          ctx.fillStyle = color;
          ctx.fillText(word, x, y, item.w - x);
          x += width;
        }
      }
      y += line ? row : row * .55;
      if (y >= item.h) return;
    }
  }

  class Compositor {
    constructor(canvas, scene, { action = () => {}, fallback = false, fps = 30 } = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      if (!this.ctx) throw new Error("Canvas 2D is unavailable.");
      this.scene = scene;
      this.action = action;
      this.mode = fallback ? "fallback" : htmlMode(canvas);
      this.fps = fps;
      this.stats = { fps: 0, ms: 0, native: 0, error: "", segmentation: "idle" };
      this.cache = new Map();
      this.camera = null;
      this.cameraInputs = new Map();
      this.synthetic = null;
      this.segmenter = null;
      this.osBlur = osBlurControl(null);
      this.renderedAt = 0;
      this.running = false;
      this.framePending = false;
      this.onPaint = () => { if (this.framePending) this.render(); };
      canvas.addEventListener("paint", this.onPaint);
    }

    report(message) { this.stats.error = String(message); }
    setScene(scene) {
      this.scene = scene;
      this.prune();
    }
    prune() {
      const lookup = new Map(this.scene.layers.map(item => [item.id, item]));
      for (const id of this.cameraInputs.keys()) if (lookup.get(id)?.type !== "camera") this.removeLayerCamera(id);
      for (const [id, cache] of this.cache) {
        const item = lookup.get(id);
        if (item?.type === cache.type) continue;
        this.release(cache);
        this.cache.delete(id);
      }
    }
    release(cache, dispose = true) {
      cache.root?.remove();
      if (dispose && cache.fileURL) URL.revokeObjectURL(cache.fileURL);
      if (cache.resource instanceof HTMLVideoElement) {
        cache.resource.pause();
        cache.resource.removeAttribute("src");
        cache.resource.srcObject = null;
        cache.resource.load();
      } else if (cache.resource instanceof HTMLImageElement) cache.resource.removeAttribute("src");
      cache.resource = null;
      cache.stream?.getTracks().forEach(track => track.stop());
    }
    local(item) {
      if (!this.cache.has(item.id)) this.cache.set(item.id, { type: item.type });
      return this.cache.get(item.id);
    }
    setDisplay(item, stream) {
      const cache = this.local(item);
      this.release(cache);
      cache.stream = cache.resource = null;
      if (!stream) return;
      const video = cameraVideo(stream.getVideoTracks()[0]);
      cache.stream = stream;
      cache.resource = video;
      stream.getVideoTracks()[0].addEventListener("ended", () => {
        if (cache.stream !== stream) return;
        this.release(cache);
        cache.stream = cache.resource = null;
      }, { once: true });
    }
    setFile(item, file) {
      const cache = this.local(item);
      this.release(cache);
      cache.url = undefined;
      cache.resource = null;
      cache.fileURL = file ? URL.createObjectURL(file) : null;
    }
    setCamera(video) {
      if (this.camera && this.camera !== video) this.camera.srcObject = null;
      this.osBlur.update(false);
      this.camera = video;
      this.osBlur = osBlurControl(video?.srcObject?.getVideoTracks()[0]);
      this.synthetic = null;
      this.segmenter?.reset();
    }
    setSynthetic() {
      this.setCamera(null);
      this.synthetic = surface(640, 360);
    }

    setLayerCamera(id, value, segmenter) {
      this.removeLayerCamera(id);
      const synthetic = value === "synthetic" ? surface(640, 360) : null;
      const video = synthetic ? null : value;
      this.cameraInputs.set(id, { video, synthetic, segmenter, os: osBlurControl(video?.srcObject?.getVideoTracks()[0]) });
    }
    removeLayerCamera(id) {
      const input = this.cameraInputs.get(id);
      if (!input) return;
      input.os.update(false);
      input.segmenter?.close();
      if (input.video) input.video.srcObject = null;
      this.cameraInputs.delete(id);
    }

    sourceSize(item) {
      const cached = this.cache.get(item.id);
      const local = this.cameraInputs.get(item.id);
      const source = item.type === "camera" ? (local ? local.synthetic || local.video : this.synthetic || this.camera)
        : this.remoteMedia?.(item) ?? cached?.resource;
      const w = source?.videoWidth || source?.naturalWidth || source?.width || cached?.width;
      const h = source?.videoHeight || source?.naturalHeight || source?.height || cached?.height;
      return w && h ? cropRect(w, h, item.crop).slice(2) : null;
    }

    prepare(now) {
      if (this.synthetic) syntheticFrame(this.synthetic, now);
      const cameraLayers = this.scene.layers.filter(item => item.visible && item.opacity > 0 && item.type === "camera");
      const shared = cameraLayers.filter(item => !item.source.cameraOff && !this.cameraInputs.has(item.id));
      const wantsOS = shared.some(item => item.source.effect === "os");
      this.osBlur.update(wantsOS);
      this.stats.osBlur = this.osBlur.status;
      const needsMask = shared.some(item => ["blur", "cutout"].includes(item.source.effect)) || (wantsOS && !this.osBlur.native);
      const source = this.synthetic || this.camera;
      this.stats.segmentation = needsMask ? source ? this.segmenter?.status ?? "unavailable; using original" : "waiting for camera" : "idle";
      if (needsMask && source && this.segmenter && (this.synthetic || this.camera.readyState >= 2)) {
        this.segmenter.step(source, now, !!this.synthetic);
        this.stats.segmentation = this.segmenter.status;
      } else if (!needsMask && this.segmenter?.mask) {
        this.segmenter.reset();
      }

      for (const item of cameraLayers) {
        const input = this.cameraInputs.get(item.id);
        if (!input) continue;
        if (input.synthetic) syntheticFrame(input.synthetic, now);
        input.os.update(item.source.effect === "os");
        if (input.os.status) this.stats.osBlur = input.os.status;
        const needsLocalMask = ["blur", "cutout"].includes(item.source.effect) || (item.source.effect === "os" && !input.os.native);
        if (needsLocalMask && input.segmenter && (input.synthetic || input.video?.readyState >= 2)) {
          input.segmenter.step(input.synthetic || input.video, now, !!input.synthetic);
          this.stats.segmentation = input.segmenter.status;
        } else if (!needsLocalMask && input.segmenter?.mask) input.segmenter.reset();
      }
      for (const item of this.scene.layers) {
        if (item.type !== "html" || this.mode === "fallback") continue;
        const cache = this.local(item);
        const key = item.source.template + "\n" + item.source.markup;
        if (key !== cache.key) {
          cache.root?.remove();
          cache.root = cache.failure = null;
          cache.key = key;
          try {
            Object.assign(cache, lab.htmlSource(item.source, property => this.action(item.id, property)));
            this.canvas.append(cache.root);
          } catch (error) {
            cache.failure = "HTML source blocked";
            this.report(error);
          }
        }
        if (cache.root) {
          if (!item.visible || item.opacity <= 0) {
            this.canvas.clearElementGeometry?.(cache.root);
            cache.root.inert = true;
          } else {
            cache.root.inert = false;
            cache.amount = cache.update(item.source, now);
          }
        }
      }
    }

    media(item) {
      const remote = this.remoteMedia?.(item);
      if (remote !== undefined) return remote;
      const cache = this.local(item);
      if (item.type === "display") return cache.resource;
      const url = cache.fileURL || item.source.url;
      const hint = item.type === "media" ? item.source.kind : item.type;
      if (cache.url === url && cache.hint === hint) return cache.resource;
      this.release(cache, false);
      cache.url = url;
      cache.hint = hint;
      cache.resource = null;
      if (!url) return null;
      const load = isVideo => {
        const resource = isVideo ? videoElement() : new Image();
        if (/^https?:/.test(url)) resource.crossOrigin = "anonymous";
        resource.addEventListener("error", () => {
          if (cache.resource !== resource) return;
          if (!isVideo && hint === "auto") { load(true); return; }
          this.report(item.name + " could not load. Check the asset type and CORS.");
        }, { once: true });
        cache.resource = resource;
        resource.src = url;
        if (isVideo) { resource.loop = true; resource.play().catch(() => {}); }
      };
      load(hint === "video" || (hint === "auto" && videoURL(url)));
      return cache.resource;
    }

    drawFitted(ctx, source, item) {
      if (!source) return false;
      const sw = source.videoWidth ?? source.naturalWidth ?? source.width;
      const sh = source.videoHeight ?? source.naturalHeight ?? source.height;
      if (!sw || !sh || ("readyState" in source && source.readyState < 2)) return false;
      const crop = cropRect(sw, sh, item.crop);
      if (mediaTypes.includes(item.type) && item.fit === "contain") {
        ctx.fillStyle = item.source.background;
        const [x, y, w, h] = fitRect(crop[2], crop[3], item.w, item.h, item.fit);
        if (x > 0) { ctx.fillRect(0, 0, x, item.h); ctx.fillRect(x + w, 0, x, item.h); }
        if (y > 0) { ctx.fillRect(0, 0, item.w, y); ctx.fillRect(0, y + h, item.w, y); }
      }
      ctx.drawImage(source, ...crop, ...fitRect(crop[2], crop[3], item.w, item.h, item.fit));
      return true;
    }
    cameraImage(item) {
      if (item.source.cameraOff) return null;
      const local = this.cameraInputs.get(item.id);
      const remote = this.remoteMedia?.(item);
      if (remote !== undefined) return remote;
      const input = local ? local.synthetic || local.video : this.synthetic || this.camera;
      const mask = (local ? local.segmenter : this.segmenter)?.mask;
      const os = local?.os || this.osBlur;
      const { effect } = item.source;
      if (input && mask && (effect === "blur" || effect === "cutout" || (effect === "os" && !os.native))) {
        return this.effectFrame(input, mask, effect) || input;
      }
      return input;
    }
    drawCamera(ctx, item) {
      const { brightness, contrast, saturation, grayscale, mirror, flip } = item.source;
      ctx.translate(mirror ? item.w : 0, flip ? item.h : 0);
      ctx.scale(mirror ? -1 : 1, flip ? -1 : 1);
      ctx.filter = "brightness(" + brightness + "%) contrast(" + contrast + "%) saturate(" + saturation + "%) grayscale(" + grayscale + "%)";
      return this.drawFitted(ctx, this.cameraImage(item), item);
    }
    effectFrame(input, mask, effect) {
      const sw = input.videoWidth ?? input.width;
      const sh = input.videoHeight ?? input.height;
      if (!sw || !sh) return null;
      const w = Math.min(960, sw);
      const h = Math.max(1, Math.round(sh * w / sw));
      this.effectBuffers ??= [surface(w, h), surface(w, h)];
      const [person, output] = this.effectBuffers;
      for (const buffer of this.effectBuffers) {
        if (buffer.width === w && buffer.height === h) continue;
        buffer.width = w; buffer.height = h;
      }
      const p = person.getContext("2d");
      p.clearRect(0, 0, w, h);
      p.drawImage(input, 0, 0, w, h);
      p.globalCompositeOperation = "destination-in";
      p.filter = "blur(2px)";
      p.drawImage(mask, 0, 0, w, h);
      p.filter = "none";
      p.globalCompositeOperation = "source-over";
      if (effect === "cutout") return person;
      const c = output.getContext("2d");
      c.clearRect(0, 0, w, h);
      c.filter = "blur(" + Math.max(9, w / 45) + "px)";
      c.drawImage(input, -w * .055, -h * .08, w * 1.11, h * 1.16);
      c.filter = "none";
      c.drawImage(person, 0, 0);
      return output;
    }

    drawHTML(ctx, item, now) {
      const cache = this.local(item);
      if (cache.root && !cache.failure) {
        const { width, height, root } = cache;
        try {
          const size = this.canvas.getElementImageDefaultSize?.(root);
          const sw = size?.width || width;
          const sh = size?.height || height;
          const legacy = item.source.crop;
          const crop = cropRect(sw, sh, legacy && !Object.values(item.crop || {}).some(Boolean)
            ? { left: legacy, right: legacy, top: legacy, bottom: legacy } : item.crop);
          const [x, y, w, h] = fitRect(crop[2], crop[3], item.w, item.h, item.fit);
          if (crop[0] || crop[1] || crop[2] !== sw || crop[3] !== sh) ctx.drawElementImage(root, ...crop, x, y, w, h);
          else ctx.drawElementImage(root, x, y, w, h);
          cache.retries = 0;
          this.stats.native++;
          return;
        } catch (error) {
          cache.retries = (cache.retries || 0) + 1;
          if (cache.retries === 6) this.report(item.name + " native snapshot: " + error.message);
        }
      }
      lab.htmlFallback(ctx, item, now, cache.failure || (this.mode === "fallback" ? "HTML fallback" : "Waiting for HTML"));
    }

    drawLayer(ctx, item, now) {
      const { w, h, type, source } = item;
      if (type === "gradient" || type === "solid") {
        const fill = type === "gradient" ? ctx.createLinearGradient(0, 0, w, h) : null;
        fill?.addColorStop(0, source.color);
        fill?.addColorStop(1, source.color2);
        ctx.fillStyle = fill || source.color;
        ctx.fillRect(0, 0, w, h);
      } else if (type === "generated") {
        generate(ctx, w, h, now, source.style);
      } else if (type === "camera") {
        if (!this.drawCamera(ctx, item) && !this.call) this.placeholder(ctx, item, "CAMERA OFF");
      } else if (type === "markdown") {
        drawMarkdown(ctx, item);
      } else if (type === "text") {
        ctx.fillStyle = source.color;
        ctx.font = source.size + "px Georgia,serif";
        ctx.textBaseline = "top";
        for (const [i, line] of source.text.split("\n").entries()) ctx.fillText(line, 0, i * source.size * 1.14, w);
      } else if (type === "html") {
        this.drawHTML(ctx, item, now);
      } else if (type === "ink") {
        const cache = this.local(item);
        cache.canvas ??= surface(W, H);
        strokes(cache, source.strokes);
        ctx.drawImage(cache.canvas, 0, 0, w, h);
      } else if (!this.drawFitted(ctx, this.media(item), item)) {
        this.placeholder(ctx, item, item.source.filename || (type === "display" ? "DISPLAY SOURCE OFF" : "MEDIA SOURCE OFF"));
      }
    }
    placeholder(ctx, item, label) {
      ctx.filter = "none";
      ctx.fillStyle = "#23243a";
      ctx.fillRect(0, 0, item.w, item.h);
      ctx.fillStyle = "#ced1ee";
      ctx.font = "16px monospace";
      ctx.textAlign = "center";
      ctx.fillText(label, item.w / 2, item.h / 2, item.w * .84);
    }

    // Draws one layer, clipped, into its own bitmap so experimental effects can bend or break it.
    flatten(item, now) {
      const { canvas } = this;
      // Output pixels per scene unit, capped so the HTML pre-pass fits inside the canvas it borrows.
      const scale = Math.min(canvas.width / W, canvas.height / H, canvas.width / item.w, canvas.height / item.h);
      const w = Math.max(1, Math.round(item.w * scale));
      const h = Math.max(1, Math.round(item.h * scale));
      const cache = this.local(item);
      const flat = cache.flat ??= surface(w, h);
      if (flat.width !== w || flat.height !== h) { flat.width = w; flat.height = h; }
      const out = flat.getContext("2d");
      out.clearRect(0, 0, w, h);
      // drawElementImage only paints children of this canvas, so HTML is drawn here, copied, then painted over.
      const html = item.type === "html";
      const ctx = html ? this.ctx : out;
      ctx.save();
      ctx.resetTransform();
      if (html) ctx.clearRect(0, 0, w, h);
      ctx.scale(scale, scale);
      clipLayer(ctx, item);
      this.drawLayer(ctx, item, now);
      ctx.restore();
      if (html) out.drawImage(canvas, 0, 0, w, h, 0, 0, w, h);
      return flat;
    }

    render(now = performance.now()) {
      this.framePending = false;
      const start = performance.now();
      const { canvas, ctx } = this;
      this.stats.native = 0;
      const flats = new Map();
      for (const item of ordered(this.scene.layers)) {
        if (!lab.fx?.active(item)) continue;
        try { flats.set(item.id, this.flatten(item, now)); } catch (error) { this.report(item.name + " effect: " + error.message); }
      }
      ctx.resetTransform();
      ctx.fillStyle = "#121126";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const [x, y, w, h] = fitRect(W, H, canvas.width, canvas.height, "contain");
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(w / W, h / H);
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.clip();
      for (const item of ordered(this.scene.layers)) {
        const portal = item.revealBy && this.scene.layers.find(layer => layer.id === item.revealBy && layer.visible);
        const reveal = portal ? this.cache.get(portal.id)?.amount ?? Number(!!portal.source.active) : Number(!item.revealBy);
        ctx.save();
        try {
          ctx.globalAlpha = item.opacity * reveal;
          ctx.globalCompositeOperation = item.blend;
          ctx.translate(item.x + item.w / 2, item.y + item.h / 2);
          ctx.rotate(item.rotation * Math.PI / 180);
          ctx.translate(-item.w / 2, -item.h / 2);
          const flat = flats.get(item.id);
          if (flat) lab.fx.draw(ctx, flat, item, now, this.local(item).fx ??= {});
          else {
            clipLayer(ctx, item);
            this.drawLayer(ctx, item, now);
          }
        } catch (error) {
          this.report(item.name + ": " + error.message);
        } finally {
          ctx.restore();
        }
      }
      ctx.restore();
      this.stats.ms = performance.now() - start;
      const frameRate = clamp(1000 / (now - this.renderedAt), 0, 100);
      this.stats.fps = this.stats.fps ? this.stats.fps * .9 + frameRate * .1 : frameRate;
      this.renderedAt = now;
    }

    start() {
      if (this.running) return;
      this.running = true;
      const tick = () => {
        const now = performance.now();
        if (this.resizeToCamera && this.camera?.videoWidth && this.camera?.videoHeight &&
            (this.canvas.width !== this.camera.videoWidth || this.canvas.height !== this.camera.videoHeight)) {
          this.canvas.width = this.camera.videoWidth;
          this.canvas.height = this.camera.videoHeight;
        }
        if (this.framePending) this.render(now);
        this.prepare(now);
        if (this.mode === "fallback" || !this.canvas.requestPaint || document.hidden) this.render(now);
        else {
          this.framePending = true;
          this.canvas.requestPaint();
        }
        this.timer = setTimeout(tick, 1000 / this.fps);
      };
      tick();
    }
    destroy() {
      this.running = false;
      this.framePending = false;
      clearTimeout(this.timer);
      this.canvas.removeEventListener("paint", this.onPaint);
      this.osBlur.update(false);
      for (const id of this.cameraInputs.keys()) this.removeLayerCamera(id);
      this.segmenter?.close();
      for (const cache of this.cache.values()) this.release(cache);
      this.cache.clear();
      if (this.camera) this.camera.srcObject = null;
    }
  }

  Object.assign(lab, { Compositor, cameraVideo, waitForVideo, htmlMode, canToggleBlur, blurSupport, setOSBlur });
})();
