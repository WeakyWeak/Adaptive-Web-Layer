// Background service worker (MV3)
// Stateless: MV3 service workers are terminated when idle.
// All state must be persisted in chrome.storage, never held in memory.

import { parseMessage } from "../shared/messages";

console.log("[AWL background] service worker started");

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
