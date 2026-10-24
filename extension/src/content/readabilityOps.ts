// ─── Readability fixes (P09) and text colour ─────────────────────────────────
// Three operations the inspector suggests as fixes: underline links in text,
// a visible keyboard-focus outline, and darker (or lighter) colours for text
// that fails WCAG contrast; plus a named text colour the reader (or the AI)
// can pick, in a shade code checks against what is behind each element.
// Settings fields like any other, so they preview, apply, save and undo
// through the normal settings path.

import { z } from "zod";
import { contrastRatio, parseCssColor, type Color } from "../lib/color";
import type { Operation } from "../shared/registry";
import { TEXT_COLOR_OPTIONS, type AppearancePrefs } from "../shared/settings";
import { createBackdropResolver, requiredContrast } from "./contrast";
import { buildProseSelector, getContentRegionSelector, PROTECTED_SELECTOR } from "./domUtils";
import { setStyleEntry } from "./styleEntry";

const enabledSchema = z.object({ enabled: z.boolean() });
// Links inside running text; navigation menus keep their own look.
const TEXT_LINKS = ":is(p, li, dd, td, blockquote, figcaption):not(nav *, [role='navigation'] *) a[href]";
const UNDERLINE_CSS = `${TEXT_LINKS} { text-decoration-line: underline !important; text-underline-offset: .15em !important; }`;
const FOCUS_CSS = ":is(a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex='-1'])):focus-visible { outline: 3px solid #2563eb !important; outline-offset: 2px !important; }";

const underlineLinks: Operation<{ enabled: boolean }> = {
  id: "underlineLinks", label: "Underline links in text", target: "content-region", protectedElements: [], paramsSchema: enabledSchema, validate: () => null,
  apply(ctx, params) { return setStyleEntry(ctx, "underlineLinks", params.enabled ? UNDERLINE_CSS : null); },
};

const focusRing: Operation<{ enabled: boolean }> = {
  id: "focusRing", label: "Visible focus outline", target: "content-region", protectedElements: [], paramsSchema: enabledSchema, validate: () => null,
  apply(ctx, params) { return setStyleEntry(ctx, "focusRing", params.enabled ? FOCUS_CSS : null); },
};

// ─── Low-contrast text ───────────────────────────────────────────────────────
const MARKER = "data-awl-contrast";
const INITIAL_LIMIT = 3000;
const BATCH_LIMIT = 600;
const SKIP = `${PROTECTED_SELECTOR}, script, style, noscript, [data-awl-overlay], [data-awl-picker]`;
/** Replacement colours: plain text and links, for light and dark backgrounds. */
const COLOURS = { d: "#111111", l: "#f8f8f8", ld: "#0b57d0", ll: "#a8c7fa" } as const;
type ColourKey = keyof typeof COLOURS;

function hasOwnText(element: Element): boolean {
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === 3 && (node.textContent ?? "").trim().length > 1) return true;
  }
  return false;
}

/** The replacement with the best contrast on `background`; links keep a link colour when it passes. */
export function contrastColourFor(background: Color, link: boolean): ColourKey {
  const ratio = (key: ColourKey) => contrastRatio(parseCssColor(COLOURS[key])!, background);
  const plain: ColourKey = ratio("d") >= ratio("l") ? "d" : "l";
  const linkKey: ColourKey = plain === "d" ? "ld" : "ll";
  return link && ratio(linkKey) >= 4.5 ? linkKey : plain;
}

