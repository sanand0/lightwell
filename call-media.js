// @ts-check
(() => {
  const lab = globalThis.Lightwell;
  const send = (media, transfers = []) => window.postMessage({ from: "lightwell-page", media }, location.origin, transfers);
  const isMovie = item => ["display", "video", "media", "camera"].includes(item.type);

  class CallMedia {
    constructor() {
      this.id = crypto.randomUUID();
      this.next = 0;
      this.pending = new Map();
      this.layers = new Map();
      this.input = new OffscreenCanvas(1, 1);
      this.inputContext = this.input.getContext("2d");
      this.mask = null;
      this.status = "Waiting for local segmentation";
      this.maskRequest = {};
    }

    configure(publication) {
      if ((this.publication?.id ?? null) === (publication?.id ?? null)) return;
      this.close();
      this.id = crypto.randomUUID();
      this.publication = publication;
      this.maskRequest = {};
    }

    request(slot, kind, layer, frame) {
      const now = performance.now();
      // At most one in-flight frame per source. Late responses are discarded.
      if (slot.busy || now < (slot.nextAt || 0)) { frame?.close(); return; }
      const request = ++this.next;
      const timeout = setTimeout(() => this.receive({
        request, error: "Timed out waiting for " + (kind === "mask" ? "segmentation" : "the published source"),
      }), 3800);
      slot.busy = true;
      slot.nextAt = now + (kind === "mask" || kind === "hands" ? 88 : 68);
      this.pending.set(request, { slot, kind, timeout });
      try { send({ session: this.id, request, kind, layer, frame, publication: this.publication?.id ?? null }, frame ? [frame] : []); }
      catch (error) {
        frame?.close();
        this.receive({ request, error: error.message });
      }
    }

    receive(packet) {
      const job = this.pending.get(packet.request);
      if (!job) { packet.frame?.close(); return; }
      this.pending.delete(packet.request);
      clearTimeout(job.timeout);
      const { slot, kind } = job;
      slot.busy = false;
      if (packet.skipped) return;
      if (packet.error) {
        slot.error = packet.error;
        slot.nextAt = performance.now() + 550;
      } else slot.error = "";
      if (kind === "hands") {
        this.handList = packet.error ? [] : packet.hands || [];
        this.handStatus = packet.error || packet.state || "";
        return;
      }
      if (slot !== this.maskRequest && kind === "mask") { packet.frame?.close(); return; }
      if (packet.frame || packet.error) {
        slot.frame?.close();
        slot.frame = packet.frame || null;
        if (kind === "mask") this.mask = slot.frame;
      }
      if (kind === "mask") {
        this.status = packet.error ? "Segmentation unavailable · using original: " + packet.error
          : packet.state || "Waiting for local segmentation";
      } else if (packet.frame && packet.still) slot.loaded = true;
    }

    media(item) {
      const kind = ["display", "camera"].includes(item.type) ? "display" : "asset";
      const available = kind === "display" ? this.publication?.display : this.publication?.assets;
      if (!available?.includes(item.id)) return undefined;
      if (!this.layers.has(item.id)) this.layers.set(item.id, {});
      const slot = this.layers.get(item.id);
      if (!slot.loaded) this.request(slot, kind, item.id);
      // A camera whose background capture is missing or not yet streaming falls back to the call's own camera, never a blank layer.
      if (item.type === "camera" && (slot.error || !slot.frame)) return undefined;
      return slot.frame ?? null;
    }

    summary(scene) {
      const active = scene.layers.filter(item => item.visible && item.opacity > 0);
      const missingDisplay = active.some(item => item.type === "display" && !this.publication?.display?.includes(item.id));
      if (missingDisplay) return "Choose a display in Studio and publish";
      for (const item of active) {
        if (!this.publication?.assets?.includes(item.id) && !this.publication?.display?.includes(item.id)) continue;
        const slot = this.layers.get(item.id);
        if (slot?.error && item.type === "camera") return item.name + " · using this call's camera (" + slot.error + ")";
        if (slot?.error) return item.name + " · " + slot.error;
        if (!slot?.frame) return item.name + " · " + (isMovie(item) ? "waiting for video" : "loading image");
      }
      return "";
    }

    step(source) {
      const slot = this.maskRequest;
      if (slot.busy || performance.now() < (slot.nextAt || 0)) return;
      const factor = Math.min(1, 256 / Math.max(source.videoWidth, source.videoHeight));
      const w = Math.max(1, Math.round(source.videoWidth * factor));
      const h = Math.max(1, Math.round(source.videoHeight * factor));
      if (this.input.width !== w || this.input.height !== h) { this.input.width = w; this.input.height = h; }
      this.inputContext.drawImage(source, 0, 0, w, h);
      this.request(slot, "mask", null, this.input.transferToImageBitmap());
    }

    // Hand gestures run in the offscreen page; results arrive in handList (see hands.js for the shape).
    trackHands(source) {
      const slot = this.handRequest ??= {};
      if (slot.busy || performance.now() < (slot.nextAt || 0)) return;
      const width = source.videoWidth ?? source.width;
      const height = source.videoHeight ?? source.height;
      const factor = Math.min(1, 320 / Math.max(width, height));
      const w = Math.max(1, Math.round(width * factor));
      const h = Math.max(1, Math.round(height * factor));
      this.handInput ??= new OffscreenCanvas(w, h);
      if (this.handInput.width !== w || this.handInput.height !== h) { this.handInput.width = w; this.handInput.height = h; }
      this.handInput.getContext("2d").drawImage(source, 0, 0, w, h);
      this.request(slot, "hands", null, this.handInput.transferToImageBitmap());
    }

    reset() {
      this.mask?.close();
      this.mask = null;
      this.maskRequest = {};
      this.status = "Waiting for local segmentation";
    }

    close() {
      this.handRequest = {};
      this.handList = [];
      if (this.next) send({ session: this.id, kind: "release" });
      for (const job of this.pending.values()) clearTimeout(job.timeout);
      this.pending.clear();
      for (const slot of this.layers.values()) slot.frame?.close();
      this.layers.clear();
      this.reset();
    }
  }

  lab.CallMedia = CallMedia;
})();
