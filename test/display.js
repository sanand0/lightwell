// @ts-check
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { grantLocalhostFixture, openChrome } from "./chrome.js";
import { serve } from "../dev.js";

const fixture = await mkdtemp(join(tmpdir(), "lightwell-display-"));
const fixtureTitle = "Lightwell tab capture fixture";
const browser = await openChrome(["--use-fake-device-for-media-stream", "--auto-select-tab-capture-source-by-title=" + fixtureTitle]);
const server = await serve(0);
const origin = "http://localhost:" + server.address().port;

function waitForRemoteColor(page, color) {
  return page.waitForFunction(color => {
    const video = document.querySelector("#remote-view");
    if (!video.videoWidth) return false;
    const ctx = new OffscreenCanvas(1, 1).getContext("2d");
    ctx.drawImage(video, 250, 170, 1, 1, 0, 0, 1, 1);
    const pixel = [...ctx.getImageData(0, 0, 1, 1).data];
    const [r, g, b] = pixel;
    if (color === "magenta") return r > 190 && g < 85 && b > 100 ? pixel : false;
    if (color === "teal") return r < 80 && g > 130 && b > 100 ? pixel : false;
    return !(r < 80 && g > 130 && b > 100) ? pixel : false;
  }, color, { timeout: 16000 });
}

try {
  await grantLocalhostFixture(resolve(import.meta.dirname, ".."), fixture);
  const { id } = await browser.send("Extensions.loadUnpacked", { path: fixture });
  await browser.context.grantPermissions(["camera", "microphone"], { origin });
  const target = await browser.context.newPage();
  await target.goto(origin + "/mock-call.html");
  await target.evaluate(title => {
    document.title = title;
    document.body.replaceChildren();
    document.documentElement.style.background = "#e31881";
  }, fixtureTitle);
  const studio = await browser.context.newPage();
  await studio.goto("chrome-extension://" + id + "/studio.html#Talking%20Head");
  await studio.bringToFront();
  await studio.locator("#add-layer").click();
  await studio.getByRole("button", { name: "Display capture", exact: true }).click();
  const studioTab = await studio.evaluate(() => chrome.tabs.getCurrent());
  await studio.getByRole("button", { name: "Choose display", exact: true }).click();
  await studio.waitForFunction(() => {
    const [r, g, b] = document.querySelector("#stage").getContext("2d").getImageData(300, 300, 1, 1).data;
    return r > 200 && g < 75 && b > 100;
  }, null, { timeout: 12_000 });
  const result = await studio.evaluate(async tab => ({
    active: (await chrome.tabs.get(tab)).active,
    captures: (await chrome.runtime.sendMessage({ target: "lightwell-capture", action: "list" })).captures,
  }), studioTab.id);
  assert.ok(result.active, "the screen picker should not switch away from Studio");
  assert.equal(result.captures[0].settings.displaySurface, "browser");
  assert.equal((await studio.evaluate(origin => chrome.runtime.sendMessage({ type: "enable", origin }), origin)).enabled, true);
  await studio.getByRole("button", { name: "Live", exact: true }).click();
  await studio.waitForFunction(async () => (await chrome.storage.local.get("callMedia")).callMedia?.display.length === 1);
  const caller = await browser.context.newPage();
  await caller.goto(origin + "/mock-call.html?csp");
  await caller.locator("#join").click();
  const magenta = await waitForRemoteColor(caller, "magenta");
  await studio.close();
  await target.evaluate(() => { document.documentElement.style.background = "#16bbad"; });
  const teal = await waitForRemoteColor(caller, "teal");
  assert.deepEqual(await caller.evaluate(() => mockCall.stream.getAudioTracks().map(track => track.readyState)), ["live"]);
  const reopened = await browser.context.newPage();
  await reopened.goto("chrome-extension://" + id + "/studio.html");
  await reopened.waitForFunction(() => document.querySelector("#live-mode").getAttribute("aria-pressed") === "true");
  await reopened.getByRole("button", { name: "Select Display capture", exact: true }).click();
  await reopened.waitForFunction(() => document.querySelector(".display-status")?.textContent.startsWith("Sharing"));
  await reopened.getByRole("button", { name: "Delete Display capture", exact: true }).click();
  await reopened.waitForFunction(async () => !(await chrome.runtime.sendMessage({ target: "lightwell-capture", action: "list" })).captures.length);
  await waitForRemoteColor(caller, "stopped");
  console.log("PASS selected tab stays in the background, updates the call with Studio closed, reconnects on reopen and stops on deletion", await magenta.jsonValue(), await teal.jsonValue());
} finally {
  server.close();
  await browser.close();
  await rm(fixture, { recursive: true, force: true });
}