/** Mark failing text in `elements`; returns how many were marked. Reads everything first, then writes. */
function markLowContrast(win: Window, elements: readonly Element[], token: string): number {
  const backdropOf = createBackdropResolver(win);
  const marks: Array<{ element: Element; key: ColourKey }> = [];
  for (const element of elements) {
    if (!element.isConnected || element.closest(SKIP) || !hasOwnText(element)) continue;
    let style: CSSStyleDeclaration;
    try { style = win.getComputedStyle(element); } catch { continue; }
    const fg = parseCssColor(style.color);
    const backdrop = backdropOf(element);
    // Text over an image or gradient: the colour behind it is unknown, so leave it.
    if (!fg || backdrop === "image" || contrastRatio(fg, backdrop) >= requiredContrast(style)) continue;
    marks.push({ element, key: contrastColourFor(backdrop, element.closest("a[href]") !== null) });
  }
  for (const { element, key } of marks) element.setAttribute(MARKER, `${token}-${key}`);
  return marks.length;
}

const FixContrastSchema = z.object({ enabled: z.boolean(), theme: z.enum(["light", "dark", "sepia"]), engine: z.enum(["fast", "smart"]), bodyReady: z.boolean() });

const fixContrast: Operation<z.infer<typeof FixContrastSchema>> = {
  id: "fixContrast", label: "Fix low-contrast text", target: "content-region", protectedElements: PROTECTED_SELECTOR.split(", "), paramsSchema: FixContrastSchema, validate: () => null,
  apply(ctx, params) {
    // Smart already picks readable text colours for every theme but sepia.
    const smartHandles = params.engine === "smart" && params.theme !== "sepia";
    if (!params.enabled || smartHandles || typeof document === "undefined" || !document.body) return setStyleEntry(ctx, "fixContrast", null);
    const win = window;
    const token = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
    markLowContrast(win, Array.from(document.body.querySelectorAll("*")).slice(0, INITIAL_LIMIT), token);
    const stop = watchAdded((batch) => markLowContrast(win, batch, token));
    const css = (Object.keys(COLOURS) as ColourKey[]).map((key) => `[${MARKER}="${token}-${key}"] { color: ${COLOURS[key]} !important; }`).join("\n");
    return setStyleEntry(ctx, "fixContrast", css, () => {
      stop();
      document.querySelectorAll(`[${MARKER}^="${token}-"]`).forEach((element) => element.removeAttribute(MARKER));
    });
  },
};

// ─── Text colour ─────────────────────────────────────────────────────────────
type TextColor = Exclude<typeof TEXT_COLOR_OPTIONS[number], "">;
/**
 * Each named colour in two shades: for light backgrounds (≥ 4.5:1 on white)
 * and for dark ones (≥ 4.5:1 on #121212). Pure red on white is only 4:1, so
 * "red" is a deeper red there.
 */
export const TEXT_SHADES: Record<TextColor, { onLight: string; onDark: string }> = {
  red: { onLight: "#b3261e", onDark: "#ff8a80" },
  orange: { onLight: "#a33d00", onDark: "#ffb74d" },
  brown: { onLight: "#6d4c41", onDark: "#d7b29d" },
  green: { onLight: "#1b6e2a", onDark: "#81c995" },
  teal: { onLight: "#00695c", onDark: "#80cbc4" },
  blue: { onLight: "#0b57d0", onDark: "#a8c7fa" },
  purple: { onLight: "#6a1b9a", onDark: "#ce93d8" },
  pink: { onLight: "#ad1457", onDark: "#f48fb1" },
  grey: { onLight: "#4a4a4a", onDark: "#c4c4c4" },
  black: { onLight: "#111111", onDark: "#f8f8f8" },
};
const TEXT_MARKER = "data-awl-text-color";

/** The shade of `name` that reads on `background`, or null when neither does (a mid-tone band). */
export function textShadeFor(name: TextColor, background: Color, required = 4.5): "onLight" | "onDark" | null {
  const shades = TEXT_SHADES[name];
  const ratio = (shade: "onLight" | "onDark") => contrastRatio(parseCssColor(shades[shade])!, background);
  const best = ratio("onLight") >= ratio("onDark") ? "onLight" : "onDark";
  return ratio(best) >= required ? best : null;
}

