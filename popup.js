// @ts-check
const $ = selector => document.querySelector(selector);
const toggle = $("#toggle");
const reload = $("#reload");
const state = $("#state");
let tab;
let target;
let enabled = false;

$("#studio").addEventListener("click", () => chrome.runtime.openOptionsPage());
reload.addEventListener("click", async () => {
  await chrome.tabs.reload(tab.id);
  window.close();
});
async function action(type) {
  const response = await chrome.runtime.sendMessage({ type, origin: target.origin, tab: tab.id });
  if (response.error) throw new Error(response.error);
  enabled = response.enabled;
  toggle.textContent = enabled ? "Disable on this origin" : "Enable on this origin";
  return response.status;
}
toggle.addEventListener("click", async () => {
  toggle.disabled = true;
  try {
    if (!enabled) {
      const pattern = target.protocol + "//" + target.hostname + "/*";
      const token = crypto.randomUUID();
      const intent = chrome.runtime.sendMessage({ type: "prepare", origin: target.origin, token });
      const allowed = await chrome.permissions.request({ origins: [pattern] });
      await intent;
      if (!allowed) {
        await chrome.runtime.sendMessage({ type: "cancel", origin: target.origin, token });
        state.textContent = "Site permission was declined. Camera behavior stays unchanged.";
        return;
      }
    }
    await action(enabled ? "disable" : "enable");
    reload.hidden = !enabled;
    state.textContent = enabled ? "Enabled. Reload the tab, then start its camera." : "Disabled. Any Lightwell video on this origin has been stopped.";
  } catch (error) { state.textContent = error.message; }
  finally { toggle.disabled = false; }
});

try {
  const tabId = new URLSearchParams(location.search).get("tab");
  tab = tabId ? await chrome.tabs.get(Number(tabId)) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab?.url) throw new Error("Select a website tab and reopen Lightwell.");
  target = new URL(tab.url);
  if (!["http:", "https:"].includes(target.protocol)) throw new Error("Open a website to configure its camera.");
  $("#origin").textContent = target.origin;
  const running = await action("state");
  toggle.disabled = false;
  reload.hidden = !enabled || !!running?.active;
  state.textContent = enabled ? running?.label || "Enabled. Reload the tab to attach." : "Off. Enable this origin, then reload the tab.";
} catch (error) { state.textContent = error.message; }
