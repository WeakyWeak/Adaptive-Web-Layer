import { compositeColor, contrastRatio, parseCssColor, relativeLuminance, type Color } from "../lib/color";
import { APPEARANCE_PRESERVE_SELECTOR } from "./appearancePreserve";

export type SmartTheme = "light" | "dark";

export interface SmartColorChanges {
  backgroundColor?: string;
  color?: string;
}

const WHITE: Color = { r: 255, g: 255, b: 255, a: 1 };
// What shows behind a page that paints no background, once the theme sets color-scheme.
const CANVAS: Record<SmartTheme, Color> = { light: WHITE, dark: { r: 18, g: 18, b: 18, a: 1 } };
// Text colours in order of preference; the other theme's are the fallback for
// backgrounds Smart leaves alone (a mid-tone brand header, say).
const TEXT: Record<SmartTheme, string[]> = { light: ["#202124", "#000000"], dark: ["#e8eaed", "#ffffff"] };
const LINK: Record<SmartTheme, string> = { light: "#1a5fb4", dark: "#8ab4f8" };
/** WCAG AA for body text. Text at or above it keeps the site's colour. */
const MIN_CONTRAST = 4.5;
const INITIAL_LIMIT = 2500;
const BATCH_LIMIT = 600;
// A class change re-reads the element's subtree only when it is this small
// (a header turning solid on scroll); on <body> it re-reads just the element.
const RESTYLE_SUBTREE_LIMIT = 200;
const MARKER = "data-awl-smart-target";
const IGNORED = "style[data-awl], [data-awl-overlay], [data-awl-picker]";

export function mapSmartBackground(background: Color, theme: SmartTheme): string | undefined {
  if (background.a === 0) return undefined;
  const luminance = relativeLuminance(background);
  if (theme === "light" && luminance < 0.42) return luminance < 0.12 ? "#ffffff" : luminance < 0.28 ? "#fafafa" : "#f1f3f4";
  if (theme === "dark" && luminance > 0.55) return luminance > 0.9 ? "#202124" : luminance > 0.72 ? "#292a2d" : "#35363a";
  return undefined;
}

/**
 * A readable text colour for `background`, or undefined to keep `foreground`.
 * Chosen by contrast against the background the text will really sit on, so
 * light text never lands on a light block Smart did not darken (or vice versa).
 */
export function pickTextColor(foreground: Color, background: Color, theme: SmartTheme, link = false): string | undefined {
  const current = contrastRatio(foreground, background);
  if (current >= MIN_CONTRAST) return undefined;
  const other: SmartTheme = theme === "dark" ? "light" : "dark";
  let best: { value: string; contrast: number } | undefined;
  for (const value of [...(link ? [LINK[theme]] : []), ...TEXT[theme], ...TEXT[other]]) {
    const contrast = contrastRatio(parseCssColor(value)!, background);
    if (contrast >= MIN_CONTRAST) return value;
    if (!best || contrast > best.contrast) best = { value, contrast };
  }
  return best && best.contrast > current ? best.value : undefined;
}

/** Background + text changes for one element over an opaque `background` (used by tests and tools). */
export function mapSmartColors(background: string, foreground: string, theme: SmartTheme): SmartColorChanges {
  const bg = parseCssColor(background);
  const fg = parseCssColor(foreground);
  if (!bg || !fg) return {};
  const backgroundColor = mapSmartBackground(bg, theme);
  const color = pickTextColor(fg, backgroundColor ? parseCssColor(backgroundColor)! : opaque(bg), theme);
  return { ...(backgroundColor ? { backgroundColor } : {}), ...(color ? { color } : {}) };
}

/**
 * True when an image or gradient fills the element, so the colour under its
 * text is unknown. Thin layers (underline gradients, small icons) do not count.
 */
export function coversWithImage(element: Element, style: CSSStyleDeclaration): boolean {
  const image = style.backgroundImage;
  if (!image || image === "none") return false;
  const size = (style.backgroundSize || "auto").split(",")[0];
  if (/\b[0-3]?\d(\.\d+)?px\b/.test(size)) return false;
  if (image.includes("gradient(") || /cover|contain/.test(size)) return true;
  const box = element.getBoundingClientRect();
  return box.width >= 200 && box.height >= 60;
}

type Backdrop = Color | "image";

export interface SmartPalette {
  /** Current rules for every marked element. */
  css(): string;
  /** Stop watching the page and remove every marker. */
  stop(): void;
}

/**
 * Recolours the page for `theme` and keeps doing so for content added or
 * restyled later (SPA renders, headers that change class on scroll).
 * `onChange` receives the new rules whenever a later batch changes them.
 */