/** Mark the prose elements in `elements` with the shade that reads on what is behind them. */
function markTextColor(win: Window, elements: readonly Element[], name: TextColor, token: string): void {
  const backdropOf = createBackdropResolver(win);
  const marks: Array<{ element: Element; shade: string }> = [];
  for (const element of elements) {
    if (!element.isConnected || element.closest(SKIP) || !hasOwnText(element)) continue;
    const backdrop = backdropOf(element);
    // Over an image or gradient the colour behind the text is unknown: keep the site's.
    if (backdrop === "image") continue;
    let style: CSSStyleDeclaration;
    try { style = win.getComputedStyle(element); } catch { continue; }
    const shade = textShadeFor(name, backdrop, requiredContrast(style));
    if (shade) marks.push({ element, shade });
  }
  for (const { element, shade } of marks) element.setAttribute(TEXT_MARKER, `${token}-${shade}`);
}

const TextColorSchema = z.object({ value: z.enum(TEXT_COLOR_OPTIONS), bodyReady: z.boolean() });

const textColor: Operation<z.infer<typeof TextColorSchema>> = {
  id: "textColor", label: "Text colour", target: "prose", protectedElements: PROTECTED_SELECTOR.split(", "), paramsSchema: TextColorSchema, validate: () => null,
  apply(ctx, params) {
    if (!params.value || typeof document === "undefined" || !document.body) return setStyleEntry(ctx, "textColor", null);
    const name = params.value;
    const win = window;
    const token = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
    // The text the typography settings reach (the article, or the whole page); links keep their own colour.
    const prose = `${buildProseSelector(getContentRegionSelector(ctx.applyToWholePage))}:not(a)`;
    const inProse = (elements: Element[]) => elements.filter((element) => { try { return element.matches(prose); } catch { return false; } });
    markTextColor(win, inProse(Array.from(document.body.querySelectorAll("*")).slice(0, INITIAL_LIMIT)), name, token);
    const stop = watchAdded((batch) => markTextColor(win, inProse(batch), name, token));
    // Two :not(#…) lift the rule above Smart dark's colours (one) and the site's !important ones.
    const css = (["onLight", "onDark"] as const).map((shade) => `[${TEXT_MARKER}="${token}-${shade}"]:not(#awl-none):not(#awl-none) { color: ${TEXT_SHADES[name][shade]} !important; }`).join("\n");
    return setStyleEntry(ctx, "textColor", css, () => {
      stop();
      document.querySelectorAll(`[${TEXT_MARKER}^="${token}-"]`).forEach((element) => element.removeAttribute(TEXT_MARKER));
    });
  },
};

/** Content added later (infinite scroll, SPA renders), handed over in small batches; returns stop(). */
function watchAdded(onBatch: (batch: Element[]) => void): () => void {
  const added = new Set<Element>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const observer = new MutationObserver((records) => {
    for (const record of records) record.addedNodes.forEach((node) => { if (node instanceof Element && !node.matches(SKIP)) added.add(node); });
    if (added.size && !timer) timer = setTimeout(() => {
      timer = null;
      const batch = [...added].flatMap((root) => [root, ...Array.from(root.querySelectorAll("*"))]).slice(0, BATCH_LIMIT);
      added.clear();
      onBatch(batch);
    }, 200);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    if (timer) clearTimeout(timer);
  };
}

export const readabilityOperations: Operation<unknown>[] = [underlineLinks, focusRing, fixContrast, textColor] as Operation<unknown>[];

export function readabilityPlanSteps(prefs: AppearancePrefs, theme: AppearancePrefs["theme"], bodyReady: boolean) {
  return [
    { opId: "underlineLinks", params: { enabled: prefs.underlineLinks } },
    { opId: "focusRing", params: { enabled: prefs.focusRing } },
    { opId: "fixContrast", params: { enabled: prefs.fixContrast, theme, engine: prefs.engine, bodyReady } },
    // After the theme and the contrast fix, so it reads the colours they leave behind.
    { opId: "textColor", params: { value: prefs.textColor, bodyReady } },
  ];
}
