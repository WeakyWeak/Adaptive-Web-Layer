import { parseMessage } from "../shared/messages";
import { loadSettings, onSettingsChange } from "../shared/storage";
import { resolveTypography, resolveAppearance, isSiteEnabled } from "../shared/settings";
import { getStyleLayer } from "./styleLayer";
import { registerTypographyOps } from "./typographyOps";
import { applyTypography, applyAppearance, revertTypography, revertAppearance, undoTypography, resetPageAll } from "./applier";
import { registerAppearanceOps } from "./appearanceOps";
import { detectExistingDark } from "./darkDetection";
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
  registerAppearanceOps();

  const styleLayer = getStyleLayer();
  // Inject bundled fonts so they are available for use
  injectBundledFonts(styleLayer);
  let hostname = window.location.hostname;
  let observer: MutationObserver | null = null;
  let applyTimer: ReturnType<typeof setTimeout> | null = null;

  // Build apply context from current settings
  function makeCtx(applyToWholePage: boolean): ApplyContext {
    return { styleLayer, applyToWholePage };
  }

  // Apply saved settings on load (no AI call, no flash)
  async function applyFromStorage(): Promise<void> {
    try {
      const started = performance.now();
      const settings = await loadSettings();
      if (!isSiteEnabled(settings, hostname)) {
        revertTypography();
        revertAppearance();
        observer?.disconnect();
        observer = null;
        return;
      }
      const prefs = resolveTypography(settings, hostname);
      const appearance = resolveAppearance(settings, hostname);
      const darkStatus = detectExistingDark();
      const effectiveTheme = appearance.theme === "dark" && darkStatus.alreadyDark && !appearance.forceDark ? "light" : appearance.theme;
      const ctx = makeCtx(settings.global.applyToWholePage);
      // Apply the root theme as soon as storage resolves, before prose-level rules.
      applyAppearance(ctx, appearance, effectiveTheme);
      applyTypography(ctx, prefs);
      if (!observer && document.documentElement) {
        observer = new MutationObserver((records) => {
          const hasPageChanges = records.some((record) => record.type === "attributes" || Array.from(record.addedNodes).some((node) =>
            node instanceof Element && !node.matches("style[data-awl]") && !node.closest("style[data-awl]")));
          if (!hasPageChanges || applyTimer) return;
          applyTimer = setTimeout(() => {
            applyTimer = null;
            // Managed CSS selectors automatically cover new content; refresh region detection after SPA inserts.
            void applyFromStorage();
          }, 120);
        });
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["class", "data-theme", "data-color-scheme", "data-dark-mode"],
        });
      }
      console.debug("[AWL] apply_ms", Math.round((performance.now() - started) * 100) / 100);
    } catch (err) {
      console.warn("[AWL content] failed to apply settings:", err);
    }
  }

  // Apply immediately; also re-apply when storage changes
  void applyFromStorage();
  window.addEventListener("DOMContentLoaded", () => { void applyFromStorage(); }, { once: true });
  window.addEventListener("load", () => { void applyFromStorage(); }, { once: true });

  onSettingsChange(() => {
    hostname = window.location.hostname;
    void applyFromStorage();
  });

  // SPA navigation: refresh site matching when the URL changes without a document load.
  const originalPushState = history.pushState.bind(history);
  history.pushState = ((...args: Parameters<History["pushState"]>) => {
    originalPushState(...args);
    hostname = window.location.hostname;
    void applyFromStorage();
  }) as History["pushState"];
  window.addEventListener("popstate", () => { hostname = window.location.hostname; void applyFromStorage(); });
  window.addEventListener("hashchange", () => { hostname = window.location.hostname; void applyFromStorage(); });
  window.addEventListener("pagehide", () => {
    observer?.disconnect();
    observer = null;
    if (applyTimer) clearTimeout(applyTimer);
  }, { once: true });

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

    if (msg.type === "GET_APPEARANCE_STATUS") {
      const status = detectExistingDark();
      sendResponse({ type: "APPEARANCE_STATUS", ...status });
      return false;
    }

    if (msg.type === "UNDO_PAGE") {
      sendResponse({ type: "ACK", ok: undoTypography(makeCtx(false)) });
      return false;
    }

    if (msg.type === "RESET_PAGE") {
      resetPageAll();
      sendResponse({ type: "ACK", ok: true });
      return false;
    }

    return false;
  });
}
