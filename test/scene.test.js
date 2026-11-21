import test from "node:test";
import assert from "node:assert/strict";
import "../scene.js";
const { layer, normalize, ordered, toLocal, toWorld, stagePoint, fitRect, resize, callScene } = globalThis.Lightwell;

test("array order is paint order and hidden layers are skipped", () => {
  const [first, second, third] = ["text", "camera", "ink"].map(type => layer(type));
  second.visible = false;
  assert.deepEqual(ordered([third, second, first]), [third, first]);
});

test("opacity is clamped, IDs are unique, malformed scenes fail visibly", () => {
  const item = layer("camera", { opacity: 2 });
  const scene = normalize({ version: 1, layers: [item, { ...item, opacity: -1 }] });
  assert.deepEqual(scene.layers.map(item => item.opacity), [1, 0]);
  assert.notEqual(scene.layers[0].id, scene.layers[1].id);
  assert.throws(() => normalize({ version: 2, layers: [] }), /version/);
});

test("rotation, stage coordinates, fit, and anchored resize", () => {
  const item = layer("camera", { x: 100, y: 100, w: 80, h: 40, rotation: 90 });
  assert.deepEqual(toWorld(item, { x: 40, y: 0 }), { x: 160, y: 120 });
  const local = toLocal(item, toWorld(item, { x: 73, y: 19 }));
  assert.ok(Math.abs(local.x - 73) < 1e-8 && Math.abs(local.y - 19) < 1e-8);
  const next = { ...item, ...resize(item, "nw", { x: 20, y: -20 }) };
  const oldAnchor = toWorld(item, { x: item.w, y: item.h });
  const newAnchor = toWorld(next, { x: next.w, y: next.h });
  assert.ok(Math.hypot(oldAnchor.x - newAnchor.x, oldAnchor.y - newAnchor.y) < 1e-8);
  assert.deepEqual(stagePoint({ left: 30, top: 100, width: 640, height: 360 }, 350, 280), { x: 640, y: 360 });
  assert.deepEqual(fitRect(100, 50, 100, 100, "contain"), [0, 25, 100, 50]);
  assert.deepEqual(fitRect(100, 50, 100, 100, "cover"), [-50, 0, 200, 100]);
});

test("published scenes exclude session-only and private source bytes", () => {
  const scene = normalize({ version: 1, layers: [
    layer("image", { source: { url: "data:image/png;base64,AAAA" } }),
    layer("image", { source: { url: "https://example.com/private.png" } }),
    layer("display"),
    layer("html", { source: { markup: "<b>Published</b>" } }),
  ] });
  assert.deepEqual(callScene(scene).layers.map(item => item.source.url ?? ""), ["", "https://example.com/private.png", "", ""]);
});

test("OS blur checks real toggle capabilities and preserves source constraints", async () => {
  await import("../compositor.js");
  const { canToggleBlur, setOSBlur } = globalThis.Lightwell;
  assert.equal(canToggleBlur({ getCapabilities: () => ({ backgroundBlur: [false] }) }), false);
  let requested;
  const track = {
    getCapabilities: () => ({ backgroundBlur: [true, false] }),
    getConstraints: () => ({ width: { exact: 640 } }),
    applyConstraints: async value => { requested = value; },
    getSettings: () => ({ backgroundBlur: requested.backgroundBlur.exact }),
  };
  assert.equal(canToggleBlur(track), true);
  await setOSBlur(track, true);
  assert.deepEqual(requested, { width: { exact: 640 }, backgroundBlur: { exact: true } });
  await assert.rejects(() => setOSBlur({ getCapabilities: () => ({}) }, true), /cannot be toggled/);
});

test("legacy files migrate to Media and native ratio is locked by default", () => {
  const { layer, normalize, cropRect, resize } = globalThis.Lightwell;
  const scene = normalize({ version: 1, layers: [
    layer("image", { source: { url: "https://example.test/image.png" } }),
    layer("video", { source: { filename: "recording.webm" } }),
    layer("text", { source: { text: "# Title" } }),
  ] });
  assert.deepEqual(scene.layers.map(item => item.type), ["media", "media", "markdown"]);
  assert.deepEqual(scene.layers.slice(0, 2).map(item => item.source.kind), ["image", "video"]);
  assert.ok(scene.layers.every(item => item.lockAspect));
  assert.deepEqual(cropRect(800, 400, { left: 25, bottom: 50 }), [200, 0, 600, 200]);
  const resized = resize(scene.layers[0], "se", { x: 30, y: 1 }, 3);
  assert.equal(resized.w / resized.h, 3);
});

test("snap targets include stage edges, center, thirds, and visible layer edges", () => {
  const { W, H, layer, snapTargets, snapMove } = globalThis.Lightwell;
  const moving = layer("media", { x: 5, y: 144, w: 220, h: 100 });
  const other = layer("camera", { x: 300, y: 320, w: 200, h: 200 });
  const hidden = layer("camera", { x: 777, visible: false });
  const targets = snapTargets([moving, other, hidden], moving.id);
  assert.ok([0, W / 3, W / 2, W * 2 / 3, W, 300, 500].every(x => targets.x.includes(x)));
  assert.ok(!targets.x.includes(777));
  assert.deepEqual(snapMove(moving, targets, { x: 8, y: 8 }), { x: 0, y: 140, guides: { x: 0, y: H / 3 } });
  const right = { ...moving, x: W - moving.w - 4, y: 220 };
  assert.equal(snapMove(right, targets, { x: 8, y: 8 }).x + moving.w, W);
});

test("snapping a locked resize preserves the opposite corner and aspect ratio", () => {
  const { layer, snapResize, snapTargets, toWorld } = globalThis.Lightwell;
  const item = layer("camera", { x: 10, y: 10, w: 300, h: 150 });
  const result = snapResize(item, "se", { x: 114, y: 57 }, 2, snapTargets([item], item.id), { x: 8, y: 8 });
  const frame = { ...item, ...result };
  assert.ok(Math.abs(frame.x + frame.w - 1280 / 3) < .001);
  assert.equal(frame.w / frame.h, 2);
  assert.deepEqual(toWorld(frame, { x: 0, y: 0 }), toWorld(item, { x: 0, y: 0 }));
});

test("experimental effects normalize to known kinds and survive call publishing", () => {
  const { layer, normalize, callScene } = globalThis.Lightwell;
  const scene = normalize({ version: 1, layers: [
    layer("html", { fx: { look: "knit", move: "silk", exit: "lava", amount: 4, gone: true, at: -5 } }),
    layer("camera"),
  ] });
  assert.deepEqual(scene.layers[0].fx, { look: "knit", move: "silk", exit: "none", amount: 1, gone: true, at: 0 });
  assert.equal("fx" in scene.layers[1], false);
  assert.deepEqual(callScene(scene).layers[0].fx, scene.layers[0].fx);
});