export function createSmartPalette(doc: Document, theme: SmartTheme, onChange?: (css: string) => void): SmartPalette {
  const win = doc.defaultView;
  const body = doc.body;
  const rules = new Map<string, { element: Element; previous: string | null; declarations: string }>();
  if (!win || !body) return { css: () => "", stop: () => undefined };
  const token = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let index = 0;

  /** Drop an element's rule and marker; returns what it had, so an unchanged result can keep it. */
  const unmark = (element: Element) => {
    const value = element.getAttribute(MARKER);
    const entry = value ? rules.get(value) : undefined;
    if (!entry) return undefined;
    rules.delete(value!);
    if (entry.previous === null) element.removeAttribute(MARKER); else element.setAttribute(MARKER, entry.previous);
    return { value: value!, entry };
  };
  type Previous = NonNullable<ReturnType<typeof unmark>>;

  /** Read every element first, then mark: one style recalculation per batch. */
  const run = (elements: Element[], before = new Map<Element, Previous>()) => {
    const pending = new Map<Element, Color>();
    const memo = new Map<Element, Backdrop>();
    const backdropOf = (element: Element | null): Backdrop => {
      if (!element) return CANVAS[theme];
      const known = memo.get(element);
      if (known) return known;
      let result: Backdrop;
      let style: CSSStyleDeclaration | null = null;
      try { style = win.getComputedStyle(element); } catch { /* detached */ }
      const own = pending.get(element) ?? (style ? parseCssColor(style.backgroundColor) : null);
      if (style && coversWithImage(element, style)) result = "image";
      else if (own && own.a > 0) {
        const below = own.a < 1 ? backdropOf(element.parentElement) : own;
        result = below === "image" ? "image" : own.a < 1 ? compositeColor(own, below) : own;
      } else result = backdropOf(element.parentElement);
      memo.set(element, result);
      return result;
    };

    const changes: Array<{ element: Element; declarations: string }> = [];
    for (const element of elements) {
      if (!element.isConnected || element.closest(APPEARANCE_PRESERVE_SELECTOR) || element.closest(IGNORED)) continue;
      let style: CSSStyleDeclaration;
      try { style = win.getComputedStyle(element); } catch { continue; }
      const own = parseCssColor(style.backgroundColor);
      const backgroundColor = own && !coversWithImage(element, style) ? mapSmartBackground(own, theme) : undefined;
      if (backgroundColor) pending.set(element, parseCssColor(backgroundColor)!);
      const backdrop = backdropOf(element);
      const fg = parseCssColor(style.color);
      // Over an image the site chose the text colour for that image; keep it.
      const color = fg && backdrop !== "image" ? pickTextColor(fg, backdrop, theme, element.tagName === "A") : undefined;
      if (!backgroundColor && !color) continue;
      changes.push({ element, declarations: [
        backgroundColor ? `background-color: ${backgroundColor} !important;` : "",
        color ? `color: ${color} !important;` : "",
      ].filter(Boolean).join(" ") });
    }
    for (const { element, declarations } of changes) {
      const old = before.get(element);
      // Same colours as last time: keep the marker, so the stylesheet text does not change.
      const value = old?.entry.declarations === declarations ? old.value : `${token}-${index++}`;
      rules.set(value, { element, previous: element.getAttribute(MARKER), declarations });
      element.setAttribute(MARKER, value);
    }
  };

  run([doc.documentElement, body, ...Array.from(body.querySelectorAll("*"))].slice(0, INITIAL_LIMIT));

  const css = () => Array.from(rules, ([value, entry]) => `[${MARKER}="${value}"] { ${entry.declarations} }`).join("\n");
  let lastCss = css();
  const roots = new Map<Element, "added" | "restyled">();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    const batch: Element[] = [];
    for (const [root, kind] of roots) {
      if (!root.isConnected || [...roots.keys()].some((other) => other !== root && other.contains(root))) continue;
      const subtree = [root, ...Array.from(root.querySelectorAll("*"))];
      batch.push(...(subtree.length > (kind === "added" ? BATCH_LIMIT : RESTYLE_SUBTREE_LIMIT) ? [root] : subtree));
      if (batch.length >= BATCH_LIMIT) break;
    }
    roots.clear();
    const elements = [...new Set(batch)].slice(0, BATCH_LIMIT);
    // Re-read restyled elements without the colours Smart gave them last time.
    const before = new Map<Element, Previous>();
    for (const element of elements) {
      const previous = unmark(element);
      if (previous) before.set(element, previous);
    }
    run(elements, before);
    const next = css();
    if (next !== lastCss) { lastCss = next; onChange?.(next); }
  };
  const observer = onChange && typeof MutationObserver !== "undefined" ? new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes" && record.target instanceof Element && !roots.has(record.target)) roots.set(record.target, "restyled");
      record.addedNodes.forEach((node) => { if (node instanceof Element && !node.matches(IGNORED)) roots.set(node, "added"); });
    }
    if (roots.size && !timer) timer = setTimeout(flush, 100);
  }) : null;
  observer?.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });

  return {
    css,
    stop() {
      observer?.disconnect();
      if (timer) clearTimeout(timer);
      timer = null;
      for (const { element } of [...rules.values()]) unmark(element);
    },
  };
}

function opaque(color: Color): Color {
  return color.a < 1 ? compositeColor(color, WHITE) : color;
}
