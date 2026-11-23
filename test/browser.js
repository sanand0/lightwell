// @ts-check
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { grantLocalhostFixture, openChrome } from "./chrome.js";
import { serve } from "../dev.js";
import "../scene.js";

const root = resolve(import.meta.dirname, "..");
const artifacts = process.env.LIGHTWELL_ARTIFACTS && resolve(process.env.LIGHTWELL_ARTIFACTS);
if (artifacts) await mkdir(artifacts, { recursive: true });
const fixture = await mkdtemp(join(tmpdir(), "lightwell-granted-"));
const fakeCamera = join(fixture, "striped-camera.y4m");
const stripeRow = Buffer.from(Array.from({ length: 640 }, (_, x) => x % 12 < 6 ? 72 : 150));
const yPlane = Buffer.alloc(640 * 360);
for (let y = 0; y < 360; y++) stripeRow.copy(yPlane, y * 640);
const uvPlanes = Buffer.alloc(640 * 360 / 2, 128);
// A stationary browser camera keeps decoded blur comparisons independent of frame timing.
await writeFile(fakeCamera, Buffer.concat([Buffer.from("YUV4MPEG2 W640 H360 F30:1 Ip A1:1 C420jpeg\nFRAME\n"), yPlane, uvPlanes]));
const instance = await openChrome(["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--use-file-for-fake-video-capture=" + fakeCamera]);
const { context, send } = instance;
const server = await serve(0);
const otherServer = await serve(0);
const origin = "http://localhost:" + server.address().port;
const otherOrigin = "http://localhost:" + otherServer.address().port;
const mock = origin + "/mock-call.html?csp";
let imageServer;
const stageURL = "/studio.html?synthetic#Glass%20Dashboard";
const canRead = page => page.waitForFunction(() => document.querySelector("#frame-info").textContent.includes("fps"), null, { timeout: 8000 });
const waitNative = page => page.waitForFunction(() => document.querySelector("#diagnostic-values").textContent.includes("native · 1 native layers"), null, { timeout: 8000 });
const readCanvas = (page, x, y) => page.locator("#stage").evaluate((canvas, { x, y }) =>
  [...canvas.getContext("2d").getImageData(x, y, 1, 1).data], { x, y });
const screenshot = async (page, name) => { if (artifacts) await page.screenshot({ path: join(artifacts, name) }); };
const verify = (label, data = "") => console.log("PASS", label, data);
const getUserMedia = page => page.waitForFunction(() => document.querySelector("video").videoWidth > 0, null, { timeout: 14000 });

