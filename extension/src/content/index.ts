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
import { ElementPicker, focusCandidates, persistentSelector } from "./elementPicker";
import { blockAtRegion, buildDomSnapshot, expandBlocks, resolveSnapshotId, sameKindSelector, viewportMarks } from "./domSnapshot";
import { ElementOutline } from "./elementOutline";
import { clearPreviewMarks, previewSelectors } from "./previewMarks";
import { extractPageText } from "./pageText";
import { SummaryCard } from "./summaryCard";
import { activeGlossaryRanges, GlossaryTooltip, registerComprehensionOps } from "./glossary";
import { SelectionPopover } from "./selectionPopover";
import { applyPlan, type Revert } from "../shared/registry";
import type { ApplyContext } from "../shared/registry";
import type { PlanChanges } from "../shared/aiFields";
import type { PreviewElements } from "../shared/elementPlan";
import { currentAiValues, resetSiteRule, savedSiteSelectors, withSiteElements, withSitePatch } from "../shared/sitePatch";
import { forgetContentRegion, getContentRegionSelector } from "./domUtils";
import { inspectPage } from "./inspector";
import { measurePage } from "./measure";

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
  registerComprehensionOps();

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
  // P07: previewed element plan (snapshot ids). `peekId` is temporarily shown
  // while the side panel hovers a hidden item, so its outline is visible.
  let previewElements: PreviewElements | null = null;
  let peekId: string | null = null;
  const outline = new ElementOutline();
  // P08: comprehension UI. Added next to the page's text; never changes it.
  const summaryCard = new SummaryCard();
  const glossaryTooltip = new GlossaryTooltip();
  let glossaryRevert: Revert | null = null;
  const popover = new SelectionPopover((request) => {
    chrome.runtime.sendMessage({ type: "UNDERSTAND_SELECTION", ...request }, () => void chrome.runtime.lastError);
  });

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
      popover.setEnabled(settings.ai.selectionActions && isSiteEnabled(settings, hostname));
      if (!isSiteEnabled(settings, hostname)) {
        revertTypography();
        revertAppearance();
        revertFocus();
        observer?.disconnect();
        observer = null;
        return;
      }
      const patched = previewChanges ? withSitePatch(settings, hostname, previewChanges) : settings;
      const effective = previewElements ? withSiteElements(patched, hostname, previewSelectors(previewElements, peekId)) : patched;
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
            node instanceof Element && !node.matches("style[data-awl], [data-awl-overlay], [data-awl-picker]") && !node.closest("style[data-awl]")));
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
    forgetContentRegion();
    void applyFromStorage();
  }) as History["pushState"];
  window.addEventListener("popstate", () => { hostname = window.location.hostname; forgetContentRegion(); void applyFromStorage(); });
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
      // Remove what the extension changes here; the extension itself stays on.
      previewChanges = null;
      previewElements = null;
      peekId = null;
      clearPreviewMarks();
      void loadSettings().then((settings) => saveSettings(resetSiteRule(settings, hostname))).then((ok) => sendResponse({ type: "ACK", ok, error: ok ? undefined : "Could not reset this page" })).catch((error) => sendResponse({ type: "ACK", ok: false, error: String(error) }));
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
      previewElements = msg.elements ?? null;
      peekId = null;
      outline.hide();
      if (!previewElements) clearPreviewMarks();
      void applyFromStorage(currentSettings ?? undefined).then(() => sendResponse({ type: "ACK", ok: true }));
      return true;
    }

    // ── P08: comprehension ──────────────────────────────────────────────────
    if (msg.type === "GET_PAGE_TEXT") {
      const { text, skippedCode } = extractPageText();
      sendResponse({ type: "PAGE_TEXT", url: window.location.href, title: document.title, text, skippedCode });
      return false;
    }

    if (msg.type === "SHOW_SUMMARY") {
      if (msg.summary) summaryCard.show(msg.summary, () => undefined); else summaryCard.hide();
      sendResponse({ type: "ACK", ok: true });
      return false;
    }

    if (msg.type === "SHOW_GLOSSARY") {
      glossaryRevert?.();
      glossaryRevert = null;
      if (msg.terms?.length) {
        glossaryRevert = applyPlan(makeCtx(false), [{ opId: "glossaryHighlights", params: { terms: msg.terms.map((item) => item.term) } }]).revert;
        glossaryTooltip.setTerms(msg.terms);
      } else {
        glossaryTooltip.clear();
      }
      const counts: Record<string, number> = {};
      for (const { term } of activeGlossaryRanges()) counts[term.toLowerCase()] = (counts[term.toLowerCase()] ?? 0) + 1;
      sendResponse({ type: "GLOSSARY_SHOWN", counts });
      return false;
    }

    if (msg.type === "GLOSSARY_REVEAL") {
      sendResponse({ type: "ACK", ok: glossaryTooltip.reveal(msg.term) });
      return false;
    }

    if (msg.type === "SELECTION_RESULT") {
      popover.showResult(msg.requestId, msg.result, msg.error);
      sendResponse({ type: "ACK", ok: true });
      return false;
    }

    // ── P09: accessibility inspector ────────────────────────────────────────
    if (msg.type === "INSPECT_PAGE") {
      void (async () => {
        // Measure what the page shows with the latest saved settings (a fix may have just been saved).
        const settings = await loadSettings();
        await applyFromStorage(settings);
        await new Promise((resolve) => setTimeout(resolve, 60));
        const effective = previewChanges ? withSitePatch(settings, hostname, previewChanges) : settings;
        const appearance = resolveAppearance(effective, hostname);
        const region = document.querySelector(getContentRegionSelector(settings.global.applyToWholePage)) ?? document.body;
        const report = await inspectPage(document, {
          region,
          current: currentAiValues(effective, hostname),
          smartColours: appearance.engine === "smart" && appearance.theme !== "sepia",
        });
        sendResponse({ type: "INSPECT_RESULT", report });
      })().catch((error) => sendResponse({ type: "ACK", ok: false, error: String(error) }));
      return true;
    }

    // ── P10: supervised fix ─────────────────────────────────────────────────
    if (msg.type === "MEASURE_PAGE") {
      void (async () => {
        // Measure exactly what the page shows: saved settings plus the current preview.
        const settings = currentSettings ?? await loadSettings();
        await new Promise((resolve) => setTimeout(resolve, 60));
        const effective = previewChanges ? withSitePatch(settings, hostname, previewChanges) : settings;
        const appearance = resolveAppearance(effective, hostname);
        const region = document.querySelector(getContentRegionSelector(settings.global.applyToWholePage)) ?? document.body;
        const previewed = previewElements ? previewSelectors(previewElements) : null;
        const hidden = previewed ? [...previewed.hide, ...previewed.dim].flatMap((selector) => {
          try { return Array.from(document.querySelectorAll(selector)); } catch { return []; }
        }) : [];
        const result = await measurePage(document, {
          region,
          current: currentAiValues(effective, hostname),
          smartColours: appearance.engine === "smart" && appearance.theme !== "sepia",
          hidden,
        });
        sendResponse({ type: "MEASURE_RESULT", ...result });
      })().catch((error) => sendResponse({ type: "ACK", ok: false, error: String(error) }));
      return true;
    }

    if (msg.type === "EXPAND_BLOCKS") {
      try {
        sendResponse({ type: "BLOCKS", blocks: expandBlocks(msg.ids, currentSettings?.global.applyToWholePage ?? false).slice(0, 40) });
      } catch (error) {
        sendResponse({ type: "ACK", ok: false, error: String(error) });
      }
      return false;
    }

    if (msg.type === "BLOCKS_AT_REGIONS") {
      try {
        sendResponse({ type: "REGION_BLOCKS", blocks: msg.regions.map((region) => blockAtRegion(region, currentSettings?.global.applyToWholePage ?? false)) });
      } catch (error) {
        sendResponse({ type: "ACK", ok: false, error: String(error) });
      }
      return false;
    }

    if (msg.type === "GET_MARKS") {
      sendResponse({ type: "MARKS", ...viewportMarks(msg.ids) });
      return false;
    }

    // ── P07: element plans ──────────────────────────────────────────────────
    if (msg.type === "OUTLINE_ELEMENT") {
      const element = msg.id ? resolveSnapshotId(msg.id) : undefined;
      const peek = msg.id && previewElements?.hide.includes(msg.id) ? msg.id : null;
      const reapply = peek !== peekId;
      peekId = peek;
      void (reapply ? applyFromStorage(currentSettings ?? undefined) : Promise.resolve()).then(() => {
        if (element) outline.show(element); else outline.hide();
        sendResponse({ type: "ACK", ok: Boolean(element) || !msg.id });
      });
      return true;
    }

    if (msg.type === "RESOLVE_SELECTORS") {
      const selectors = Object.fromEntries(msg.ids.map((id) => {
        const element = resolveSnapshotId(id);
        return [id, element ? persistentSelector(element) : null];
      }));
      // Every-copy selectors, used when the item is hidden.
      const sameKind = Object.fromEntries(msg.ids.map((id) => {
        const element = resolveSnapshotId(id);
        return [id, element ? sameKindSelector(element)?.selector ?? null : null];
      }).filter(([, selector]) => selector !== null));
      sendResponse({ type: "SELECTORS", selectors, sameKind });
      return false;
    }

    if (msg.type === "CHECK_SAVED_SELECTORS") {
      void loadSettings().then((settings) => {
        const saved = savedSiteSelectors(settings, hostname);
        const stale = saved.filter((selector) => {
          try { return document.querySelector(selector) === null; } catch { return true; }
        });
        sendResponse({ type: "SAVED_SELECTORS", total: saved.length, stale });
      }).catch((error) => sendResponse({ type: "ACK", ok: false, error: String(error) }));
      return true;
    }

    return false;
  });
}
