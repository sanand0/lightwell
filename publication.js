// @ts-check
// IndexedDB can store large local blobs without serializing them into scene JSON or chrome.storage.
const openDB = () => new Promise((resolve, reject) => {
  const request = indexedDB.open("lightwell-call-assets", 2);
  request.onupgradeneeded = event => {
    if (event.oldVersion < 1) request.result.createObjectStore("publications");
    request.result.createObjectStore("scenes", { keyPath: "id" });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function storeWork(mode, work, name = "publications") {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(name, mode);
      const result = work(transaction.objectStore(name));
      transaction.oncomplete = () => resolve(result?.result);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}

export const savedScenes = () => storeWork("readonly", store => store.getAll(), "scenes");
export const saveSceneRecord = entry => storeWork("readwrite", store => store.put(entry), "scenes");

// Studio's unsaved, unpublished local files live under this key so drafts survive reloads and restarts.
export const draftAssets = "studio-draft";
export const readAssets = id => storeWork("readonly", store => store.get(id));
export const writeAssets = (id, files) => storeWork("readwrite", store => store.put(files, id));
export const removeOldAssets = id => storeWork("readwrite", store => {
  const keys = store.getAllKeys();
  keys.onsuccess = () => keys.result.filter(key => key !== id && key !== draftAssets).forEach(key => store.delete(key));
});

export function frameSampler() {
  const canvas = new OffscreenCanvas(1, 1);
  const ctx = canvas.getContext("2d");
  return (source, limit) => {
    const sw = source.videoWidth ?? source.naturalWidth ?? source.width;
    const sh = source.videoHeight ?? source.naturalHeight ?? source.height;
    if (!sw || !sh || (source.readyState !== undefined && source.readyState < 2)) return null;
    const scale = Math.min(1, limit / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(source, 0, 0, w, h);
    return canvas.transferToImageBitmap();
  };
}

// Runtime messaging clones the bitmap synchronously. Keep only the receiver's copy.
export function replyWithMedia(reply, result) {
  try { reply(result); }
  finally { result?.frame?.close(); }
}
