// ─── Dyslexia-friendly text shape and background tint (P11) ────────────────
// noItalics, unjustify and noAllCaps change only text the page styles that
// way: computed styles are read once, matching elements are marked, and the
// stylesheet entry restyles the marks (CSS cannot select "italic text").
// backgroundTint repaints white page surfaces in a soft colour and darkens
// text that would fall below 7:1 on it. Protected content (code, media,
// controls) is never marked; text itself is never rewritten.

import { z } from "zod";
import { contrastRatio, parseCssColor, relativeLuminance, type Color } from "../lib/color";
import type { ApplyContext, Operation } from "../shared/registry";
import { BACKGROUND_TINTS, type AppearancePrefs, type BackgroundTint, type TypographyPrefs } from "../shared/settings";
import { coversWithImage, createBackdropResolver, readableTextOn, toHex } from "./contrast";
import { getContentRegionSelector, PROTECTED_SELECTOR } from "./domUtils";
import { clearMarks, hasOwnText, INITIAL_LIMIT, markerToken, SKIP, watchAdded } from "./markers";
import { setStyleEntry } from "./styleEntry";

// bodyReady: marks need the page's elements, so the step changes (and re-applies) once <body> exists.
const enabledSchema = z.object({ enabled: z.boolean(), bodyReady: z.boolean().optional() });
type Classify = (element: Element, style: CSSStyleDeclaration, win: Window) => string | null;

/** The main content element the typography settings reach (or the whole page). */
function regionRoot(ctx: ApplyContext): Element {
  try { return document.querySelector(getContentRegionSelector(ctx.applyToWholePage)) ?? document.body; } catch { return document.body; }
}

/** Mark the elements `classify` picks (reads first, then writes). */
function markAll(win: Window, elements: readonly Element[], attribute: string, token: string, classify: Classify): void {
  const marks: Array<{ element: Element; key: string }> = [];
  for (const element of elements) {
    if (!element.isConnected || element.closest(SKIP) || !hasOwnText(element)) continue;
    let style: CSSStyleDeclaration;
    try { style = win.getComputedStyle(element); } catch { continue; }
    const key = classify(element, style, win);
    if (key) marks.push({ element, key });
  }
  for (const { element, key } of marks) element.setAttribute(attribute, `${token}-${key}`);
}

/**
 * An on/off operation that restyles the text `classify` picks inside the
 * content region; `declarations` maps each mark key to its CSS.
 */
function textShapeOperation(id: string, label: string, classify: Classify, declarations: Record<string, string>): Operation<z.infer<typeof enabledSchema>> {
  const attribute = `data-awl-${id.toLowerCase()}`;
  return {
    id, label, target: "prose", protectedElements: PROTECTED_SELECTOR.split(", "), paramsSchema: enabledSchema, validate: () => null,
    apply(ctx, params) {
      if (!params.enabled || typeof document === "undefined" || !document.body) return setStyleEntry(ctx, id, null);
      const win = window;
      const token = markerToken();
      const root = regionRoot(ctx);
      markAll(win, [root, ...Array.from(root.querySelectorAll("*"))].slice(0, INITIAL_LIMIT), attribute, token, classify);
      const stop = watchAdded((batch) => markAll(win, batch.filter((element) => root.contains(element)), attribute, token, classify));
      // One :not(#…) lifts the rule above a site's own !important text styles.
      const css = Object.entries(declarations).map(([key, value]) => `[${attribute}="${token}-${key}"]:not(#awl-none) { ${value} }`).join("\n");
      return setStyleEntry(ctx, id, css, () => { stop(); clearMarks(attribute, token); });
    },
  };
}

const isItalic = (style: CSSStyleDeclaration) => /^(italic|oblique)/.test(style.fontStyle);

/** Inline italics inside upright text are emphasis: they become semi-bold instead. Whole italic blocks just turn upright. */
export const classifyItalic: Classify = (element, style, win) => {
  if (!isItalic(style)) return null;
  const parent = element.parentElement;
  const parentItalic = parent ? isItalic(win.getComputedStyle(parent)) : false;
  const weight = Number.parseFloat(style.fontWeight) || (style.fontWeight === "bold" ? 700 : 400);
  return style.display.startsWith("inline") && !parentItalic && weight < 600 ? "emph" : "plain";
};

export const classifyJustified: Classify = (_element, style) => (/^justify/.test(style.textAlign) ? "x" : null);
export const classifyUppercase: Classify = (_element, style) => (style.textTransform === "uppercase" ? "x" : null);

const noItalics = textShapeOperation("noItalics", "No italics", classifyItalic, {
  plain: "font-style: normal !important;",
  emph: "font-style: normal !important; font-weight: 600 !important;",
});
const unjustify = textShapeOperation("unjustify", "Left-aligned text", classifyJustified, { x: "text-align: start !important;" });
const noAllCaps = textShapeOperation("noAllCaps", "No ALL CAPS styling", classifyUppercase, { x: "text-transform: none !important;" });

export const textShapeOperations: Operation<unknown>[] = [noItalics, unjustify, noAllCaps] as Operation<unknown>[];

