// @ts-check
// Hand landmarks and named gestures from MediaPipe's gesture recognizer, for experimental touch input.
// The 8 MB model is not bundled: it downloads the first time someone turns on hand gestures, then lives in
// the extension's Cache Storage (shared by Studio and the offscreen page that serves call tabs).

export const modelURL = "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task";
const cacheName = "lightwell-models";

/** Returns the model bytes, from cache or the network. onProgress(fraction) reports a download. */
export async function loadModel(onProgress = () => {}, download = true) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(modelURL);
  if (cached) return new Uint8Array(await cached.arrayBuffer());
  if (!download) throw new Error("turn on hand gestures in Studio to download the model");
  const response = await fetch(modelURL);
  if (!response.ok || !response.body) throw new Error("model download failed: HTTP " + response.status);
  const total = Number(response.headers.get("content-length")) || 8_400_000;
  const chunks = [];
  let received = 0;
  for (const reader = response.body.getReader(); ;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(Math.min(1, received / total));
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  await cache.put(modelURL, new Response(bytes, { headers: { "content-type": "application/octet-stream" } }));
  return bytes;
}
export async function modelCached() {
  return !!await (await caches.open(cacheName)).match(modelURL);
}

/**
 * A hand tracker: trackHands(source, now) runs about 12 times a second and updates handList with
 * [{ points: [[u, v] x21 fractions of the frame], gesture: "Closed_Fist" | "Open_Palm" | ..., score }].
 */
export function createHands(delegate = "CPU", download = true) {
  const input = document.createElement("canvas");
  const inputContext = input.getContext("2d");
  let model = null;
  let loading = null;
  let failure = "";
  let last = -Infinity;
  let timestamp = 0;
  let closed = false;

  async function open() {
    const bytes = await loadModel(fraction => { controller.status = "Downloading hand model · " + Math.round(fraction * 100) + "%"; }, download);
    const { GestureRecognizer, FilesetResolver } = await import("./vendor/vision/vision_bundle.mjs");
    const wasm = new URL("./vendor/vision/wasm", import.meta.url).href;
    const recognizer = await GestureRecognizer.createFromOptions(await FilesetResolver.forVisionTasks(wasm), {
      baseOptions: { modelAssetBuffer: bytes, delegate }, runningMode: "VIDEO", numHands: 2,
    });
    if (closed) recognizer.close();
    else model = recognizer;
  }

  const controller = {
    status: "idle",
    handList: [],
    trackHands(source, now = performance.now()) {
      if (failure || closed) return;
      if (!model) {
        if (!loading) {
          controller.status = "Loading hand model…";
          loading = open().catch(error => { failure = controller.status = "Hand gestures unavailable · " + error.message; });
        }
        return;
      }
      if (now - last < 80) return;
      last = now;
      const start = performance.now();
      const width = source.videoWidth ?? source.displayWidth ?? source.width;
      const height = source.videoHeight ?? source.displayHeight ?? source.height;
      if (!width || !height) return;
      input.width = 320;
      input.height = Math.max(1, Math.round(320 * height / width));
      inputContext.drawImage(source, 0, 0, input.width, input.height);
      timestamp = Math.max(timestamp + 1, Math.floor(now));
      try {
        const result = model.recognizeForVideo(input, timestamp);
        controller.handList = result.landmarks.map((points, i) => ({
          points: points.map(point => [point.x, point.y]),
          gesture: result.gestures[i]?.[0]?.categoryName ?? "None",
          score: result.gestures[i]?.[0]?.score ?? 0,
        }));
        controller.status = "Hands · " + controller.handList.length + " · " + (performance.now() - start).toFixed(1) + " ms";
      } catch (error) { failure = controller.status = "Hand gestures failed · " + error.message; }
    },
    close() {
      closed = true;
      model?.close();
      model = null;
    },
  };
  return controller;
}

/** A scripted stand-in for tests: reads globalThis.lightwellFakeHands. */
export function fakeHands() {
  return { status: "Fake hands", get handList() { return globalThis.lightwellFakeHands || []; }, trackHands() {}, close() {} };
}
