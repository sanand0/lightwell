// @ts-check
// Classic scripts let MV3 register identical renderer code in MAIN and Studio.
(() => {
  const W = 1280;
  const H = 720;
  // Classic scripts injected into call tabs, in load order. Studio and the worker share this list.
  const callScripts = ["scene.js", "html-sources.js", "gl.js", "touch.js", "effects.js", "compositor.js", "call-media.js", "call-main.js"];
  const types = ["camera", "media", "html", "markdown", "display", "ink"];
  const legacy = ["solid", "gradient", "generated", "text", "image", "video"];
  const mediaTypes = ["media", "image", "video"];
  const fonts = { serif: "Georgia, serif", sans: "system-ui, sans-serif", mono: "monospace", rounded: "Trebuchet MS, sans-serif" };
  const cropEdges = ["left", "right", "top", "bottom"];
  const fits = ["contain", "cover", "stretch"];
  const clips = ["none", "rounded", "ellipse"];
  const blends = ["source-over", "multiply", "screen", "overlay", "lighter", "difference"];
  const effects = ["original", "os", "blur", "cutout"];
  // Experimental layer effects (see effects.js): a fill, a material look, an ambient motion and a triggered exit.
  // fill: what paints the layer's shape. Rain, pool, water, lens and smudge use WebGL (gl.js).
  const fxKinds = {
    fill: ["own", "camera", "glass", "echo", "prism"],
    look: ["none", "knit", "halftone", "tube", "neon", "rain", "pool"],
    move: ["none", "silk", "jelly", "melt", "rays", "water", "lens", "smudge"],
    exit: ["none", "shatter", "swarm", "burn", "vortex"],
  };
  const cameraFrames = {
    Corner: { x: 850, y: 460, w: 388, h: 220, clip: "rounded" },
    Side: { x: 720, y: 0, w: 560, h: 720, clip: "none" },
    Full: { x: 0, y: 0, w: W, h: H, clip: "none" },
  };
  const n = (value, fallback, min, max) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  const str = (value, fallback = "", max = 200) => typeof value === "string" ? value.slice(0, max) : fallback;
  const oneOf = (value, list) => list.includes(value) ? value : list[0];
  const hex = (value, fallback) => /^#[\da-f]{6}$/i.test(value) ? value : fallback;
  const assetURL = value => typeof value === "string" && /^(https?:\/\/|data:(image\/(png|jpeg|webp|gif|avif|svg\+xml)|video\/(webm|mp4|ogg));base64,)/i.test(value) ? value.slice(0, 8_000_000) : "";
  const transform = { x: 0, y: 0, w: W, h: H, rotation: 0, opacity: 1, fit: "cover", clip: "none", blend: "source-over", lockAspect: true };
  const sourceDefaults = {
    solid: { color: "#121129" }, gradient: { color: "#13112b", color2: "#333c77" },
    generated: { style: "orbit" },
    camera: { effect: "original", mirror: false, flip: false, brightness: 100, contrast: 100, saturation: 100, grayscale: 0, device: "default", cameraOff: false },
    html: { template: "metric", title: "Signal strength", markup: "", active: false, frozen: false, crop: 0 },
    text: { text: "Your title", color: "#fff3dc", size: 42 },
    markdown: { text: "# Your title", color: "#fff3dc", size: 38, font: "serif" },
    media: { url: "", filename: "", kind: "auto", background: "#121126" },
    ink: { strokes: [] },
  };

  function layer(type, overrides = {}) {
    return {
      id: crypto.randomUUID(), name: type[0].toUpperCase() + type.slice(1), type, visible: true,
      ...transform, ...overrides, source: { ...sourceDefaults[type], ...overrides.source },
    };
  }

  function normalize(scene) {
    if (scene?.version !== 1 || !Array.isArray(scene.layers)) throw new Error("Expected scene JSON with version 1 and a layers array.");
    if (scene.layers.length > 40) throw new Error("Scenes support up to 40 layers.");
    const ids = new Set();
    const layers = scene.layers.map(item => {
      if (![...types, ...legacy].includes(item?.type)) throw new Error("Unknown layer type: " + item?.type);
      const base = layer(item.type);
      let id = str(item.id, base.id);
      if (!id || ids.has(id)) id = base.id;
      ids.add(id);
      return {
        id, name: str(item.name, base.name, 80), type: item.type === "image" || item.type === "video" ? "media" : item.type === "text" ? "markdown" : item.type, visible: item.visible !== false,
        ...(item.revealBy && { revealBy: str(item.revealBy) }),
        x: n(item.x, 0, -W * 2, W * 3), y: n(item.y, 0, -H * 2, H * 3),
        w: n(item.w, W, 16, W * 3), h: n(item.h, H, 16, H * 3),
        rotation: n(item.rotation, 0, -360, 360), opacity: n(item.opacity, 1, 0, 1),
        lockAspect: item.lockAspect !== false, crop: normalizeCrop(item.crop),
        fit: oneOf(item.fit ?? (item.type === "media" ? "contain" : "cover"), fits), clip: oneOf(item.clip, clips), blend: oneOf(item.blend, blends),
        source: normalizeSource(item.type, item.source ?? {}),
        ...(item.fx && { fx: normalizeFx(item.fx) }),
      };
    });
    // pokes: recent Studio touches (stage units, Date.now() ms) that effects react to in calls too.
    const pokes = Array.isArray(scene.pokes) ? scene.pokes.slice(-16).filter(poke => Number.isFinite(poke?.at)).map(poke => ({
      x: n(poke.x, 0, -W, W * 2), y: n(poke.y, 0, -H, H * 2), at: n(poke.at, 0, 0, 1e14), kind: oneOf(poke.kind, ["tap", "drag"]),
    })) : [];
    return { version: 1, name: str(scene.name, "Untitled scene", 80), layers, ...(scene.hands === true && { hands: true }), ...(pokes.length && { pokes }) };
  }

  function normalizeFx(fx) {
    return {
      ...Object.fromEntries(Object.entries(fxKinds).map(([key, kinds]) => [key, oneOf(fx[key], kinds)])),
      amount: n(fx.amount, .5, 0, 1), gone: fx.gone === true, at: n(fx.at, 0, 0, 1e14),
      // Where an exit starts (shatter's impact), as a fraction of the layer box.
      ix: n(fx.ix, .5, 0, 1), iy: n(fx.iy, .45, 0, 1),
    };
  }

  function normalizeCrop(value) {
    const crop = Object.fromEntries(cropEdges.map(edge => [edge, n(value?.[edge], 0, 0, 95)]));
    crop.right = Math.min(crop.right, 99 - crop.left);
    crop.bottom = Math.min(crop.bottom, 99 - crop.top);
    return crop;
  }

  function normalizeSource(type, source) {
    const defaults = sourceDefaults[type];
    switch (type) {
      case "solid":
      case "gradient":
        return { color: hex(source.color, defaults.color), ...(type === "gradient" && { color2: hex(source.color2, defaults.color2) }) };
      case "text":
      case "markdown":
        return { text: str(source.text, defaults.text, type === "markdown" ? 16000 : 600), color: hex(source.color, defaults.color), size: n(source.size, defaults.size, 8, 240), font: oneOf(source.font, Object.keys(fonts)) };
      case "generated":
        return { style: oneOf(source.style, ["orbit", "chart"]) };
      case "camera":
        return {
          effect: oneOf(source.effect, effects), device: str(source.device, "default"), cameraOff: source.cameraOff === true, mirror: source.mirror === true, flip: source.flip === true,
          brightness: n(source.brightness, 100, 0, 200), contrast: n(source.contrast, 100, 0, 200),
          saturation: n(source.saturation, 100, 0, 200), grayscale: n(source.grayscale, 0, 0, 100),
        };
      case "html":
        return {
          template: typeof source.template === "string" && /^[a-z][a-z0-9-]{0,35}$/.test(source.template) ? source.template : "metric",
          title: str(source.title, defaults.title, 100), markup: str(source.markup, "", 120000),
          url: assetURL(source.url).startsWith("http") ? assetURL(source.url) : "", filename: str(source.filename, "", 100),
          active: source.active === true, frozen: source.frozen === true, crop: n(source.crop, 0, 0, 25),
        };
      case "image":
      case "video":
      case "media":
        return { url: assetURL(source.url), filename: str(source.filename, "", 100),
          kind: mediaTypes.includes(type) && type !== "media" ? type : oneOf(source.kind, ["auto", "image", "video"]),
          background: hex(source.background, "#121126") };
      case "ink":
        return { strokes: Array.isArray(source.strokes) ? source.strokes.slice(-250).filter(stroke => Array.isArray(stroke?.points)).map(stroke => ({
          tool: oneOf(stroke.tool, ["pen", "highlighter", "eraser"]),
          color: hex(stroke.color, "#faff85"), width: n(stroke.width, 6, 1, 100),
          points: stroke.points.slice(0, 1800).map(point => [n(point?.[0], 0, -W * 5, W * 5), n(point?.[1], 0, -H * 5, H * 5)]),
        })) : [] };
      default: return {};
    }
  }

  // Local file pixels travel separately from published scene metadata.
  function callScene(scene) {
    return { ...scene, layers: scene.layers.map(item => {
      if (item.type === "camera") {
        const { device, ...source } = item.source;
        return { ...item, source };
      }
      if (!mediaTypes.includes(item.type) || !item.source.url?.startsWith("data:")) return item;
      return { ...item, source: { ...item.source, url: "" } };
    }) };
  }

  const defaultScene = () => ({ version: 1, name: "Untitled scene", layers: [layer("camera", { name: "Camera" })] });
  const ordered = layers => layers.filter(item => item.visible && item.opacity > 0);
  const rad = degrees => degrees * Math.PI / 180;
  const rotate = (x, y, angle) => ({ x: x * Math.cos(angle) - y * Math.sin(angle), y: x * Math.sin(angle) + y * Math.cos(angle) });
  function toWorld(item, point) {
    const moved = rotate(point.x - item.w / 2, point.y - item.h / 2, rad(item.rotation));
    return { x: item.x + item.w / 2 + moved.x, y: item.y + item.h / 2 + moved.y };
  }
  function toLocal(item, point) {
    const moved = rotate(point.x - item.x - item.w / 2, point.y - item.y - item.h / 2, -rad(item.rotation));
    return { x: moved.x + item.w / 2, y: moved.y + item.h / 2 };
  }
  function resize(item, corner, delta, ratio) {
    const local = rotate(delta.x, delta.y, -rad(item.rotation));
    const west = corner.includes("w");
    const north = corner.includes("n");
    let w = Math.max(24, item.w + local.x * (west ? -1 : 1));
    let h = Math.max(24, item.h + local.y * (north ? -1 : 1));
    if (ratio > 0) {
      if (Math.abs(local.x) >= Math.abs(local.y * ratio)) h = w / ratio;
      else w = h * ratio;
      w = Math.max(w, 24, 24 * ratio); h = w / ratio;
    }
    return sizeFromCorner(item, corner, w, h);
  }
  function sizeFromCorner(item, corner, w, h) {
    const west = corner.includes("w");
    const north = corner.includes("n");
    const fixed = toWorld(item, { x: west ? item.w : 0, y: north ? item.h : 0 });
    const next = { ...item, w, h };
    const now = toWorld(next, { x: west ? w : 0, y: north ? h : 0 });
    return { w, h, x: next.x + fixed.x - now.x, y: next.y + fixed.y - now.y };
  }
  const axes = ["x", "y"];
  function bounds(item) {
    const cos = Math.abs(Math.cos(rad(item.rotation)));
    const sin = Math.abs(Math.sin(rad(item.rotation)));
    const cx = item.x + item.w / 2;
    const cy = item.y + item.h / 2;
    const w = (item.w * cos + item.h * sin) / 2;
    const h = (item.w * sin + item.h * cos) / 2;
    return { x: [cx - w, cx, cx + w], y: [cy - h, cy, cy + h] };
  }
  const gridLines = size => [0, size / 3, size / 2, size * 2 / 3, size];
  function snapTargets(layers, movingId) {
    const targets = { x: gridLines(W), y: gridLines(H) };
    for (const item of ordered(layers)) {
      if (item.id === movingId) continue;
      const box = bounds(item);
      for (const axis of axes) targets[axis].push(box[axis][0], box[axis][2]);
    }
    return targets;
  }
  function nearestGuide(edges, targets, tolerance, usable = () => true) {
    let best;
    for (const target of targets) for (const [index, edge] of edges.entries()) {
      if (!usable(index)) continue;
      const delta = target - edge;
      const distance = Math.abs(delta);
      if (distance <= tolerance && (!best || distance < best.distance)) best = { index, target, delta, distance };
    }
    return best;
  }
  function snapMove(item, targets, tolerance) {
    const result = { x: item.x, y: item.y, guides: {} };
    const box = bounds(item);
    for (const axis of axes) {
      const guide = nearestGuide(box[axis], targets[axis], tolerance[axis]);
      if (guide) { result[axis] += guide.delta; result.guides[axis] = guide.target; }
    }
    return result;
  }
  function snapResize(item, corner, delta, ratio, targets, tolerance) {
    const frame = resize(item, corner, delta, ratio);
    const box = bounds({ ...item, ...frame });
    // The rotated bounding-box edges are linear in width and height for a fixed angle.
    const boxAt = (w, h) => bounds({ ...item, ...sizeFromCorner(item, corner, w, h) });
    const wBox = boxAt(frame.w + 1, frame.h + (ratio ? 1 / ratio : 0));
    const hBox = boxAt(frame.w, frame.h + 1);
    const candidates = axes.flatMap(axis => {
      const derivatives = box[axis].map((edge, i) => [wBox[axis][i] - edge, ratio ? 0 : hBox[axis][i] - edge]);
      const guide = nearestGuide(box[axis], targets[axis], tolerance[axis], i => Math.hypot(...derivatives[i]) > .14);
      return guide ? [{ ...guide, axis, a: derivatives[guide.index][0], b: derivatives[guide.index][1] }] : [];
    });
    if (!candidates.length) return { ...frame, guides: {} };
    candidates.sort((a, b) => a.distance / tolerance[a.axis] - b.distance / tolerance[b.axis]);
    const [first, second] = candidates;
    const norm = first.a ** 2 + first.b ** 2;
    let dw = first.delta * first.a / norm;
    let dh = ratio ? dw / ratio : first.delta * first.b / norm;
    if (second && !ratio) {
      const determinant = first.a * second.b - second.a * first.b;
      if (Math.abs(determinant) > .1) {
        dw = (first.delta * second.b - second.delta * first.b) / determinant;
        dh = (first.a * second.delta - second.a * first.delta) / determinant;
      }
    }
    const limit = 3 * Math.max(tolerance.x, tolerance.y);
    if (Math.hypot(dw, dh) > limit || frame.w + dw < 24 || frame.h + dh < 24) return { ...frame, guides: {} };
    const snapped = sizeFromCorner(item, corner, frame.w + dw, frame.h + dh);
    const final = bounds({ ...item, ...snapped });
    const guides = Object.fromEntries(candidates.filter(guide => Math.abs(final[guide.axis][guide.index] - guide.target) < .01).map(guide => [guide.axis, guide.target]));
    return { ...snapped, guides };
  }

  const stagePoint = (rect, x, y) => ({ x: (x - rect.left) * W / rect.width, y: (y - rect.top) * H / rect.height });
  function fitRect(sw, sh, w, h, fit) {
    if (fit === "stretch") return [0, 0, w, h];
    const scale = (fit === "cover" ? Math.max : Math.min)(w / sw, h / sh);
    return [(w - sw * scale) / 2, (h - sh * scale) / 2, sw * scale, sh * scale];
  }

  function cropRect(width, height, crop) {
    const { left, top, right, bottom } = crop || {};
    const x = width * (left || 0) / 100;
    const y = height * (top || 0) / 100;
    return [x, y, width - x - width * (right || 0) / 100, height - y - height * (bottom || 0) / 100];
  }
  const videoURL = value => /^(?:data:video\/)|\.(?:mp4|webm|mov|ogg|ogv|m4v)(?:[?#]|$)/i.test(value || "");

  function preset(name) {
    const bg = (type, name, source) => layer(type, { name, source });
    const camera = (frame, effect = "original") => layer("camera", { name: "Camera", ...cameraFrames[frame], source: { effect } });
    const html = (name, x, y, w, h, source) => layer("html", { name, x, y, w, h, source });
    const ink = layer("ink", { name: "Stage ink" });
    const layers = {
      "Talking Head": () => [bg("gradient", "Backdrop"), camera("Full"), ink],
      "Presenter": () => [bg("generated", "Orbital field"), camera("Corner", "cutout"), ink],
      "Glass Dashboard": () => [
        bg("generated", "Orbital field"),
        layer("camera", { name: "Camera", x: 64, y: 106, w: 795, h: 510, clip: "rounded" }),
        html("Live signal card", 760, 185, 455, 325, { title: "Signal strength" }), ink,
      ],
      "Portal": () => {
        const portal = html("Portal panels", 75, 132, 690, 435, { template: "portal", title: "Two sides of the signal" });
        return [bg("generated", "Orbital field"),
          layer("gradient", { name: "Revealed backdrop", revealBy: portal.id, source: { color: "#3b094a", color2: "#b63d3f" } }),
          camera("Corner"), portal, ink];
      },
      "Data Magic": () => [
        bg("generated", "Animated spectrum", { style: "chart" }), camera("Corner", "cutout"),
        html("Live detail", 52, 38, 362, 258, { title: "Spectrum response" }), ink,
      ],
    }[name];
    return { version: 1, name: layers ? name : "Glass Dashboard", layers: layers ? layers() : preset("Glass Dashboard").layers };
  }

  globalThis.Lightwell ??= {};
  Object.assign(globalThis.Lightwell, { W, H, callScripts, types, mediaTypes, fonts, cropEdges, cropRect, videoURL, fits, clips, blends, effects, fxKinds, cameraFrames, transform, layer, normalize, ordered, toWorld, toLocal, resize, snapTargets, snapMove, snapResize, stagePoint, fitRect, defaultScene, preset, callScene });
})();