async function download(page, control, filename) {
  const [response] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: control, exact: true }).click()]);
  const bytes = await readFile(await response.path());
  if (artifacts && filename) await response.saveAs(join(artifacts, filename));
  return bytes;
}
async function pixelFromPNG(page, png, x, y) {
  return await page.evaluate(async ({ b64, x, y }) => {
    const image = await createImageBitmap(await (await fetch("data:image/png;base64," + b64)).blob());
    const canvas = new OffscreenCanvas(1, 1);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, x, y, 1, 1, 0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data];
  }, { b64: png.toString("base64"), x, y });
}
async function hashRegion(page, name, [x, y, w, h]) {
  return await page.evaluate(({ name, x, y, w, h }) => {
    const source = document.querySelector(name);
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, x, y, w, h, 0, 0, w, h);
    let hash = 2166136261;
    for (const byte of ctx.getImageData(0, 0, w, h).data) hash = Math.imul(hash ^ byte, 16777619);
    return hash;
  }, { name, x, y, w, h });
}
async function blurSamples(page) {
  return page.locator("#stage").evaluate(canvas => {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const row = ctx.getImageData(75, 100, 370, 1).data;
    let edges = 0;
    for (let i = 4; i < row.length; i += 4) edges += Math.abs(row[i] - row[i - 4]);
    return { edges, face: ctx.getImageData(640, 385, 1, 1).data[0] };
  });
}
async function importScene(page, scene) {
  await page.locator("#json-file").setInputFiles({ name: "test-scene.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(scene)) });
  await page.waitForFunction(() => document.querySelector("#notice").textContent === "Loaded test-scene.json");
}
function watch(page) {
  page.on("pageerror", error => console.error("Page error", error));
  page.setViewportSize({ width: 1440, height: 1000 });
  return page;
}

try {
  const { id } = await send("Extensions.loadUnpacked", { path: root });
  const ext = "chrome-extension://" + id;
  const studio = watch(await context.newPage());
  await studio.goto(ext + stageURL);
  await canRead(studio);
  await waitNative(studio);
  await studio.getByText("Diagnostics", { exact: true }).click();
  await screenshot(studio, "studio.png");

  const png = await download(studio, "PNG", "glass-dashboard.png");
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1280, 720]);
  const card = await hashRegion(studio, "#stage", [799, 354, 245, 77]);
  await delay(500);
  assert.notEqual(card, await hashRegion(studio, "#stage", [799, 354, 245, 77]));
  await studio.locator("[data-tool=interact]").click();
  const freeze = studio.getByRole("button", { name: "Freeze signal", exact: true });
  await freeze.click();
  await studio.getByRole("button", { name: "Resume signal", exact: true }).waitFor({ timeout: 5000 });
  verify("Studio paints animated native HTML; native hit testing operates Freeze Signal");

  let rect = await studio.locator("#stage").boundingBox();
  const point = (x, y) => [rect.x + x * rect.width / 1280, rect.y + y * rect.height / 720];
  await studio.locator("[data-tool=select]").click();
  await studio.mouse.move(...point(450, 330));
  await studio.mouse.down();
  await studio.mouse.move(...point(485, 358), { steps: 7 });
  await studio.mouse.up();
  assert.equal(await studio.locator("[data-property=x]").inputValue(), "99");
  const handle = await studio.locator('[data-corner=se]').boundingBox();
  await studio.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await studio.mouse.down();
  await studio.mouse.move(handle.x + 45, handle.y + 30, { steps: 6 });
  await studio.mouse.up();
  assert.ok(Number(await studio.locator("[data-property=w]").inputValue()) > 830);
  await studio.locator("#transform-panel summary").click();
  await studio.locator("[data-property=clip]").selectOption("ellipse");
  await delay(140);
  const corner = await readCanvas(studio, 105, 140);
  const center = await readCanvas(studio, 521, 412);
  assert.ok(corner[0] < 90 && center[0] > 120, "ellipse clips camera corner, preserves center: " + JSON.stringify({corner, center}));
  verify("Direct drag, resize and camera clipping", { corner, center });

  await studio.locator("[data-tool=pen]").click();
  const beforeInk = await readCanvas(studio, 615, 65);
  await studio.mouse.move(...point(540, 65));
  await studio.mouse.down();
  await studio.mouse.move(...point(690, 65), { steps: 10 });
  await studio.mouse.up();
  await delay(100);
  const pen = await readCanvas(studio, 615, 65);
  assert.ok(pen[0] > 185 && pen[1] > 200 && pen[2] > 105);
  await studio.getByRole("button", { name: "Undo", exact: true }).click();
  await delay(100);
  assert.deepEqual(await readCanvas(studio, 615, 65), beforeInk);
  await delay(320);
  await studio.reload();
  await canRead(studio);
  assert.equal(await studio.locator("[data-property=x]").inputValue(), "99");
  assert.equal(await studio.locator("[data-property=clip]").inputValue(), "ellipse");
  verify("Scaled pointer mapping, drawing, undo and automatic scene restoration");

  const scene = {
    version: 1, name: "Pixel probe", layers: [
      { type: "solid", name: "Base", source: { color: "#112244" } },
      { type: "solid", name: "Fifty percent", x: 20, y: 20, w: 300, h: 300, opacity: .5, source: { color: "#ff0000" } },
      { type: "html", name: "Native magenta", x: 380, y: 20, w: 500, h: 400,
        source: { template: "custom", crop: 8, markup: '<section style="width:100%;height:100%;background:#d20166"></section>' } },
      { type: "camera", name: "Selected camera", x: 900, y: 80, w: 270, h: 250, clip: "ellipse" },
    ],
  };
  await importScene(studio, scene);
  await studio.waitForFunction(() => document.querySelector("#stage").getContext("2d").getImageData(500, 130, 1, 1).data[0] === 210);
  const fixturePNG = await download(studio, "PNG");
  assert.deepEqual(await pixelFromPNG(studio, fixturePNG, 500, 130), [210, 1, 102, 255]);
  const blend = await pixelFromPNG(studio, fixturePNG, 50, 50);
  assert.ok(Math.abs(blend[0] - 136) <= 1 && Math.abs(blend[1] - 17) <= 1 && Math.abs(blend[2] - 34) <= 1);
  const stageBoundary = await pixelFromPNG(studio, fixturePNG, 900, 80);
  assert.deepEqual(stageBoundary, [17, 34, 68, 255]);
  assert.match(await studio.locator("#selection-name").innerText(), /Selected camera/);
  const saved = JSON.parse((await download(studio, "Save JSON")).toString());
  assert.equal(saved.layers[1].opacity, .5);
  assert.equal(saved.layers[2].source.crop, 8);
  verify("PNG contains native HTML, measured opacity, and no director overlay", { blend, stageBoundary });

  await importScene(studio, Lightwell.preset("Portal"));
  await studio.locator("[data-tool=interact]").click();
  const closed = await hashRegion(studio, "#stage", [150, 180, 230, 140]);
  const recording = studio.waitForEvent("download");
  await studio.getByRole("button", { name: "Record", exact: true }).click();
  await delay(340);
  const open = studio.getByRole("button", { name: "Open portal", exact: true });
  await open.click();
  await delay(280);
  await screenshot(studio, "portal-midflight.png");
  await delay(550);
  assert.notEqual(await hashRegion(studio, "#stage", [150, 180, 230, 140]), closed);
  await screenshot(studio, "portal-open.png");
  await studio.getByRole("button", { name: "Close portal", exact: true }).click();
  await delay(500);
  await studio.getByRole("button", { name: "Stop recording", exact: true }).click();
  const webmDownload = await recording;
  const webm = await readFile(await webmDownload.path());
  assert.deepEqual([...webm.subarray(0, 4)], [26, 69, 223, 163]);
  assert.ok(webm.length > 12000);
  if (artifacts) await webmDownload.saveAs(join(artifacts, "portal-demo.webm"));
  verify("Dramatic HTML transition and WebM recording", webm.length + " bytes");

  await importScene(studio, Lightwell.preset("Talking Head"));
  await delay(140);
  const original = await blurSamples(studio);
  await studio.locator("[data-source-property=effect]").selectOption("blur");
  await studio.waitForFunction(() => document.querySelector("#diagnostic-values").textContent.includes("Synthetic reference mask"));
  const blurred = await blurSamples(studio);
  assert.ok(blurred.edges < original.edges * .43 && Math.abs(blurred.face - original.face) < 8, JSON.stringify({ original, blurred }));
  verify("Segmented blur suppresses backdrop edges while preserving the sharp synthetic subject", { original, blurred });

  await importScene(studio, Lightwell.preset("Presenter"));
  await studio.waitForFunction(() => document.querySelector("#diagnostic-values").textContent.includes("Synthetic reference mask"));
  await studio.getByRole("button", { name: "Compare", exact: true }).click();
  await studio.locator("#comparison").waitFor();
  assert.notDeepEqual(await readCanvas(studio, 875, 490), await studio.locator("#reference").evaluate(c => [...c.getContext("2d").getImageData(170, 80, 1, 1).data]));
  await screenshot(studio, "compare.png");
  // Choosing a webcam starts it.
  await studio.locator("#camera-device").selectOption("default");
  await studio.waitForFunction(() => document.querySelector("#diagnostic-values").textContent.includes("MediaPipe CPU ·"), null, { timeout: 16000 });
  const segStatus = await studio.locator("#diagnostic-values").evaluate(list => [...list.children].find(node => node.textContent === "Segmentation").nextElementSibling.textContent);
  assert.match(segStatus, /MediaPipe CPU · [0-9]+ × [0-9]+ · [0-9.]+ ms/);
  verify("Bundled MediaPipe model runs CPU inference on browser camera frames", segStatus.match(/MediaPipe CPU[^\n]+/)[0]);
  await studio.locator("[data-source-property=effect]").selectOption("os");
  await studio.waitForFunction(() => document.querySelector("#diagnostic-values").textContent.includes("OS blur unavailable"));
  await studio.getByRole("button", { name: "Stop camera", exact: true }).click();
  await studio.getByRole("button", { name: "Use in calls", exact: true }).click();
  await studio.getByText("Scene published to enabled origins.", { exact: true }).waitFor();
  assert.equal(await studio.evaluate(async () => (await chrome.storage.local.get("callScene")).callScene.name), "Presenter");

  const fallback = watch(await context.newPage());
  await fallback.goto(ext + "/studio.html?synthetic&no-html&seg-fail#Glass%20Dashboard");
  await canRead(fallback);
  await fallback.waitForFunction(() => document.querySelector("#diagnostic-values").textContent.includes("fallback · 0 native"));
  assert.deepEqual(await readCanvas(fallback, 830, 290), [38, 57, 85, 255]);
  await importScene(fallback, Lightwell.preset("Presenter"));
  await fallback.waitForFunction(() => document.querySelector("#diagnostic-values").textContent.includes("Forced segmentation failure; using original"));
  await importScene(fallback, { ...scene, layers: [scene.layers[3], { type: "video", name: "Local video", w: 700, h: 400 }] });
  const videoFile = fallback.locator("#source-fields input[type=file]");
  await fallback.locator("#layers button[data-layer-role=select]").filter({ hasText: "Local video" }).click();
  await videoFile.setInputFiles({ name: "portal-demo.webm", mimeType: "video/webm", buffer: webm });
  await fallback.waitForFunction(() => {
    const data = document.querySelector("#stage").getContext("2d").getImageData(5, 5, 1, 1).data;
    return data[0] !== 35;
  });
  await fallback.setViewportSize({ width: 390, height: 840 });
  assert.ok(await fallback.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth));
  await screenshot(fallback, "studio-narrow.png");
  verify("HTML and segmentation fallbacks, local WebM source, 390px layout");

  const denied = watch(await context.newPage());
  await denied.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => { throw new DOMException("Permission denied for test", "NotAllowedError"); } });
  });
  await denied.goto(origin + "/studio.html#Talking%20Head");
  await canRead(denied);
  await denied.locator("#camera-device").selectOption("default");
  await denied.getByRole("button", { name: "Start camera" }).click();
  await denied.getByText("Camera unavailable.", { exact: false }).waitFor();
  await denied.locator("#camera-device").selectOption("synthetic");
  await denied.waitForFunction(() => document.querySelector("#stage-state").textContent === "Synthetic camera");
  verify("Camera permission denial is visible and synthetic source still works");

  const raw = watch(await context.newPage());
  await raw.goto(mock);
  await raw.locator("#join").click();
  await getUserMedia(raw);
  assert.equal(await raw.evaluate(() => !!mockCall.stream.getVideoTracks()[0].canvas), false);
  await raw.close();
  verify("Actual unpacked manifest leaves camera requests alone by default");

  // The browser confirmation prompt is outside Playwright's page. Only the disposable copy
  // below has the localhost host grant preapproved, so the opt-in logic still starts off.
  await grantLocalhostFixture(root, fixture);
  const { id: fixtureId } = await send("Extensions.loadUnpacked", { path: fixture });
  const fixtureURL = "chrome-extension://" + fixtureId;
  const worker = context.serviceWorkers().find(worker => worker.url().startsWith(fixtureURL)) ||
    await context.waitForEvent("serviceworker", { predicate: worker => worker.url().startsWith(fixtureURL) });

  const caller = watch(await context.newPage());
  await caller.addInitScript(() => {
    window.rawTracks = [];
    window.requestAudio = [];
    window.lightwellStatus = "";
    addEventListener("message", event => {
      if (event.source === window && event.data?.from === "lightwell-page" && event.data?.status) window.lightwellStatus = event.data.status.label;
    });
    const remove = MediaStream.prototype.removeTrack;
    MediaStream.prototype.removeTrack = function (track) {
      if (track.kind === "video" && !track.canvas) {
        window.rawTracks.push(track);
        window.requestAudio.push(this.getAudioTracks()[0]);
      }
      return remove.call(this, track);
    };
  });
  await caller.goto(mock);
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, origin + "/mock-call.html*");
  const popup = await context.newPage();
  await popup.goto(fixtureURL + "/popup.html?tab=" + tabId);
  await popup.getByRole("button", { name: "Enable on this origin" }).click();
  await popup.getByText("Enabled. Reload the tab", { exact: false }).waitFor();
  await worker.evaluate(callScene => chrome.storage.local.set({ callScene }), Lightwell.preset("Glass Dashboard"));
  await caller.bringToFront();
  await caller.reload();
  const dock = caller.locator('[aria-label="Lightwell call controls"]');
  await dock.waitFor();
  const dragCDP = await context.newCDPSession(caller);
  const dockTree = await dragCDP.send("Accessibility.getFullAXTree");
  const moveButton = dockTree.nodes.find(node => node.role?.value === "button" && node.name?.value.includes("Lightwell camera"));
  assert.ok(moveButton);
  const { model: dragBox } = await dragCDP.send("DOM.getBoxModel", { backendNodeId: moveButton.backendDOMNodeId });
  const [xx, yy] = [(dragBox.content[0] + dragBox.content[4]) / 2, (dragBox.content[1] + dragBox.content[5]) / 2];
  const initialDock = await dock.boundingBox();
  await caller.mouse.move(xx, yy);
  await caller.mouse.down();
  await caller.mouse.move(xx + 192, yy - 150, { steps: 8 });
  await caller.mouse.up();
  await caller.keyboard.press("ArrowRight");
  const movedDock = await dock.boundingBox();
  assert.ok(Math.abs(movedDock.x - initialDock.x - 201) < 2 && Math.abs(movedDock.y - initialDock.y + 150) < 2, JSON.stringify({ initialDock, movedDock }));
  for (let attempt = 0; attempt < 15; attempt++) {
    if (await worker.evaluate(async key => (await chrome.storage.session.get(key))[key], "panelPosition:" + origin)) break;
    await delay(80);
  }
  await caller.reload();
  await dock.waitFor();
  const restoredDock = await dock.boundingBox();
  assert.ok(Math.abs(restoredDock.x - movedDock.x) < 2 && Math.abs(restoredDock.y - movedDock.y) < 2);
  verify("The call card moves by pointer and keyboard and remembers its position");
  await caller.locator("#audio").click();
  await caller.getByText("Audio-only call", { exact: false }).waitFor();
  assert.deepEqual(await caller.evaluate(() => [mockCall.stream.getVideoTracks().length, mockCall.stream.getAudioTracks().length]), [0, 1]);
  await caller.locator("#leave").click();
  await caller.locator("#join").click();
  await getUserMedia(caller);
  await caller.waitForFunction(() => mockCall.stream.getVideoTracks()[0]?.canvas?.children.length === 1);
  const trackInfo = await caller.evaluate(() => {
    const [out] = mockCall.stream.getVideoTracks();
    return { settings: out.getSettings(), label: out.label, outgoing: out.constructor.name,
      audio: mockCall.stream.getAudioTracks().map(track => [track.constructor.name, track.readyState, track === requestAudio[0]]),
      constraints: out.getConstraints(), raw: rawTracks[0].label, remote: mockCall.peers[1].getReceivers().map(item => item.track.kind).sort() };
  });
  assert.equal(trackInfo.outgoing, "CanvasCaptureMediaStreamTrack");
  assert.equal(trackInfo.label, trackInfo.raw);
  assert.deepEqual([trackInfo.settings.width, trackInfo.settings.height], [640, 360]);
  assert.deepEqual(trackInfo.constraints.width, { exact: 640 });
  assert.deepEqual(trackInfo.audio, [["MediaStreamTrack", "live", true]]);
  assert.deepEqual(trackInfo.remote, ["audio", "video"]);
  const remoteHash = await hashRegion(caller, "#remote-view", [395, 170, 190, 70]);
  await delay(500);
  assert.notEqual(await hashRegion(caller, "#remote-view", [395, 170, 190, 70]), remoteHash);
  const remotePixels = await caller.evaluate(() => {
    const video = document.querySelector("#remote-view");
    const canvas = new OffscreenCanvas(640, 360);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(video, 0, 0);
    return [...ctx.getImageData(400, 115, 1, 1).data];
  });
  assert.ok(remotePixels[1] < 90 && remotePixels[2] > 20, "decoded WebRTC pixels should show the HTML card");
  await screenshot(caller, "mock-call.png");
  verify("Document-start bridge delivers animated HTML to a decoded WebRTC peer with audio", { remotePixels, track: trackInfo.outgoing });

  const liveUpdate = await studio.evaluate(() => ({
    version: 1, name: "Published test",
    layers: [{ type: "solid", source: { color: "#334466" } },
      { type: "html", w: 340, h: 260, source: { template: "custom", markup: '<section style="width:100%;height:100%;background:#ed1e88"></section>' } },
      { type: "camera", x: 400, y: 150, w: 350, h: 300 }],
  }));
  await worker.evaluate(callScene => chrome.storage.local.set({ callScene }), liveUpdate);
  await caller.waitForFunction(() => {
    const video = document.querySelector("#remote-view");
    const c = new OffscreenCanvas(1, 1);
    const ctx = c.getContext("2d");
    ctx.drawImage(video, 5, 5, 1, 1, 0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return r > 210 && g < 60 && b > 100;
  });
  verify("Publishing custom HTML updates the active strict-CSP call without requesting the camera again");

  liveUpdate.layers[1].fx = { exit: "burn", gone: true, at: Date.now() - 10000 };
  await worker.evaluate(callScene => chrome.storage.local.set({ callScene }), liveUpdate);
  await caller.waitForFunction(() => {
    const video = document.querySelector("#remote-view");
    const c = new OffscreenCanvas(1, 1);
    const ctx = c.getContext("2d");
    ctx.drawImage(video, 5, 5, 1, 1, 0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return r < 90 && b > 80;
  });
  verify("A finished experimental exit hides the HTML layer in the decoded call");

  liveUpdate.layers[1].fx = { fill: "camera" };
  await worker.evaluate(callScene => chrome.storage.local.set({ callScene }), liveUpdate);
  await caller.waitForFunction(() => {
    const video = document.querySelector("#remote-view");
    const c = new OffscreenCanvas(1, 1);
    const ctx = c.getContext("2d");
    ctx.drawImage(video, 5, 5, 1, 1, 0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return Math.abs(r - g) < 30 && Math.abs(g - b) < 30 && r > 40;
  });
  verify("Camera fill paints the call's own camera inside an HTML layer in the decoded call");

  const primer = await context.newPage();
  await primer.goto(fixtureURL + "/studio.html?fresh");
  const digest = () => primer.evaluate(async () => (await chrome.storage.local.get("callScriptsDigest")).callScriptsDigest);
  for (let attempt = 0; attempt < 40 && !await digest(); attempt++) await delay(100);
  assert.ok(await digest());
  await primer.close();
  await appendFile(join(fixture, "effects.js"), "\nglobalThis.Lightwell.edited = true;\n");
  const callStudio = watch(await context.newPage());
  await callStudio.goto(fixtureURL + "/studio.html?fresh&synthetic#Talking%20Head");
  await callStudio.getByText("Updated Lightwell for call tabs. Reload open call tabs to use it.", { exact: true }).waitFor();
  const refreshed = await context.newPage();
  await refreshed.goto(mock);
  assert.equal(await refreshed.evaluate(() => globalThis.Lightwell.edited), true);
  await refreshed.close();
  verify("Studio refreshes cached call scripts after their files change");
  const urlImage = await callStudio.evaluate(async () => {
    const canvas = new OffscreenCanvas(8, 8);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fabe16";
    ctx.fillRect(0, 0, 8, 8);
    return [...new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer())];
  });
  imageServer = createServer((_, res) => {
    res.writeHead(200, { "Content-Type": "image/png", "Access-Control-Allow-Origin": "*" });
    res.end(Buffer.from(urlImage));
  });
  await new Promise(resolve => imageServer.listen(0, "localhost", resolve));
  const assetScene = {
    version: 1, name: "Published local sources",
    layers: [
      { type: "solid", source: { color: "#182548" } },
      { type: "camera", visible: false },
      { type: "image", name: "Transparent local PNG", x: 48, y: 80, w: 440, h: 460, fit: "stretch" },
      { type: "video", name: "Large local WebM", x: 535, y: 55, w: 700, h: 470, fit: "stretch" },
      { type: "image", name: "CORS URL image", x: 1000, y: 590, w: 200, h: 100, fit: "stretch", source: { url: "http://localhost:" + imageServer.address().port + "/yellow.png" } },
    ],
  };
  await importScene(callStudio, assetScene);
  const imageBytes = await callStudio.evaluate(async () => {
    const canvas = new OffscreenCanvas(88, 92);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ef1859";
    ctx.fillRect(0, 0, 44, 92);
    return [...new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer())];
  });
  await callStudio.locator("#layers button[data-layer-role=select]").filter({ hasText: "Transparent local PNG" }).click();
  await callStudio.locator("#source-fields input[type=file]").setInputFiles({ name: "transparent.png", mimeType: "image/png", buffer: Buffer.from(imageBytes) });
  await callStudio.getByText("transparent.png", { exact: true }).waitFor();
  await callStudio.locator("#layers button[data-layer-role=select]").filter({ hasText: "Large local WebM" }).click();
  // A valid EBML Void makes this file exceed the portable scene-JSON cutoff.
  const padding = Buffer.alloc(2_100_005);
  padding[0] = 0xec;
  padding.writeUInt32BE(0x10000000 + 2_100_000, 1);
  await callStudio.locator("#source-fields input[type=file]").setInputFiles({ name: "large-portal.webm", mimeType: "video/webm", buffer: Buffer.concat([webm, padding]) });
  await callStudio.getByText("large-portal.webm", { exact: true }).waitFor();
  await callStudio.getByRole("button", { name: "Use in calls", exact: true }).click();
  await callStudio.getByText("Scene published to enabled origins.", { exact: true }).waitFor();
  await callStudio.close();
  await caller.bringToFront();
  await caller.reload();
  await caller.locator("#join").click();
  await getUserMedia(caller);

  await caller.waitForFunction(() => {
    const video = document.querySelector("#remote-view");
    const canvas = new OffscreenCanvas(640, 360);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0);
    const read = (x, y) => [...ctx.getImageData(x, y, 1, 1).data];
    const [opaque, clear, movie, yellow] = [read(60, 200), read(205, 200), read(356, 35), read(550, 315)];
    return opaque[0] > 200 && opaque[1] < 60 && clear[0] < 45 && clear[2] > 55 && movie[2] > 17
      && yellow[0] > 180 && yellow[1] > 130 && yellow[2] < 80;
  }, null, { timeout: 15000 });
  const movieHash = await hashRegion(caller, "#remote-view", [310, 55, 155, 115]);
  await caller.waitForTimeout(950);
  assert.notEqual(await hashRegion(caller, "#remote-view", [310, 55, 155, 115]), movieHash);
  verify("Transparent PNG, >2 MB WebM and cross-origin image reach a newly joined strict-CSP call after Studio closes");

  const restoredStudio = watch(await context.newPage());
  await restoredStudio.goto(fixtureURL + "/studio.html");
  await restoredStudio.locator("#layers button[data-layer-role=select]").filter({ hasText: "Large local WebM" }).click();
  await restoredStudio.getByText("large-portal.webm", { exact: true }).waitFor();
  await restoredStudio.getByRole("button", { name: "Use in calls", exact: true }).click();
  await restoredStudio.getByText("Scene published to enabled origins.", { exact: true }).waitFor();
  assert.equal(await restoredStudio.evaluate(async () => (await chrome.storage.local.get("callMedia")).callMedia.assets.length), 3);
  await restoredStudio.close();

  await caller.bringToFront();
  const callCDP = await context.newCDPSession(caller);
  const { nodes } = await callCDP.send("Accessibility.getFullAXTree");
  const openStudio = nodes.find(node => node.role?.value === "button" && node.name?.value === "Open Studio");
  assert.ok(openStudio);
  assert.ok(!nodes.some(node => node.name?.value === "Stop outgoing video"));
  const { model } = await callCDP.send("DOM.getBoxModel", { backendNodeId: openStudio.backendDOMNodeId });
  const openingStudio = context.waitForEvent("page");
  await caller.mouse.click((model.content[0] + model.content[4]) / 2, (model.content[1] + model.content[5]) / 2);
  const liveStudio = watch(await openingStudio);
  await liveStudio.waitForURL(fixtureURL + "/studio.html");
  await liveStudio.getByRole("button", { name: "New", exact: true }).click();
  async function addLayer(label) {
    await liveStudio.locator("#add-layer").click();
    await liveStudio.locator("#layer-types").getByRole("button", { name: label, exact: true }).click();
  }
  await addLayer("Markdown");
  const markdown = liveStudio.locator('[data-source-property="text"]');
  await markdown.fill("");
  await liveStudio.getByRole("button", { name: "Live", exact: true }).click();
  await caller.waitForFunction(() => lightwellStatus.includes("Untitled scene"));
  await caller.waitForTimeout(240);
  const emptyText = await hashRegion(caller, "#remote-view", [40, 45, 370, 95]);
  await markdown.pressSequentially("# Live **typing**");
  assert.ok(await markdown.evaluate(input => document.activeElement === input));
  for (let i = 0; i < 30 && await hashRegion(caller, "#remote-view", [40, 45, 370, 95]) === emptyText; i++) await delay(90);
  assert.notEqual(await hashRegion(caller, "#remote-view", [40, 45, 370, 95]), emptyText);
  assert.ok(await markdown.evaluate(input => document.activeElement === input));

  const menuButton = liveStudio.getByRole("button", { name: "Options for Markdown", exact: true });
  await menuButton.click();
  const anchorBox = await menuButton.boundingBox();
  const menuBox = await liveStudio.locator(".layer-menu:popover-open").boundingBox();
  const verticalGap = Math.max(menuBox.y - anchorBox.y - anchorBox.height, anchorBox.y - menuBox.y - menuBox.height, 0);
  assert.ok(verticalGap < 16 && menuBox.x + menuBox.width >= anchorBox.x - 18 && menuBox.x <= anchorBox.x + anchorBox.width + 18,
    JSON.stringify({ anchorBox, menuBox }));
  await liveStudio.getByRole("button", { name: "Duplicate", exact: true }).click();
  await liveStudio.getByRole("button", { name: "Select Markdown", exact: true }).click();
  let liveRect = await liveStudio.locator("#stage").boundingBox();
  const screen = (x, y) => [liveRect.x + liveRect.width * x / 1280, liveRect.y + liveRect.height * y / 720];
  await liveStudio.mouse.click(...screen(325, 180));
  assert.equal(await liveStudio.locator("#selection-name").innerText(), "Markdown copy");
  const sourceRow = liveStudio.getByRole("button", { name: "Reorder Markdown copy (Alt+Up or Alt+Down)", exact: true });
  const targetRow = liveStudio.getByRole("button", { name: "Select Markdown", exact: true }).locator("..");
  await sourceRow.dragTo(targetRow, { targetPosition: { x: 50, y: 30 } });
  const order = await liveStudio.locator('[data-layer-role="select"]').evaluateAll(elements => elements.map(el => el.getAttribute("aria-label")));
  assert.deepEqual(order, ["Select Markdown", "Select Markdown copy"]);
  await liveStudio.getByRole("button", { name: "Delete Markdown copy", exact: true }).click();

  await liveStudio.getByRole("button", { name: "Select Markdown", exact: true }).click();
  await liveStudio.mouse.move(...screen(260, 177));
  await liveStudio.mouse.down();
  await liveStudio.mouse.move(...screen(174, 94), { steps: 10 });
  assert.ok(await liveStudio.locator(".snap-x").isVisible());
  assert.ok(await liveStudio.locator(".snap-y").isVisible());
  await liveStudio.mouse.up();
  assert.equal(await liveStudio.locator("#selection").evaluate(el => el.style.left), "0%");
  assert.equal(await liveStudio.locator("#selection").evaluate(el => el.style.top), "0%");
  assert.ok(await liveStudio.locator(".snap-x").isHidden());
  verify("Layer menu opens by its button and viewport snapping draws guides");

  const needInk = lit => caller.waitForFunction(lit => {
    const video = document.querySelector("#remote-view");
    if (!video.videoWidth) return false;
    const ctx = new OffscreenCanvas(1, 1).getContext("2d");
    ctx.drawImage(video, 307, 250, 1, 1, 0, 0, 1, 1);
    const [r, g] = ctx.getImageData(0, 0, 1, 1).data;
    return (r > 180 && g > 195) === lit;
  }, lit, { timeout: 8000 });
  await liveStudio.getByRole("button", { name: "Pen", exact: true }).click();
  await liveStudio.mouse.move(...screen(510, 500));
  await liveStudio.mouse.down();
  await liveStudio.mouse.move(...screen(730, 500), { steps: 14 });
  await needInk(true);
  await liveStudio.mouse.up();
  await liveStudio.getByRole("button", { name: "Clear", exact: true }).click();
  await needInk(false);
  await liveStudio.getByRole("button", { name: "Undo", exact: true }).click();
  await needInk(true);

  await liveStudio.getByRole("button", { name: "Save", exact: true }).click();
  await liveStudio.getByLabel("Scene name").fill("Live captions");
  await liveStudio.getByRole("button", { name: "Save scene", exact: true }).click();
  await liveStudio.getByText("Saved Live captions", { exact: true }).waitFor();
  await liveStudio.getByRole("button", { name: "New", exact: true }).click();
  assert.equal(await liveStudio.locator(".layer-row").count(), 0);
  await liveStudio.getByLabel("Load saved scene").selectOption({ label: "Live captions" });
  assert.equal(await liveStudio.locator(".layer-row").count(), 2);
  await needInk(true);
  await liveStudio.getByRole("button", { name: "Live", exact: true }).click();
  await liveStudio.getByRole("button", { name: "Clear", exact: true }).click();
  await needInk(true);
  await liveStudio.getByRole("button", { name: "New", exact: true }).click();
  await addLayer("Live HTML / SVG");
  await liveStudio.locator("#source-fields input[type=file]").setInputFiles({
    name: "panels.html", mimeType: "text/html",
    buffer: Buffer.from('<section style="width:100%;height:100%;display:grid;grid-template-columns:1fr 1fr"><div style="background:#e81660"></div><div style="background:#26e987"></div></section>'),
  });
  await liveStudio.getByText("panels.html", { exact: true }).waitFor();
  await liveStudio.waitForFunction(() => document.querySelector("#stage").getContext("2d").getImageData(850, 245, 1, 1).data[0] > 190);
  await liveStudio.locator("#crop-panel summary").click();
  await liveStudio.locator('[data-crop="left"]').evaluate(input => { input.value = "50"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  await liveStudio.waitForFunction(() => document.querySelector("#stage").getContext("2d").getImageData(850, 245, 1, 1).data[1] > 190);
  verify("HTML file source and inspector crop change stage pixels");

  const plain = await hashRegion(liveStudio, "#stage", [770, 120, 400, 280]);
  await liveStudio.locator("#fx-panel summary").click();
  await liveStudio.locator('[data-fx="look"]').selectOption("knit");
  await liveStudio.waitForFunction(() => document.querySelector("#fx-panel summary").textContent === "Experiments ✦");
  await delay(200);
  assert.notEqual(await hashRegion(liveStudio, "#stage", [770, 120, 400, 280]), plain);
  await liveStudio.locator('[data-fx="look"]').selectOption("none");
  await liveStudio.locator('[data-fx="exit"]').selectOption("burn");
  await liveStudio.getByRole("button", { name: "Burn · X", exact: true }).click();
  await liveStudio.waitForFunction(() => document.querySelector("#stage").getContext("2d").getImageData(850, 245, 1, 1).data[1] < 120, null, { timeout: 6000 });
  await liveStudio.getByRole("button", { name: "Unburn · X", exact: true }).waitFor();
  await liveStudio.locator("#director").press("x");
  await liveStudio.waitForFunction(() => document.querySelector("#stage").getContext("2d").getImageData(850, 245, 1, 1).data[1] > 190, null, { timeout: 6000 });
  await screenshot(liveStudio, "experiments.png");
  verify("Experiments change the look, play an exit and bring the layer back with X");

  // Fake hands stand in for MediaPipe; the camera fills the stage, so hand fractions map straight to stage units.
  const play = watch(await context.newPage());
  await play.goto(origin + "/studio.html?fresh&fake-hands");
  await canRead(play);
  const fakeHand = (u, v, gesture = "None", pinch = false) => {
    const points = Array.from({ length: 21 }, () => [u, v]);
    points[0] = [u, v + .2]; points[9] = [u, v]; points[8] = [u, v - .05]; points[4] = pinch ? [u + .005, v - .05] : [u - .1, v];
    return [{ points, gesture, score: .9 }];
  };
  const magenta = (x, y) => play.evaluate(([x, y]) => {
    const [r, g, b] = document.querySelector("#stage").getContext("2d").getImageData(x, y, 1, 1).data;
    return r > 200 && g < 60 && b > 200;
  }, [x, y]);
  await importScene(play, { version: 1, name: "Hands", hands: true, layers: [
    { type: "camera", name: "Camera", source: { device: "synthetic" } },
    { type: "html", name: "Stamp", x: 820, y: 280, w: 300, h: 160, fx: { exit: "burn" },
      source: { template: "custom", markup: '<section style="width:100%;height:100%;background:#ff00ff"></section>' } },
  ] });
  await play.waitForFunction(() => document.querySelector("#stage").getContext("2d").getImageData(970, 360, 1, 1).data[1] < 60);
  await play.evaluate(hand => { globalThis.lightwellFakeHands = hand; }, fakeHand(970 / 1280, 380 / 720, "None", true));
  await delay(300);
  await play.evaluate(hand => { globalThis.lightwellFakeHands = hand; }, fakeHand(390 / 1280, 380 / 720, "None", true));
  await play.waitForFunction(() => document.querySelector("#stage").getContext("2d").getImageData(380, 360, 1, 1).data[1] < 60, null, { timeout: 4000 });
  assert.equal(await magenta(1050, 360), false);
  await play.evaluate(hand => { globalThis.lightwellFakeHands = hand; }, fakeHand(390 / 1280, 380 / 720, "Closed_Fist"));
  await play.waitForFunction(() => document.querySelector("#stage").getContext("2d").getImageData(380, 360, 1, 1).data[1] > 60, null, { timeout: 6000 });
  assert.match(await play.locator("#diagnostic-values").textContent(), /HandsFake hands/);
  verify("Hand gestures pinch-drag a layer and a fist burns it away");

  await importScene(play, { version: 1, name: "Touch", layers: [
    { type: "markdown", name: "Pond", x: 0, y: 0, w: 1280, h: 720, fx: { move: "water", amount: .8 }, source: { text: "# Ripple ripple ripple\nripple ripple", size: 90, color: "#ffffff" } },
  ] });
  await delay(400);
  const still = await hashRegion(play, "#stage", [100, 100, 900, 400]);
  await delay(300);
  assert.equal(await hashRegion(play, "#stage", [100, 100, 900, 400]), still, "calm water is still");
  await play.keyboard.press("t");
  const box = await play.locator("#stage").boundingBox();
  await play.mouse.move(box.x + box.width * .3, box.y + box.height * .3);
  await play.mouse.down();
  await play.mouse.move(box.x + box.width * .6, box.y + box.height * .5, { steps: 8 });
  await play.mouse.up();
  await delay(150);
  assert.notEqual(await hashRegion(play, "#stage", [100, 100, 900, 400]), still);
  await delay(4500);
  const calm = await hashRegion(play, "#stage", [100, 100, 900, 400]);
  await play.getByRole("button", { name: "Select Pond", exact: true }).click();
  await play.locator('#source-fields textarea').press("End");
  await play.locator('#source-fields textarea').type("!", { delay: 30 });
  await delay(200);
  assert.notEqual(await hashRegion(play, "#stage", [100, 100, 900, 400]), calm);
  await screenshot(play, "touch-water.png");
  await play.close();
  verify("Touch tool drags and typing ripple a WebGL water layer");

  await liveStudio.getByRole("button", { name: "New", exact: true }).click();
  async function startLayerCamera(x, brightness) {
    if (!await liveStudio.locator("#transform-panel").evaluate(details => details.open)) await liveStudio.locator("#transform-panel summary").click();
    await liveStudio.locator('[data-property="x"]').fill(String(x));
    await liveStudio.locator('[data-property="y"]').fill("100");
    // "Default webcam" previews in Studio only; a specific webcam runs in the background and feeds calls.
    const picker = liveStudio.locator("#camera-device");
    await liveStudio.waitForFunction(() => document.querySelector("#camera-device").options.length > 2);
    await picker.selectOption(await picker.locator("option").nth(2).getAttribute("value"));
    await liveStudio.getByRole("button", { name: "Stop camera", exact: true }).waitFor();
    await liveStudio.locator('[data-source-property="brightness"]').evaluate((input, value) => {
      input.value = value; input.dispatchEvent(new Event("input", { bubbles: true }));
    }, String(brightness));
  }
  await addLayer("Camera");
  await startLayerCamera(90, 0);
  await addLayer("Camera");
  await startLayerCamera(660, 170);
  const getCaptures = page => page.evaluate(async () => (await chrome.runtime.sendMessage({ target: "lightwell-capture", action: "list" })).captures);
  assert.equal((await getCaptures(liveStudio)).filter(entry => entry.kind === "camera").length, 2);
  await liveStudio.getByRole("button", { name: "Live", exact: true }).click();
  await caller.waitForFunction(() => {
    const video = document.querySelector("#remote-view");
    const ctx = new OffscreenCanvas(2, 1).getContext("2d");
    ctx.drawImage(video, 145, 98, 1, 1, 0, 0, 1, 1);
    ctx.drawImage(video, 420, 98, 1, 1, 1, 0, 1, 1);
    const pixels = ctx.getImageData(0, 0, 2, 1).data;
    return pixels[0] < 20 && pixels[4] > 115;
  }, null, { timeout: 12000 });
  await liveStudio.close();
  const resumed = watch(await context.newPage());
  await resumed.goto(fixtureURL + "/studio.html");
  await resumed.waitForFunction(() => document.querySelector("#live-mode").getAttribute("aria-pressed") === "true");
  assert.equal((await getCaptures(resumed)).filter(entry => entry.kind === "camera").length, 2);
  await resumed.getByRole("button", { name: "Select Camera", exact: true }).click();
  await resumed.getByRole("button", { name: "Stop camera", exact: true }).click();
  for (let count = 0; count < 20 && (await getCaptures(resumed)).length > 1; count++) await delay(80);
  assert.equal((await getCaptures(resumed)).filter(entry => entry.kind === "camera").length, 1);
  await resumed.getByRole("button", { name: "Stop captures", exact: true }).click();
  await resumed.getByText("Background captures stopped.", { exact: true }).waitFor();
  assert.equal((await getCaptures(resumed)).length, 0);
  await resumed.close();
  verify("Independent Studio camera tracks, settings, live output, and stop controls");

  const first = watch(await context.newPage());
  await first.goto(fixtureURL + "/studio.html?fresh");
  await first.getByRole("button", { name: "Stop camera", exact: true }).waitFor();
  assert.equal(await first.locator("#camera-device").inputValue(), "default");
  await first.waitForFunction(() => document.querySelector("#stage-state").textContent !== "Synthetic camera" && document.querySelector("#frame-info").textContent.includes("fps"));
  assert.equal((await getCaptures(first)).length, 0);
  await first.getByRole("button", { name: "New", exact: true }).click();
  await first.locator("#add-layer").click();
  await first.locator("#layer-types").getByRole("button", { name: "Media", exact: true }).click();
  await first.locator("#source-fields input[type=file]").setInputFiles({ name: "draft-large.webm", mimeType: "video/webm", buffer: Buffer.concat([webm, padding]) });
  await first.getByText("draft-large.webm", { exact: true }).waitFor();
  await delay(600);
  await first.goto(fixtureURL + "/studio.html");
  await first.locator("#layers button[data-layer-role=select]").filter({ hasText: "Media" }).click();
  await first.getByText("draft-large.webm", { exact: true }).waitFor();
  assert.equal(await first.evaluate(async () => {
    const db = await new Promise(resolve => { const r = indexedDB.open("lightwell-call-assets"); r.onsuccess = () => resolve(r.result); });
    const files = await new Promise(resolve => { const r = db.transaction("publications").objectStore("publications").get("studio-draft"); r.onsuccess = () => resolve(r.result); });
    return [...files.values()][0]?.name;
  }), "draft-large.webm");
  await first.getByRole("button", { name: "Use in calls", exact: true }).click();
  await first.getByText("Scene published to enabled origins.", { exact: true }).waitFor();
  await first.close();
  verify("Default scene starts the real webcam as a Studio-only preview and unsaved large files survive a reload");

  verify("Open Studio, live typing and in-progress pen pixels, clear undo, stacking, scene save/load and paused Live");

  const effectsStudio = watch(await context.newPage());
  await effectsStudio.goto(fixtureURL + "/studio.html?fresh&synthetic#Talking%20Head");
  await effectsStudio.locator("[data-source-property=effect]").selectOption("blur");
  await effectsStudio.getByRole("button", { name: "Use in calls", exact: true }).click();
  await effectsStudio.getByText("Scene published to enabled origins.", { exact: true }).waitFor();
  await caller.bringToFront();
  await caller.waitForFunction(() => lightwellStatus.includes("MediaPipe CPU ·"), null, { timeout: 20000 });
  const edgeStats = await caller.evaluate(async () => {
    const video = document.querySelector("#remote-view");
    const raw = document.createElement("video");
    raw.muted = true;
    raw.srcObject = new MediaStream([rawTracks[0]]);
    await raw.play();
    const sample = new OffscreenCanvas(640, 360);
    const ctx = sample.getContext("2d", { willReadFrequently: true });
    function edgeEnergy(input) {
      ctx.drawImage(input, 0, 0, 640, 360);
      const data = ctx.getImageData(50, 75, 540, 210).data;
      let energy = 0;
      for (let y = 1; y < 210; y++) for (let x = 1; x < 540; x++) {
        const offset = 4 * (y * 540 + x) + 1;
        energy += Math.abs(data[offset] - data[offset - 4]) + Math.abs(data[offset] - data[offset - 2160]);
      }
      return energy;
    }
    const samples = [];
    for (let i = 0; i < 6; i++) {
      await new Promise(resolve => setTimeout(resolve, 120));
      samples.push({ original: edgeEnergy(raw), decoded: edgeEnergy(video) });
    }
    raw.srcObject = null;
    return samples.sort((a, b) => a.decoded / a.original - b.decoded / b.original)[3];
  });
  assert.ok(edgeStats.original > 100_000 && edgeStats.decoded < edgeStats.original * .48, JSON.stringify(edgeStats));
  verify("Offscreen MediaPipe mask changes decoded outgoing blur pixels", edgeStats);

  await effectsStudio.locator("[data-source-property=effect]").selectOption("os");
  await effectsStudio.getByRole("button", { name: "Use in calls", exact: true }).click();
  await effectsStudio.getByText("Scene published to enabled origins.", { exact: true }).waitFor();
  await caller.bringToFront();
  await caller.waitForFunction(() => lightwellStatus.includes("OS blur unavailable · segmented fallback") && lightwellStatus.includes("MediaPipe CPU ·"), null, { timeout: 16000 });
  const os = watch(await context.newPage());
  await os.addInitScript(() => {
    const proto = MediaStreamTrack.prototype;
    const capabilities = proto.getCapabilities;
    const settings = proto.getSettings;
    const constraints = proto.getConstraints;
    const apply = proto.applyConstraints;
    const values = new WeakMap();
    proto.getCapabilities = function () { return { ...capabilities.call(this), backgroundBlur: [true, false] }; };
    proto.getSettings = function () { return { ...settings.call(this), backgroundBlur: values.get(this)?.exact ?? false }; };
    proto.getConstraints = function () { return { ...constraints.call(this), ...(values.has(this) && { backgroundBlur: values.get(this) }) }; };
    proto.applyConstraints = async function ({ backgroundBlur, ...rest } = {}) {
      await apply.call(this, rest);
      if (backgroundBlur) values.set(this, backgroundBlur);
    };
  });
  await os.goto(mock);
  await os.locator("#join").click();
  await getUserMedia(os);
  await os.waitForFunction(() => mockCall.stream.getVideoTracks()[0].getSettings().backgroundBlur === true);
  assert.deepEqual(await os.evaluate(() => mockCall.stream.getVideoTracks()[0].getConstraints().width), { exact: 640 });
  await effectsStudio.locator("[data-source-property=effect]").selectOption("original");
  await effectsStudio.getByRole("button", { name: "Use in calls", exact: true }).click();
  await os.waitForFunction(() => mockCall.stream.getVideoTracks()[0].getSettings().backgroundBlur === false);
  await os.close();
  await effectsStudio.close();
  verify("OS blur uses segmented fallback on the fake camera and applies/restores a simulated native capability");

  const lifecycle = await caller.evaluate(async () => {
    const out = mockCall.stream.getVideoTracks()[0];
    const raw = rawTracks[0];
    const clone = out.clone();
    const nextStream = await mockCall.requestCamera({ video: { width: { exact: 320 }, height: { exact: 240 } } });
    const next = nextStream.getVideoTracks()[0];
    out.stop();
    const afterFirst = [raw.readyState, clone.readyState, rawTracks[1].readyState];
    clone.stop();
    const afterClone = [raw.readyState, rawTracks[1].readyState];
    let constraintError;
    try { await next.applyConstraints({ width: { exact: 20_000 } }); } catch (error) { constraintError = error.name; }
    const audio = mockCall.stream.getAudioTracks()[0].readyState;
    window.lightwellNext = next;
    return { afterFirst, afterClone, constraintError, audio };
  });
  assert.deepEqual(lifecycle.afterFirst, ["live", "live", "live"]);
  assert.deepEqual(lifecycle.afterClone, ["ended", "live"]);
  assert.equal(lifecycle.constraintError, "OverconstrainedError");
  assert.equal(lifecycle.audio, "live");

  const other = await context.newPage();
  await other.goto(otherOrigin + "/mock-call.html");
  assert.equal(await other.evaluate(async () => {
    const stream = await mockCall.requestCamera({ video: true });
    const track = stream.getVideoTracks()[0];
    track.stop();
    return !!track.canvas;
  }), false);
  await other.close();
  verify("Clones retain their own camera lifetime, concurrent calls are independent, and another localhost port stays off");

  const failed = await context.newPage();
  await failed.addInitScript(() => { HTMLCanvasElement.prototype.captureStream = undefined; });
  await failed.goto(mock);
  await failed.locator("#join").click();
  await getUserMedia(failed);
  assert.deepEqual(await failed.evaluate(() => [!!mockCall.stream.getVideoTracks()[0].canvas, mockCall.stream.getAudioTracks()[0].readyState]), [false, "live"]);
  await failed.close();
  verify("Failed compositor falls back to the unchanged camera and microphone");

  await caller.evaluate(() => {
    window.lightwellNext.addEventListener("ended", () => { window.bridgeEnded = true; });
  });
  await popup.reload();
  await popup.getByRole("button", { name: "Disable on this origin" }).click();
  await caller.waitForFunction(() => window.bridgeEnded && rawTracks[1].readyState === "ended");
  assert.equal(await caller.evaluate(() => mockCall.stream.getAudioTracks()[0].readyState), "live");
  const registered = await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  assert.equal(registered.length, 0);
  await caller.locator("#leave").click();
  verify("Disable unregisters injection, ends outgoing tracks, releases raw camera and leaves caller audio alone");

  await popup.getByRole("button", { name: "Enable on this origin" }).click();
  await popup.getByText("Enabled. Reload the tab", { exact: false }).waitFor();
  await caller.reload();
  await caller.evaluate(async () => {
    window.closeProbe = await mockCall.requestCamera({ video: true });
    const source = rawTracks[0];
    addEventListener("pagehide", () => {
      const states = [source.readyState, closeProbe.getVideoTracks()[0].readyState];
      navigator.sendBeacon("/closed-probe", JSON.stringify(states));
    });
  });
  const closedProbe = new Promise(resolve => server.on("request", request => {
    if (request.url !== "/closed-probe") return;
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => resolve(JSON.parse(body)));
  }));
  await caller.close();
  assert.deepEqual(await Promise.race([closedProbe, delay(4500).then(() => null)]), ["ended", "ended"]);
  verify("Closing a calling tab stops the source and the captured track");
} finally {
  server.close();
  otherServer.close();
  imageServer?.close();
  await instance.close();
  await rm(fixture, { recursive: true, force: true, maxRetries: 4 });
}
