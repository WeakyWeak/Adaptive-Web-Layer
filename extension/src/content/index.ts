import { parseMessage } from "../shared/messages";
import { loadSettings, onSettingsChange, saveSettings } from "../shared/storage";
import { resolveTypography, resolveAppearance, resolveFocus, resolveMotion, isSiteEnabled, matchingSiteRule, type Settings } from "../shared/settings";
import { getStyleLayer } from "./styleLayer";
import { registerTypographyOps } from "./typographyOps";
import { applyTypography, applyAppearance, applyFocus, revertTypography, revertAppearance, revertFocus } from "./applier";
import { registerAppearanceOps } from "./appearanceOps";
import { detectExistingDark, shouldSkipDarkTheme } from "./darkDetection";
import { injectBundledFonts } from "./fontInjector";
import { registerFocusOps } from "./focusOps";
import { ElementPicker, focusCandidates } from "./elementPicker";
import { buildDomSnapshot } from "./domSnapshot";
import type { ApplyContext } from "../shared/registry";
import type { PlanChanges } from "../shared/aiFields";
import { withSitePatch } from "../shared/sitePatch";

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
  registerFocusOps();

  const styleLayer = getStyleLayer();
  // Inject bundled fonts so they are available for use
  injectBundledFonts(styleLayer);
  let hostname = window.location.hostname;
  let observer: MutationObserver | null = null;
  let applyTimer: ReturnType<typeof setTimeout> | null = null;
  let currentSettings: Settings | null = null;
  let undoSettings: Settings | null = null;
  // AI preview: a temporary overlay on this site's rule, never saved. It goes
  // through the same resolution + applier as saved settings, so DOM mutations
  // re-apply it instead of overwriting it.
  let previewChanges: PlanChanges | null = null;

  // Build apply context from current settings
  function makeCtx(applyToWholePage: boolean): ApplyContext {
    return { styleLayer, applyToWholePage };
  }

  // Apply saved settings on load (no AI call, no flash)
  async function applyFromStorage(nextSettings?: Settings, recordUndo = false): Promise<void> {
    try {
      const started = performance.now();
      const settings = nextSettings ?? await loadSettings();
      if (recordUndo && currentSettings && JSON.stringify(currentSettings) !== JSON.stringify(settings)) undoSettings = currentSettings;
      currentSettings = settings;
      if (!isSiteEnabled(settings, hostname)) {
        revertTypography();
        revertAppearance();
        revertFocus();
        observer?.disconnect();
        observer = null;
        return;
      }
      const effective = previewChanges ? withSitePatch(settings, hostname, previewChanges) : settings;
      const prefs = resolveTypography(effective, hostname);
      const appearance = resolveAppearance(effective, hostname);
      const darkStatus = detectExistingDark();
      // Fast uses inversion, so never invert a page that declares itself dark;
      // that would turn its existing dark palette light. The force override is
      // still available for luminance-only detections, which may be false positives.
      const shouldSkipTheme = shouldSkipDarkTheme(appearance.theme, darkStatus, appearance.forceDark, appearance.engine);
      const ctx = makeCtx(settings.global.applyToWholePage);
      // Apply the root theme as soon as storage resolves, before prose-level rules.
      applyAppearance(ctx, appearance, appearance.theme, shouldSkipTheme);
      applyTypography(ctx, prefs);
      applyFocus(ctx, resolveFocus(effective, hostname), resolveMotion(effective, hostname));
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

  onSettingsChange((settings) => {
    hostname = window.location.hostname;
    void applyFromStorage(settings, true);
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

    if (msg.type === "GET_FOCUS_CANDIDATES") {
      sendResponse({ type: "FOCUS_CANDIDATES", candidates: focusCandidates() });
      return false;
    }

    if (msg.type === "START_ELEMENT_PICKER") {
      new ElementPicker((selector, action) => {
        void loadSettings().then(async (settings) => {
          const current = matchingSiteRule(settings, hostname);
          const field = action === "hide" ? "hiddenSelectors" : "preservedSelectors";
          const focus = { ...(current?.focus ?? {}), [field]: [...new Set([...(current?.focus?.[field] ?? []), selector])].slice(0, 30) };
          const rule = { hostname, enabled: current?.enabled ?? true, includeSubdomains: false, profileId: current?.profileId ?? null, disabledOperations: current?.disabledOperations ?? [], typography: current?.typography ?? {}, appearance: current?.appearance ?? {}, focus, motion: current?.motion ?? {} };
          await chrome.storage.local.set({ awl_settings: { ...settings, siteRules: [...settings.siteRules.filter((item) => item.hostname !== hostname), rule] } });
        });
      }, () => undefined);
      sendResponse({ type: "ACK", ok: true });
      return false;
    }

    if (msg.type === "UNDO_PAGE") {
      const previous = undoSettings;
      if (!previous) { sendResponse({ type: "ACK", ok: false, error: "No page setting to undo" }); return false; }
      void saveSettings(previous).then((ok) => sendResponse({ type: "ACK", ok, error: ok ? undefined : "Could not restore the previous page setting" }));
      return true;
    }

    if (msg.type === "RESET_PAGE") {
      void loadSettings().then((settings) => {
        const current = matchingSiteRule(settings, hostname);
        const rule = { hostname, enabled: false, includeSubdomains: current?.includeSubdomains ?? false, profileId: current?.profileId ?? null, disabledOperations: current?.disabledOperations ?? [], typography: current?.typography ?? {}, appearance: current?.appearance ?? {}, focus: current?.focus ?? {}, motion: current?.motion ?? {} };
        return saveSettings({ ...settings, siteRules: [...settings.siteRules.filter((item) => item.hostname !== hostname), rule] });
      }).then((ok) => sendResponse({ type: "ACK", ok, error: ok ? undefined : "Could not reset this page" })).catch((error) => sendResponse({ type: "ACK", ok: false, error: String(error) }));
      return true;
    }

    // ── P05: DOM snapshot ───────────────────────────────────────────────────
    if (msg.type === "GET_DOM_SNAPSHOT") {
      void loadSettings().then((settings) => {
        try {
          const snapshot = buildDomSnapshot(settings.global.applyToWholePage);
          sendResponse({ type: "DOM_SNAPSHOT", payload: snapshot });
        } catch (e) {
          sendResponse({ type: "ACK", ok: false, error: String(e) });
        }
      }).catch((e) => sendResponse({ type: "ACK", ok: false, error: String(e) }));
      return true; // async
    }

    // ── P06R: AI preview overlay ────────────────────────────────────────────
    if (msg.type === "SET_PREVIEW") {
      previewChanges = msg.changes;
      void applyFromStorage(currentSettings ?? undefined).then(() => sendResponse({ type: "ACK", ok: true }));
      return true;
    }

    return false;
  });
}