export function textShapePlanSteps(prefs: TypographyPrefs, bodyReady = typeof document !== "undefined" && Boolean(document.body)) {
  return [
    { opId: "noItalics", params: { enabled: prefs.noItalics, bodyReady } },
    { opId: "unjustify", params: { enabled: prefs.unjustify, bodyReady } },
    { opId: "noAllCaps", params: { enabled: prefs.noAllCaps, bodyReady } },
  ];
}

// ─── Background tint ─────────────────────────────────────────────────────────
export const TINT_COLOURS: Record<Exclude<BackgroundTint, "none">, string> = {
  cream: "#fdf6e3",
  peach: "#fde5d0",
  yellow: "#fdf8c8",
  "soft-grey": "#ececec",
};

/** Text colour for each tint, picked for ≥ 7:1 contrast. */
export function tintTextColour(tint: Exclude<BackgroundTint, "none">): string {
  return toHex(readableTextOn(parseCssColor(TINT_COLOURS[tint])!, 7));
}

const chroma = (color: Color) => Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b);

/** A white (or, under sepia, paper-coloured) surface the tint replaces; coloured panels keep their colour. */
export function tintable(color: Color, theme: AppearancePrefs["theme"]): boolean {
  if (color.a < 0.95) return false;
  const light = relativeLuminance(color);
  return (light >= 0.85 && chroma(color) <= 16) || (theme === "sepia" && light >= 0.7 && chroma(color) <= 40);
}

const TINT_MARK = "data-awl-tint";
const TintSchema = z.object({ value: z.enum(BACKGROUND_TINTS), theme: z.enum(["light", "dark", "sepia"]), bodyReady: z.boolean() });

function markTint(win: Window, elements: readonly Element[], token: string, theme: AppearancePrefs["theme"], tint: Color): void {
  const surfaces = new Set<Element>();
  for (const element of elements) {
    if (!element.isConnected || element.closest(SKIP)) continue;
    let style: CSSStyleDeclaration;
    try { style = win.getComputedStyle(element); } catch { continue; }
    const background = parseCssColor(style.backgroundColor);
    if (background && tintable(background, theme) && !coversWithImage(element, style)) surfaces.add(element);
  }
  // Text whose backdrop becomes the tint, and that would be under 7:1 on it, is darkened.
  const backdropOf = createBackdropResolver(win, { override: (element) => (surfaces.has(element) ? tint : undefined) });
  const text: Element[] = [];
  for (const element of elements) {
    if (!element.isConnected || element.closest(`${SKIP}, a[href]`) || !hasOwnText(element)) continue;
    const backdrop = backdropOf(element);
    if (backdrop === "image" || backdrop.r !== tint.r || backdrop.g !== tint.g || backdrop.b !== tint.b) continue;
    const colour = parseCssColor(win.getComputedStyle(element).color);
    if (colour && contrastRatio(colour.a < 1 ? { ...colour, a: 1 } : colour, tint) < 7) text.push(element);
  }
  for (const element of surfaces) element.setAttribute(TINT_MARK, `${token}-bg`);
  for (const element of text) element.setAttribute(TINT_MARK, `${token}-${surfaces.has(element) ? "both" : "text"}`);
}

const backgroundTint: Operation<z.infer<typeof TintSchema>> = {
  id: "backgroundTint", label: "Background tint", target: "content-region", protectedElements: PROTECTED_SELECTOR.split(", "), paramsSchema: TintSchema, validate: () => null,
  apply(ctx, params) {
    // A light-theme variant: dark mode has its own background.
    if (params.value === "none" || params.theme === "dark" || typeof document === "undefined" || !document.body) return setStyleEntry(ctx, "backgroundTint", null);
    const tintHex = TINT_COLOURS[params.value];
    const tint = parseCssColor(tintHex)!;
    const textHex = tintTextColour(params.value);
    const win = window;
    const token = markerToken();
    markTint(win, [document.documentElement, document.body, ...Array.from(document.body.querySelectorAll("*"))].slice(0, INITIAL_LIMIT), token, params.theme, tint);
    const stop = watchAdded((batch) => markTint(win, batch, token, params.theme, tint));
    // The page itself, when it paints no background of its own (the canvas is white).
    const canvas = createBackdropResolver(win)(document.body);
    const pageRule = canvas !== "image" && tintable(canvas, params.theme) ? `html:not(#awl-none) { background-color: ${tintHex} !important; }` : "";
    // Two :not(#…) lift the rules above Sepia's and the Smart palette's own colours.
    const not = ":not(#awl-none):not(#awl-none)";
    const css = [
      pageRule,
      `:is([${TINT_MARK}="${token}-bg"], [${TINT_MARK}="${token}-both"])${not} { background-color: ${tintHex} !important; }`,
      `:is([${TINT_MARK}="${token}-text"], [${TINT_MARK}="${token}-both"])${not} { color: ${textHex} !important; }`,
    ].filter(Boolean).join("\n");
    return setStyleEntry(ctx, "backgroundTint", css, () => { stop(); clearMarks(TINT_MARK, token); });
  },
};

export const tintOperations: Operation<unknown>[] = [backgroundTint] as Operation<unknown>[];

export function tintPlanStep(prefs: AppearancePrefs, theme: AppearancePrefs["theme"], bodyReady: boolean) {
  return { opId: "backgroundTint", params: { value: prefs.backgroundTint, theme, bodyReady } };
}
