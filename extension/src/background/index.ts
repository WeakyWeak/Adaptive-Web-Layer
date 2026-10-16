// Background service worker (MV3)
// Stateless: MV3 service workers are terminated when idle.
// All state must be persisted in chrome.storage, never held in memory.

import { parseMessage } from "../shared/messages";
import { loadSettings, onSettingsChange } from "../shared/storage";
import { isSiteEnabled, resolveAppearance, resolveTypography } from "../shared/settings";

console.log("[AWL background] service worker started");

async function refreshBadge(tabId: number, url?: string): Promise<void> {
  if (!url) return;
  try {
    const hostname = new URL(url).hostname;
    const settings = await loadSettings();
    const defaults: Record<string, unknown> = { fontFamily: "", fontSize: 16, lineHeight: 1.5, letterSpacing: 0, wordSpacing: 0, paragraphSpacing: 0, maxContentWidth: 800 };
    const appearance = resolveAppearance(settings, hostname);
    const appearanceActive = appearance.theme !== "light" || appearance.contrast !== 1 || appearance.brightness !== 1 || appearance.saturation !== 1;
    const active = isSiteEnabled(settings, hostname) && (appearanceActive || Object.entries(resolveTypography(settings, hostname)).some(([key, value]) => value !== defaults[key]));
    void chrome.action.setBadgeText({ tabId, text: active ? "ON" : "" });
    void chrome.action.setBadgeBackgroundColor({ tabId, color: "#4f46e5" });
  } catch { void chrome.action.setBadgeText({ tabId, text: "" }); }
}

void loadSettings().then(() => chrome.tabs.query({}, (tabs) => tabs.forEach((tab) => { if (tab.id) void refreshBadge(tab.id, tab.url); })));
onSettingsChange(() => chrome.tabs.query({}, (tabs) => tabs.forEach((tab) => { if (tab.id) void refreshBadge(tab.id, tab.url); })));
chrome.tabs.onActivated.addListener(({ tabId }) => chrome.tabs.get(tabId, (tab) => { void refreshBadge(tabId, tab.url); }));
chrome.tabs.onUpdated.addListener((tabId, change, tab) => { if (change.status === "complete" || change.url) void refreshBadge(tabId, tab.url); });

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  const msg = parseMessage(raw);
  if (!msg) return false;

  if (msg.type === "PING") {
    sendResponse({ type: "PONG", version: chrome.runtime.getManifest().version });
    return false; // synchronous response
  }

  // Forward GET_PAGE_INFO to the active tab's content script
  if (msg.type === "GET_PAGE_INFO") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) {
        sendResponse(null);
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_INFO" }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn("[AWL background] content script error:", chrome.runtime.lastError.message);
          sendResponse(null);
        } else {
          sendResponse(response);
        }
      });
    });
    return true; // async response
  }

  return false;
});

// ── Install / update lifecycle ────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener((details) => {
  console.log("[AWL background] installed/updated:", details.reason);
});
