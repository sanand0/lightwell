// @ts-check

export class CaptureClient {
  constructor(onStatus) {
    this.entries = new Map();
    this.frames = new Map();
    this.onStatus = onStatus;
    this.listener = (message, sender) => {
      if (sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("offscreen.html") && message?.target === "lightwell-capture-status") {
        this.update(message.captures);
      }
    };
    chrome.runtime.onMessage.addListener(this.listener);
  }

  update(entries) {
    if (!Array.isArray(entries) || this.closed) return;
    this.entries = new Map(entries.map(entry => [entry.id, entry]));
    for (const [key, slot] of this.frames) {
      if (this.entries.has(slot.id)) continue;
      slot.frame?.close();
      this.frames.delete(key);
    }
    this.onStatus();
  }

  async command(action, options = {}) {
    const result = await chrome.runtime.sendMessage({ target: "lightwell-capture", action, ...options });
    if (result?.error) throw Object.assign(new Error(result.error), { name: result.code || "Error" });
    this.update(result?.captures);
    return result;
  }

  sample(item, raw = false) {
    if (!this.entries.has(item.id)) return undefined;
    const key = raw ? item.id + ":raw" : item.id;
    if (!this.frames.has(key)) this.frames.set(key, { id: item.id, at: 0 });
    const slot = this.frames.get(key);
    const now = performance.now();
    if (!slot.pending && now >= slot.at) {
      slot.at = now + 68;
      const effect = !raw && item.type === "camera" ? item.source.effect : undefined;
      slot.pending = true;
      chrome.runtime.sendMessage({ target: "lightwell-capture", action: "frame", id: item.id, effect })
        .then(result => {
          if (this.frames.get(key) !== slot) { result?.frame?.close(); return; }
          if (result?.error) { void this.command("list").catch(() => {}); return; }
          slot.state = result?.state;
          if (result?.frame) {
            slot.frame?.close();
            slot.frame = result.frame;
          }
        }).catch(() => { slot.at = performance.now() + 500; })
        .finally(() => { slot.pending = false; });
    }
    return slot.frame || null;
  }

  close() {
    this.closed = true;
    chrome.runtime.onMessage.removeListener(this.listener);
    for (const slot of this.frames.values()) slot.frame?.close();
    this.frames.clear();
  }
}
