// @ts-check
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

export async function openChrome(moreFlags = []) {
  const profile = await mkdtemp(join(tmpdir(), "lightwell-browser-"));
  const headless = process.env.LIGHTWELL_HEADED === "1" ? [] : ["--headless=new"];
  const binary = process.env.CHROME_BIN || "/usr/bin/google-chrome";
  const child = spawn(binary, [
    ...headless, "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--enable-unsafe-extension-debugging", "--remote-debugging-pipe", "--remote-debugging-port=0",
    "--user-data-dir=" + profile, ...moreFlags, "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  let seq = 0;
  let buffer = Buffer.alloc(0);
  const pending = new Map();
  child.stdio[4].on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (let end = buffer.indexOf(0); end >= 0; end = buffer.indexOf(0)) {
      const message = JSON.parse(buffer.subarray(0, end).toString());
      buffer = buffer.subarray(end + 1);
      const handler = pending.get(message.id);
      if (!handler) continue;
      pending.delete(message.id);
      clearTimeout(handler.timer);
      if (message.error) handler.reject(new Error(message.error.message));
      else handler.resolve(message.result);
    }
  });
  function send(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Browser CDP timed out: " + method)); }, 7500);
      pending.set(id, { resolve, reject, timer });
      child.stdio[3].write(JSON.stringify({ id, method, params }) + "\0");
    });
  }
  let browser;
  async function close() {
    await browser?.close();
    child.kill();
    await exited;
    await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
  try {
    let port;
    for (let i = 0; i < 60 && !port; i++) {
      try { port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; }
      catch { await delay(100); }
    }
    if (!port) throw new Error("Chrome did not open its local debugging port.");
    browser = await chromium.connectOverCDP("http://localhost:" + port);
    return { browser, context: browser.contexts()[0], close, send, profile };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function grantLocalhostFixture(source, target) {
  const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));
  manifest.host_permissions = ["http://localhost/*"];
  const files = (await readdir(source)).filter(file => /\.(?:js|css|html)$/.test(file));
  await Promise.all([...files, "icons", "vendor"].map(file => cp(join(source, file), join(target, file), { recursive: true })));
  await writeFile(join(target, "manifest.json"), JSON.stringify(manifest));
}
