// @ts-check
// Experimental layer effects. Each layer is flattened to a bitmap (HTML via drawElementImage), then:
// fill (what paints its shape) -> look (material) -> motion (ambient) or exit (one-shot, triggered, reversible).
// Effects get item-local touches (touch.js) from the Studio Touch tool, typing and hand gestures.
// Everything is Canvas 2D: strips, tiles, clipped shards, masks and additive copies. No WebGL.
// Exit timing uses Date.now() so Studio and call tabs on the same machine play the same moment.
(() => {
  const lab = globalThis.Lightwell;
  const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
  const smooth = value => value * value * (3 - 2 * value);
  const TAU = Math.PI * 2;
  // Exit durations: a flock needs longer to wheel than glass needs to fall.
  const exitMs = { shatter: 2000, swarm: 3200, burn: 2600, vortex: 2400 };
  const seamMs = 2200;

  function random(seed) {
    let state = 2166136261;
    for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619);
    return () => {
      state = state + 0x6D2B79F5 | 0;
      let t = Math.imul(state ^ state >>> 15, 1 | state);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  // Reusable scratch canvas per layer and purpose. Resizing clears it.
  function buffer(bag, key, w, h) {
    const canvas = bag[key] ??= document.createElement("canvas");
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext("2d", { willReadFrequently: key === "sample" });
    ctx.reset?.();
    ctx.clearRect(0, 0, w, h);
    return { canvas, ctx };
  }
  // A cached seeded structure (shards, grains, noise) rebuilt only when its key changes.
  function memo(bag, name, key, build) {
    if (bag[name]?.key !== key) bag[name] = { key, value: build() };
    return bag[name].value;
  }
  function tinted(bag, src, color) {
    const { canvas, ctx } = buffer(bag, "tint", src.width, src.height);
    ctx.drawImage(src, 0, 0);
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, src.width, src.height);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(src, 0, 0);
    return canvas;
  }

  // A WebGL effect from gl.js. Looks copy the shared GL canvas out, since a motion may use it next.
  // Each effect keeps its own GPU resources in its own sub-bag. Without WebGL the layer is drawn unchanged.
  function shader(name, args) {
    const out = lab.gl?.run(name, { ...args, bag: args.bag["gl-" + name] ??= {} });
    if (!out && !args.bag.warned) {
      args.bag.warned = true;
      console.warn("Lightwell:", name, "needs WebGL2.", lab.gl?.failure ?? "");
    }
    return out;
  }
  const lookShader = name => args => {
    const out = shader(name, args);
    if (!out) return args.src;
    const { canvas, ctx } = buffer(args.bag, "glcopy", out.width, out.height);
    ctx.drawImage(out, 0, 0);
    return canvas;
  };
  const moveShader = name => args => args.ctx.drawImage(shader(name, args) ?? args.src, 0, 0, args.w, args.h);

  // ---------- Fills: what paints the layer's shape (alpha is kept) ----------
  function filled(bag, src, paint) {
    const { canvas, ctx } = buffer(bag, "fill", src.width, src.height);
    ctx.drawImage(src, 0, 0);
    ctx.globalCompositeOperation = "source-in";
    return paint(ctx, src.width, src.height) === false ? src : canvas;
  }
  const fills = {
    // Your camera inside the shape: letters, ink strokes or a card cut out of your video.
    camera: ({ src, bag, env }) => filled(bag, src, (ctx, w, h) => env.camera(ctx, w, h)),
    // The whole output frame inside the shape, which then contains itself again: a Droste tunnel.
    echo: ({ src, bag, env }) => filled(bag, src, (ctx, w, h) => {
      if (!env.echo) return false;
      ctx.drawImage(env.echo, ...lab.fitRect(env.echo.width, env.echo.height, w, h, "cover"));
    }),
    // A slowly turning spectrum.
    prism: ({ src, bag, now }) => filled(bag, src, (ctx, w, h) => {
      const fill = ctx.createConicGradient(now / 2200, w / 2, h / 2);
      ["#ff5d8f", "#ffb347", "#f9f871", "#6dffb0", "#5ec8ff", "#a78bff", "#ff5d8f"].forEach((color, i, all) => fill.addColorStop(i / (all.length - 1), color));
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, w, h);
    }),
    // Frosted glass: whatever is under the layer, blurred and milky, with the layer's own content faint on top.
    glass({ src, bag, env, item, k }) {
      const { canvas, ctx } = buffer(bag, "fill", src.width, src.height);
      if (!env.backdrop(ctx, item, k)) return src;
      ctx.fillStyle = "rgb(255 255 255 / .12)";
      ctx.fillRect(0, 0, src.width, src.height);
      ctx.globalCompositeOperation = "destination-in";
      ctx.drawImage(src, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = .5;
      ctx.drawImage(src, 0, 0);
      return canvas;
    },
  };

  // ---------- Looks: bitmap -> bitmap of the same size ----------
  const looks = {
    // Neon tube: two blurred, brightened copies added under a crisp core. Lovely on pen ink.
    neon({ src, bag, k, amount }) {
      const { canvas, ctx } = buffer(bag, "look", src.width, src.height);
      ctx.filter = "blur(" + (4 + 10 * amount) * k + "px) saturate(1.8) brightness(1.5)";
      ctx.drawImage(src, 0, 0);
      ctx.globalCompositeOperation = "lighter";
      ctx.filter = "blur(" + (1.5 * k) + "px) saturate(1.5) brightness(1.3)";
      ctx.drawImage(src, 0, 0);
      ctx.filter = "none";
      ctx.drawImage(src, 0, 0);
      return canvas;
    },
    rain: lookShader("rain"),
    pool: lookShader("pool"),
    // Knitted wool: a colour mosaic, shaded by one repeating stitch tile, cut back to the layer's alpha.
    knit({ src, bag, k, amount }) {
      const cw = Math.max(4, (5 + 9 * amount) * k);
      const ch = cw * .8;
      const cols = Math.ceil(src.width / cw);
      const rows = Math.ceil(src.height / ch);
      const small = buffer(bag, "mosaic", cols, rows);
      // Brighten before averaging so thin light strokes survive as whole stitches.
      small.ctx.filter = "brightness(1.5) saturate(1.4)";
      small.ctx.drawImage(src, 0, 0, cols * cw, rows * ch, 0, 0, cols, rows);
      const tile = memo(bag, "stitch", cw.toFixed(1), () => {
        const { canvas, ctx } = buffer({}, "tile", cw, ch);
        ctx.fillStyle = "#5a5a5a";
        ctx.fillRect(0, 0, cw, ch);
        const fill = ctx.createLinearGradient(0, 0, 0, ch);
        fill.addColorStop(0, "#ffffff"); fill.addColorStop(1, "#b4b4b4");
        ctx.fillStyle = fill;
        for (const side of [-1, 1]) {
          ctx.beginPath();
          ctx.ellipse(cw * (.5 + side * .2), ch * .5, cw * .26, ch * .6, side * -.55, 0, TAU);
          ctx.fill();
        }
        return canvas;
      });
      const { canvas, ctx } = buffer(bag, "look", src.width, src.height);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(small.canvas, 0, 0, cols * cw, rows * ch);
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = ctx.createPattern(tile, "repeat");
      ctx.fillRect(0, 0, src.width, src.height);
      ctx.globalCompositeOperation = "destination-in";
      ctx.drawImage(small.canvas, 0, 0, cols * cw, rows * ch);
      return canvas;
    },
    // Halftone print: one dot per cell, sized by brightness, on a staggered grid.
    halftone({ src, bag, k, amount }) {
      // Each dot is a separate fill, so cap the count (~6000) for full-frame camera layers.
      const cell = Math.max(3, (3 + 8 * amount) * k, Math.sqrt(src.width * src.height / 6000));
      const cols = Math.ceil(src.width / cell) + 1;
      const rows = Math.ceil(src.height / cell);
      const sample = buffer(bag, "sample", cols, rows);
      sample.ctx.drawImage(src, 0, 0, cols * cell, rows * cell, 0, 0, cols, rows);
      const data = sample.ctx.getImageData(0, 0, cols, rows).data;
      const { canvas, ctx } = buffer(bag, "look", src.width, src.height);
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const i = (y * cols + x) * 4;
        const alpha = data[i + 3] / 255;
        if (alpha < .05) continue;
        const light = Math.max(data[i], data[i + 1], data[i + 2]) / 255;
        ctx.fillStyle = "rgb(" + data[i] + " " + data[i + 1] + " " + data[i + 2] + " / " + alpha + ")";
        ctx.beginPath();
        ctx.arc((x + (y % 2) * .5) * cell, (y + .5) * cell, cell * .64 * Math.sqrt(Math.max(.18, light)), 0, TAU);
        ctx.fill();
      }
      return canvas;
    },
    // Cathode tube / VHS: RGB channels misregistered, a tracking band that slips, scanlines, flicker.
    tube({ src, bag, k, amount, now }) {
      const { width: w, height: h } = src;
      const { canvas, ctx } = buffer(bag, "look", w, h);
      const shift = (1 + 5 * amount) * k * (1 + .4 * Math.sin(now / 90));
      ctx.globalCompositeOperation = "lighter";
      for (const [color, dx] of [["#ff0000", -shift], ["#00ff00", 0], ["#0000ff", shift]]) ctx.drawImage(tinted(bag, src, color), dx, 0);
      const band = h * .07;
      const y = (now / 9) % (h + band) - band;
      const slip = buffer(bag, "slip", w, band);
      slip.ctx.drawImage(canvas, 0, y, w, band, 0, 0, w, band);
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, y, w, band);
      ctx.drawImage(slip.canvas, (8 + 22 * amount) * k * Math.sin(now / 37), y);
      ctx.globalCompositeOperation = "source-atop";
      const lines = memo(bag, "scan", k.toFixed(2), () => {
        const tile = buffer({}, "tile", 1, Math.max(3, Math.round(3 * k)));
        tile.ctx.fillStyle = "#000000";
        tile.ctx.fillRect(0, 0, 1, Math.max(1, Math.round(k)));
        return tile.canvas;
      });
      ctx.globalAlpha = .28 + .25 * amount;
      ctx.fillStyle = ctx.createPattern(lines, "repeat");
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = .05 + .05 * Math.random();
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      return canvas;
    },
  };

  // ---------- Motions: draw the bitmap into item space (0..w, 0..h), alive over time ----------
  const moves = {
    // A flag pinned on its left edge: columns ride a travelling wave and are lit by its slope.
    silk({ ctx, src, bag, w, h, k, amount, now, touches }) {
      const lift = h * .09 * amount * k;
      const pad = lift + h * .12 * k;
      const { canvas, ctx: o } = buffer(bag, "move", src.width, src.height + pad * 2);
      const count = 64;
      const cw = src.width / count;
      const pokes = touches.filter(touch => touch.age < 1500);
      for (let i = 0; i < count; i++) {
        const u = i / count;
        const phase = u * 2.6 * Math.PI - now / 430;
        // A touch sets a local ripple running through the cloth, fading over 1.5 s.
        const poke = pokes.reduce((sum, touch) => sum + h * .12 * k * (1 - touch.age / 1500) *
          Math.exp(-(((u * w - touch.x) / (w * .12)) ** 2)) * Math.sin(touch.age / 70), 0);
        const dy = pad + lift * u * Math.sin(phase) + poke;
        o.globalCompositeOperation = "source-over";
        o.drawImage(src, i * cw, 0, cw + 1, src.height, i * cw, dy, cw + 1, src.height);
        o.globalCompositeOperation = "source-atop";
        const light = Math.cos(phase) * u * amount;
        o.fillStyle = light > 0 ? "rgb(255 255 255 / " + light * .22 + ")" : "rgb(0 0 0 / " + -light * .38 + ")";
        o.fillRect(i * cw, 0, cw + 1, canvas.height);
      }
      ctx.drawImage(canvas, 0, -pad / k, w, h + pad * 2 / k);
    },
    // Set in jelly on a plate: the base stays put, the top sways and the whole slab breathes.
    jelly({ ctx, src, w, h, amount, now, touches }) {
      const count = 40;
      const rh = src.height / count;
      // A touch flicks the slab away from the side it lands on; the flick rings down in about a second.
      const flick = touches.reduce((sum, touch) => sum + (touch.age < 1400 ? w * .09 * Math.exp(-touch.age / 380) * Math.sin(touch.age / 48) * Math.sign(w / 2 - touch.x) : 0), 0);
      const sway = w * .06 * amount * Math.sin(now / 260) * (.6 + .4 * Math.sin(now / 1900)) + flick;
      const squash = 1 + .05 * amount * Math.sin(now / 130);
      for (let i = 0; i < count; i++) {
        const v = 1 - i / count;
        const y = h - (h * v) * squash;
        ctx.drawImage(src, 0, i * rh, src.width, rh + 1, sway * v * v, y, w, h / count * squash + 1);
      }
    },
    // Chocolate melt: each column slides and stretches down by its own amount; the level breathes.
    melt({ ctx, src, bag, w, h, amount, now }) {
      const count = 56;
      // A gentle wave of sag plus a few long drips, softened across neighbouring columns.
      const drops = memo(bag, "drops", String(count), () => {
        const rand = random(bag.seed + "melt");
        const raw = Array.from({ length: count }, (_, i) => .35 + .3 * Math.sin(i * .29 + rand() * 6) + (rand() > .78 ? rand() * 1.1 : 0));
        return raw.map((value, i) => (raw[Math.max(0, i - 1)] + value * 2 + raw[Math.min(count - 1, i + 1)]) / 4);
      });
      const cw = src.width / count;
      const dw = w / count;
      const heat = amount * (.85 + .15 * Math.sin(now / 2300));
      const half = src.height / 2;
      for (let i = 0; i < count; i++) {
        const sag = h * heat * .55 * drops[i];
        ctx.drawImage(src, i * cw, 0, cw + .5, half, i * dw, 0, dw + .5, h / 2 + .5);
        ctx.drawImage(src, i * cw, half, cw + .5, half, i * dw, h / 2, dw + .5, h / 2 + sag);
      }
    },
    // A swinging lamp behind the layer: additive, scaled copies streak light away from it.
    rays({ ctx, src, bag, w, h, k, amount, now, touches }) {
      const soft = buffer(bag, "soft", src.width, src.height);
      soft.ctx.filter = "blur(" + 3 * k + "px)";
      soft.ctx.drawImage(tinted(bag, src, "#ffc27a"), 0, 0);
      const glow = soft.canvas;
      // The lamp swings by itself, or follows a finger or touch for 4 s.
      const last = touches.at(-1);
      const goal = last && last.age < 4000 ? [last.x, last.y] : [w * (.5 + .38 * Math.sin(now / 2100)), -h * .35];
      bag.lamp = bag.lamp ? bag.lamp.map((value, i) => value + (goal[i] - value) * .2) : goal;
      const [ox, oy] = bag.lamp;
      const base = ctx.globalAlpha;
      ctx.drawImage(src, 0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
      const count = 24;
      for (let i = 1; i <= count; i++) {
        const scale = 1 + i * .03 * (.4 + amount);
        ctx.globalAlpha = base * .13 * amount * (1 - i / (count + 1)) ** 1.4;
        ctx.drawImage(glow, ox - ox * scale, oy + (-oy) * scale, w * scale, h * scale);
      }
    },
    water: moveShader("water"),
    lens: moveShader("lens"),
    smudge: moveShader("smudge"),
  };

  // Grains for swarm and vortex: a grid of small tiles that each carry their own pixels.
  function grains(bag, w, h, kind) {
    const cell = Math.max(8, Math.sqrt(w * h / 1400));
    return memo(bag, "grains", [w, h, kind].join(), () => {
      const rand = random(bag.seed + kind);
      const list = [];
      for (let y = 0; y < h; y += cell) for (let x = 0; x < w; x += cell) {
        list.push({ x, y, s: cell, r: rand(), q: rand(), a: rand() * TAU });
      }
      return list;
    });
  }
  function drawGrain(ctx, src, k, grain, x, y, size, angle = 0) {
    if (size < .4) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.drawImage(src, grain.x * k, grain.y * k, grain.s * k, grain.s * k, -size / 2, -size / 2, size, size);
    ctx.restore();
  }

  // ---------- Exits: p = 0 intact .. 1 gone. Played forward to leave, backward to return ----------
  const exits = {
    // Glass: radial + ring cracks into shards that fly under gravity; returning shards seal with gold.
    shatter({ ctx, src, bag, w, h, k, p, seam, fx }) {
      const shards = memo(bag, "shards", [w, h, fx.ix, fx.iy].join(), () => {
        const rand = random(bag.seed + "glass");
        const cx = w * fx.ix;
        const cy = h * fx.iy;
        const spokes = 13;
        const reach = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy)) * 1.05;
        const rings = [0, .12, .28, .5, .75, 1].map(r => r * reach);
        const angles = Array.from({ length: spokes }, (_, i) => (i + rand() * .7) / spokes * TAU);
        const point = (ring, spoke) => {
          const wobble = ring && ring < rings.length - 1 ? .82 + rand() * .3 : 1;
          const angle = angles[spoke % spokes];
          return [cx + Math.cos(angle) * rings[ring] * wobble, cy + Math.sin(angle) * rings[ring] * wobble];
        };
        const grid = rings.map((_, ring) => angles.map((__, spoke) => point(ring, spoke)));
        const list = [];
        for (let ring = 0; ring < rings.length - 1; ring++) for (let spoke = 0; spoke < spokes; spoke++) {
          const next = (spoke + 1) % spokes;
          const poly = ring ? [grid[ring][spoke], grid[ring][next], grid[ring + 1][next], grid[ring + 1][spoke]]
            : [[cx, cy], grid[1][next], grid[1][spoke]];
          const mx = poly.reduce((sum, [x]) => sum + x, 0) / poly.length;
          const my = poly.reduce((sum, [, y]) => sum + y, 0) / poly.length;
          const away = Math.atan2(my - cy, mx - cx);
          const speed = (.15 + rand() * .35) * Math.max(w, h) * (1 - ring * .1);
          list.push({ poly, mx, my, vx: Math.cos(away) * speed, vy: Math.sin(away) * speed - h * .5 * rand(), spin: (rand() - .5) * 5 });
        }
        return list;
      });
      const tau = Math.max(0, p - .12) / .88 * 1.4;
      const fade = 1 - smooth(clamp((p - .8) / .2));
      const alpha = ctx.globalAlpha;
      for (const shard of shards) {
        ctx.save();
        ctx.globalAlpha = alpha * fade;
        ctx.translate(shard.mx + shard.vx * tau, shard.my + shard.vy * tau + h * 2.4 * tau * tau);
        ctx.rotate(shard.spin * tau);
        ctx.translate(-shard.mx, -shard.my);
        ctx.beginPath();
        shard.poly.forEach(([x, y]) => ctx.lineTo(x, y));
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(src, 0, 0, w, h);
        ctx.restore();
      }
      // Cracks (white, while breaking) and kintsugi seams (gold, after mending) only show on the layer itself.
      const crack = p > 0 && p < .12 ? Math.sin(p / .12 * Math.PI) : 0;
      if (!crack && !seam) return;
      const lines = buffer(bag, "seams", src.width, src.height);
      lines.ctx.scale(k, k);
      lines.ctx.beginPath();
      for (const shard of shards) {
        lines.ctx.moveTo(...shard.poly.at(-1));
        shard.poly.forEach(([x, y]) => lines.ctx.lineTo(x, y));
      }
      lines.ctx.strokeStyle = seam ? "#f0c45a" : "#ffffff";
      lines.ctx.lineWidth = seam ? 2.4 : 1.3;
      lines.ctx.stroke();
      lines.ctx.resetTransform();
      lines.ctx.globalCompositeOperation = "destination-in";
      lines.ctx.drawImage(src, 0, 0);
      ctx.globalAlpha = alpha * (seam || crack * .9);
      ctx.drawImage(lines.canvas, 0, 0, w, h);
    },
    // Murmuration: grains take off left to right, wheel as a flock and leave over the top-right.
    swarm({ ctx, src, bag, w, h, k, p, now }) {
      for (const grain of grains(bag, w, h, "swarm")) {
        const e = smooth(clamp((p - (grain.x / w * .7 + grain.q * .3) * .4) / .6));
        if (e <= 0) { ctx.drawImage(src, grain.x * k, grain.y * k, grain.s * k, grain.s * k, grain.x, grain.y, grain.s, grain.s); continue; }
        const lift = smooth(clamp(e / .55));
        const leave = smooth(clamp((e - .55) / .45));
        const fx = w * (.5 + 1.8 * leave) + Math.sin(now / 800) * w * .3 * lift;
        const fy = h * (.45 - .75 * lift - 2.4 * leave) + Math.cos(now / 560) * h * .14 * lift;
        const spread = Math.max(w, h) * (.08 + .18 * Math.sin(Math.PI * e)) * Math.sqrt(grain.r);
        const turn = grain.a + now / (600 + grain.q * 900);
        const tx = fx + Math.cos(turn) * spread * 1.6;
        const ty = fy + Math.sin(turn) * spread * .7;
        drawGrain(ctx, src, k, grain, grain.x + (tx - grain.x) * e, grain.y + (ty - grain.y) * e, grain.s * (1 - .55 * e), turn * e);
      }
    },
    // Burning paper: a noise front climbs from the bottom; a char band and ember glow ride the edge.
    burn({ ctx, src, bag, w, h, p }) {
      const cols = 96;
      const rows = Math.max(8, Math.round(cols * h / w));
      const noise = memo(bag, "noise", [cols, rows].join(), () => {
        const rand = random(bag.seed + "fire");
        const coarse = Array.from({ length: 12 * 12 }, () => rand());
        const at = (x, y) => coarse[(y % 12) * 12 + (x % 12)];
        return Float32Array.from({ length: cols * rows }, (_, i) => {
          const u = (i % cols) / cols * 7;
          const v = Math.floor(i / cols) / rows * 7;
          const [x, y] = [Math.floor(u), Math.floor(v)];
          const [fx, fy] = [smooth(u - x), smooth(v - y)];
          const value = (at(x, y) * (1 - fx) + at(x + 1, y) * fx) * (1 - fy) + (at(x, y + 1) * (1 - fx) + at(x + 1, y + 1) * fx) * fy;
          return value * .45 + (1 - Math.floor(i / cols) / rows) * .55;
        });
      });
      const front = 1.15 * p ** 1.3 - .1;
      const mask = buffer(bag, "mask", cols, rows);
      const ember = buffer(bag, "ember", cols, rows);
      const keep = mask.ctx.createImageData(cols, rows);
      const glow = ember.ctx.createImageData(cols, rows);
      for (let i = 0; i < noise.length; i++) {
        const d = noise[i] - front;
        keep.data[i * 4 + 3] = d > 0 ? 255 : 0;
        const edge = d > 0 && d < .09 ? 1 - d / .09 : 0;
        glow.data.set([255, 70 + 120 * edge, 20, edge * 255], i * 4);
      }
      mask.ctx.putImageData(keep, 0, 0);
      ember.ctx.putImageData(glow, 0, 0);
      const paper = buffer(bag, "move", src.width, src.height);
      paper.ctx.drawImage(src, 0, 0);
      paper.ctx.globalCompositeOperation = "destination-in";
      paper.ctx.drawImage(mask.canvas, 0, 0, src.width, src.height);
      paper.ctx.globalCompositeOperation = "source-atop";
      paper.ctx.filter = "blur(3px)";
      paper.ctx.drawImage(ember.canvas, 0, 0, src.width, src.height);
      ctx.drawImage(paper.canvas, 0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
      ctx.filter = "blur(" + Math.max(4, w / 60) + "px)";
      ctx.drawImage(ember.canvas, 0, 0, w, h);
    },
    // Black hole: grains spiral in, nearest first, while the hole opens and then closes.
    vortex({ ctx, src, bag, w, h, k, p }) {
      const cx = w * .5;
      const cy = h * .5;
      const reach = Math.hypot(cx, cy);
      for (const grain of grains(bag, w, h, "vortex")) {
        const dx = grain.x + grain.s / 2 - cx;
        const dy = grain.y + grain.s / 2 - cy;
        const r0 = Math.hypot(dx, dy);
        const e = smooth(clamp((p - (r0 / reach * .8 + grain.q * .2) * .45) / .55));
        if (e <= 0) { ctx.drawImage(src, grain.x * k, grain.y * k, grain.s * k, grain.s * k, grain.x, grain.y, grain.s, grain.s); continue; }
        const r = r0 * (1 - e) ** 1.4;
        const angle = Math.atan2(dy, dx) + e * 5 / (r / reach + .25);
        drawGrain(ctx, src, k, grain, cx + Math.cos(angle) * r, cy + Math.sin(angle) * r, grain.s * (1 - e * .9), angle);
      }
      const open = Math.sin(Math.PI * clamp(p * 1.1)) * Math.min(w, h) * .12;
      if (open < 1) return;
      const ring = ctx.createRadialGradient(cx, cy, open * .6, cx, cy, open * 2.2);
      ring.addColorStop(0, "#000000");
      ring.addColorStop(.32, "#000000");
      ring.addColorStop(.42, "rgb(255 214 150 / .95)");
      ring.addColorStop(.6, "rgb(255 120 60 / .35)");
      ring.addColorStop(1, "rgb(255 120 60 / 0)");
      ctx.fillStyle = ring;
      ctx.beginPath();
      ctx.arc(cx, cy, open * 2.2, 0, TAU);
      ctx.fill();
    },
  };

  // Buttons in Studio name what the exit does in each direction.
  const exitLabels = { shatter: ["Shatter", "Mend"], swarm: ["Fly away", "Land"], burn: ["Burn", "Unburn"], vortex: ["Swallow", "Release"] };

  // p: 0 intact .. 1 gone. seam: kintsugi glow that rises while returning, then fades.
  function exitState(fx, now = Date.now()) {
    if (fx.exit === "none" || !fx.at) return { p: 0, seam: 0 };
    const ms = exitMs[fx.exit];
    const elapsed = Math.max(0, now - fx.at);
    const t = smooth(clamp(elapsed / ms));
    if (fx.gone) return { p: t, seam: 0 };
    return { p: 1 - t, seam: fx.exit === "shatter" ? smooth(clamp(elapsed / ms)) ** 3 * clamp((ms + seamMs - elapsed) / seamMs) : 0 };
  }
  const active = item => !!item.fx && ((item.fx.fill ?? "own") !== "own" || item.fx.look !== "none" || item.fx.move !== "none" || item.fx.exit !== "none");
  /**
   * Effects draw outside the layer box (rays, shards, flocks), so the layer clip is baked into `flat`.
   * env (from the compositor): touches(item), camera(ctx, w, h), backdrop(ctx, item, k) and echo (last frame).
   */
  function draw(ctx, flat, item, now, bag, env) {
    const { fx, w, h, id } = item;
    bag.seed = id;
    const k = flat.width / w;
    const args = { ctx, bag, w, h, k, amount: fx.amount, now, fx, item, env, touches: env.touches(item) };
    const fill = (fx.fill ?? "own") === "own" ? flat : fills[fx.fill]({ ...args, src: flat });
    const src = fx.look === "none" ? fill : looks[fx.look]({ ...args, src: fill });
    const { p, seam } = exitState(fx);
    if (p >= 1) return;
    if (p > 0 || seam > 0) return exits[fx.exit]({ ...args, src, p, seam });
    if (fx.move !== "none") return moves[fx.move]({ ...args, src });
    ctx.drawImage(src, 0, 0, w, h);
  }

  Object.assign(lab, { fx: { draw, active, exitState, exitLabels, exitMs } });
})();
