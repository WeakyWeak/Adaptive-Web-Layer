// Content script — runs at document_start on all URLs
// Applies resolved config ASAP and handles messages from popup/background.

import { parseMessage } from "../shared/messages";

// Detect restricted pages (chrome://, chrome-extension://, Web Store, etc.)
function isRestrictedPage(): boolean {
  const url = window.location.href;
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("devtools://") ||
    url.startsWith("about:") ||
    url.includes("chrome.google.com/webstore")
  );
}

if (isRestrictedPage()) {
  // Silently do nothing on restricted pages
  console.debug("[AWL content] restricted page, skipping");
} else {
  console.debug("[AWL content] content script loaded on", window.location.hostname);

  // ── Message listener ──────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
    const msg = parseMessage(raw);
    if (!msg) return false;

    if (msg.type === "GET_PAGE_INFO") {
      sendResponse({
        type: "PAGE_INFO",
        payload: {
          hostname: window.location.hostname,
          url: window.location.href,
          title: document.title,
        },
      });
      return false; // synchronous
    }

    return false;
  });
}
