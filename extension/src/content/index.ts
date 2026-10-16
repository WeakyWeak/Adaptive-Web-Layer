import { parseMessage } from "../shared/messages";
import { loadSettings, onSettingsChange } from "../shared/storage";
import { resolveTypography, isSiteEnabled } from "../shared/settings";
import { getStyleLayer } from "./styleLayer";
import { registerTypographyOps } from "./typographyOps";
import { applyTypography, revertTypography } from "./applier";
import { injectBundledFonts } from "./fontInjector";
import type { ApplyContext } from "../shared/registry";

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

  // ── Bootstrap ──────────────────────────────────────────────────────────────
  // Register all operations once
  registerTypographyOps();

  const styleLayer = getStyleLayer();
  // Inject bundled fonts so they are available for use
  injectBundledFonts(styleLayer);
  const hostname = window.location.hostname;

  // Build apply context from current settings
  function makeCtx(applyToWholePage: boolean): ApplyContext {
    return { styleLayer, applyToWholePage };
  }

  // Apply saved settings on load (no AI call, no flash)
  async function applyFromStorage(): Promise<void> {
    try {
      const settings = await loadSettings();
      if (!isSiteEnabled(settings, hostname)) {
        revertTypography();
        return;
      }
      const prefs = resolveTypography(settings, hostname);
      const ctx = makeCtx(settings.global.applyToWholePage);
      applyTypography(ctx, prefs);
    } catch (err) {
      console.warn("[AWL content] failed to apply settings:", err);
    }
  }

  // Apply immediately; also re-apply when storage changes
  void applyFromStorage();

  onSettingsChange(async (settings) => {
    if (!isSiteEnabled(settings, hostname)) {
      revertTypography();
      return;
    }
    const prefs = resolveTypography(settings, hostname);
    const ctx = makeCtx(settings.global.applyToWholePage);
    applyTypography(ctx, prefs);
  });

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

    if (msg.type === "APPLY_TYPOGRAPHY") {
      try {
        const ctx = makeCtx(msg.applyToWholePage);
        applyTypography(ctx, msg.payload);
        sendResponse({ type: "ACK", ok: true });
      } catch (e) {
        sendResponse({ type: "ACK", ok: false, error: String(e) });
      }
      return false;
    }

    if (msg.type === "REVERT_TYPOGRAPHY") {
      revertTypography();
      sendResponse({ type: "ACK", ok: true });
      return false;
    }

    return false;
  });
}
