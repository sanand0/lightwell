// @ts-check
import { createServer } from "node:http";
import { createReadStream, statSync, watch } from "node:fs";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const mime = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".wasm": "application/wasm", ".tflite": "application/octet-stream",
};
const allowed = /^(?:[a-z][a-z-]+\.(?:html|css|js)|vendor\/vision\/(?:[\w.-]+|wasm\/[\w.-]+))$/;

export function serve(port = 8765) {
  const listeners = new Set();
  const watcher = watch(root, (_, file) => {
    if (file && allowed.test(file)) for (const response of listeners) response.write("data: reload\n\n");
  });
  watcher.unref();
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/favicon.ico") { response.writeHead(204).end(); return; }
    if (url.pathname === "/watch") {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      response.write(": connected\n\n");
      listeners.add(response);
      response.on("close", () => listeners.delete(response));
      return;
    }
    const asset = url.pathname.slice(1) || "studio.html";
    const path = resolve(root, asset);
    if (!allowed.test(asset) || !statSync(path, { throwIfNoEntry: false })?.isFile()) {
      response.writeHead(404).end("File not found.");
      return;
    }
    response.setHeader("Content-Type", mime[extname(asset)] || "application/octet-stream");
    response.setHeader("Cache-Control", "no-store");
    if (asset === "mock-call.html" && url.searchParams.has("csp")) {
      response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self'; media-src 'self' blob:; require-trusted-types-for 'script'");
    }
    createReadStream(path).pipe(response);
  });
  server.on("close", () => watcher.close());
  return new Promise((ok, reject) => {
    server.once("error", reject);
    server.listen(port, "localhost", () => ok(server));
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await serve(Number(process.env.PORT || 8765));
  console.log("Studio http://localhost:" + server.address().port + "/studio.html?dev");
  console.log("Mock call http://localhost:" + server.address().port + "/mock-call.html");
}
