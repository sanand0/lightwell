// @ts-check

export function createSegmenter(forceFailure = false, delegate = "CPU") {
  const mask = document.createElement("canvas");
  const ctx = mask.getContext("2d");
  const input = document.createElement("canvas");
  input.width = 256;
  const inputContext = input.getContext("2d");
  let previous;
  let pixels;
  let model;
  let init;
  let fail = "";
  let closed = false;
  let last = -Infinity;
  let timestamp = 0;

  function useConfidence(values, width, height) {
    if (!pixels || mask.width !== width || mask.height !== height) {
      mask.width = width;
      mask.height = height;
      pixels = ctx.createImageData(width, height);
      previous = new Float32Array(width * height);
    }
    const hadMask = controller.mask === mask;
    for (let i = 0; i < previous.length; i++) {
      const confidence = previous[i] = hadMask ? .45 * previous[i] + .55 * values[i] : values[i];
      pixels.data[i * 4 + 3] = Math.min(255, Math.max(0, (confidence - .21) / .58 * 255));
    }
    ctx.putImageData(pixels, 0, 0);
    controller.mask = mask;
  }

  function syntheticMask(now) {
    if (mask.width !== 256 || mask.height !== 144) {
      mask.width = 256;
      mask.height = 144;
      pixels = null;
    }
    ctx.setTransform(.4, 0, 0, .4, 0, 0);
    ctx.clearRect(0, 0, 640, 360);
    ctx.save();
    ctx.translate(320 + Math.sin(now / 2400) * 12, 180);
    ctx.fillStyle = "white";
    ctx.beginPath();
    ctx.ellipse(0, 159, 142, 107, 0, 0, 2 * Math.PI);
    ctx.ellipse(0, -16, 59, 73, 0, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillRect(-23, 25, 46, 65);
    ctx.restore();
    ctx.resetTransform();
    controller.mask = mask;
  }

  async function loadModel() {
    const { ImageSegmenter, FilesetResolver } = await import("./vendor/vision/vision_bundle.mjs");
    if (closed) return;
    if (!await FilesetResolver.isSimdSupported()) throw new Error("the packaged WASM build requires SIMD");
    const wasm = new URL("./vendor/vision/wasm", import.meta.url).href;
    const modelAssetPath = new URL("./vendor/vision/selfie-segmenter.tflite", import.meta.url).href;
    const segmenter = await ImageSegmenter.createFromOptions(await FilesetResolver.forVisionTasks(wasm), {
      baseOptions: { modelAssetPath, delegate },
      runningMode: "VIDEO", outputConfidenceMasks: true, outputCategoryMask: false,
    });
    if (closed) segmenter.close();
    else model = segmenter;
  }

  function failure(error) {
    fail = "MediaPipe " + delegate + " failed; using original · " + error.message;
    controller.mask = null;
    controller.status = fail;
  }

  const controller = {
    status: "idle",
    mask: null,
    reset() {
      this.status = "idle";
      this.mask = null;
      last = -Infinity;
    },
    close() {
      closed = true;
      this.reset();
      model?.close();
      model = null;
    },
    step(source, now, synthetic) {
      if (forceFailure) { this.status = "Forced segmentation failure; using original"; return; }
      if (synthetic) {
        syntheticMask(now);
        this.status = "Synthetic reference mask · 256 × 144";
        return;
      }
      if (fail) { this.status = fail; return; }
      if (!model) {
        this.status = "Loading browser-local MediaPipe " + delegate + " model…";
        init ??= loadModel().catch(failure);
        return;
      }
      if (now - last < 85) return;
      last = now;
      const start = performance.now();
      try {
        const h = Math.max(1, Math.round(input.width * (source.videoHeight ?? source.height) / (source.videoWidth ?? source.width)));
        if (input.height !== h) input.height = h;
        inputContext.drawImage(source, 0, 0, input.width, h);
        timestamp = Math.max(timestamp + 1, Math.floor(now));
        model.segmentForVideo(input, timestamp, result => {
          const person = result.confidenceMasks?.at(-1);
          if (!person) throw new Error("the model did not return confidence pixels");
          useConfidence(person.getAsFloat32Array(), person.width, person.height);
        });
        this.status = "MediaPipe " + delegate + " · " + mask.width + " × " + mask.height + " · " + (performance.now() - start).toFixed(1) + " ms";
      } catch (error) { failure(error); }
    },
  };
  return controller;
}
