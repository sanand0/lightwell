// @ts-check
(() => {
  const from = "lightwell-extension";
  const to = "lightwell-page";
  const channel = chrome.runtime.connect({ name: "lightwell" });
  let closed = false;
  const heartbeat = setInterval(() => {
    try { channel.postMessage({ ping: true }); }
    catch { disconnect(); }
  }, 20_000);
  const send = config => window.postMessage({ from, config }, location.origin);
  const relay = event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.from !== to) return;
    const { status, media, panelPosition } = event.data;
    const openStudio = event.data.openStudio === true && navigator.userActivation.isActive;
    if (!status && !media && !openStudio && !panelPosition) return;
    try { channel.postMessage({ status, media, openStudio, panelPosition }); }
    catch { disconnect(); }
    finally { media?.frame?.close?.(); }
  };
  function disconnect() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    window.removeEventListener("message", relay);
    send({ enabled: false, disconnected: true });
  }
  window.addEventListener("message", relay);
  channel.onMessage.addListener(message => {
    if (!message.media) { send(message); return; }
    const frame = message.media.frame;
    window.postMessage({ from, media: message.media }, location.origin, frame ? [frame] : []);
  });
  channel.onDisconnect.addListener(disconnect);
})();
