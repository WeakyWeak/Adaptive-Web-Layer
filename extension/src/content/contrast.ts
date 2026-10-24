// ─── Text contrast measurement ───────────────────────────────────────────────
// Shared by the Smart palette, the low-contrast fix and the inspector. The
// colour behind an element is found by compositing translucent backgrounds up
// the tree; an image or gradient behind it makes the answer uncertain.

import { compositeColor, contrastRatio, parseCssColor, type Color } from "../lib/color";

export const WHITE: Color = { r: 255, g: 255, b: 255, a: 1 };

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

export type Backdrop = Color | "image";

export interface BackdropOptions {
  /** What shows behind a page that paints no background. */
  canvas?: Color;
  /** A background colour to use instead of the computed one (Smart's pending recolours). */
  override?: (element: Element) => Color | null | undefined;
}

/** A memoised resolver: the opaque colour behind an element's content, or "image". */
export function createBackdropResolver(win: Window, options: BackdropOptions = {}): (element: Element | null) => Backdrop {
  const canvas = options.canvas ?? WHITE;
  const memo = new Map<Element, Backdrop>();
  const resolve = (element: Element | null): Backdrop => {
    if (!element) return canvas;
    const known = memo.get(element);
    if (known) return known;
    let style: CSSStyleDeclaration | null = null;
    try { style = win.getComputedStyle(element); } catch { /* detached */ }
    const own = options.override?.(element) ?? (style ? parseCssColor(style.backgroundColor) : null);
    let result: Backdrop;
    if (style && coversWithImage(element, style)) result = "image";
    else if (own && own.a > 0) {
      const below = own.a < 1 ? resolve(element.parentElement) : own;
      result = below === "image" ? "image" : own.a < 1 ? compositeColor(own, below) : own;
    } else result = resolve(element.parentElement);
    memo.set(element, result);
    return result;
  };
  return resolve;
}

/** WCAG AA: 3:1 for large text (24px, or 18.66px bold), 4.5:1 otherwise. */
export function requiredContrast(style: Pick<CSSStyleDeclaration, "fontSize" | "fontWeight">): number {
  const size = Number.parseFloat(style.fontSize) || 16;
  const weight = style.fontWeight === "bold" ? 700 : Number.parseFloat(style.fontWeight) || 400;
  return size >= 24 || (weight >= 700 && size >= 18.66) ? 3 : 4.5;
}

/** Colour stops of a gradient-only background (no url() images); null otherwise. */
export function gradientStops(backgroundImage: string): Color[] | null {
  if (!backgroundImage.includes("gradient(") || backgroundImage.includes("url(")) return null;
  const stops = (backgroundImage.match(/(?:rgba?|hsla?)\([^)]*\)|#[\da-f]{3,8}\b|\b(?:white|black|transparent|gr[ae]y|red)\b/gi) ?? [])
    .map(parseCssColor)
    .filter((color): color is Color => color !== null);
  return stops.length ? stops : null;
}

/** The nearest element (self or ancestor) whose image or gradient lies behind `element`. */
export function imageLayerOf(win: Window, element: Element): { element: Element; style: CSSStyleDeclaration } | null {
  for (let current: Element | null = element; current; current = current.parentElement) {
    let style: CSSStyleDeclaration;
    try { style = win.getComputedStyle(current); } catch { return null; }
    if (coversWithImage(current, style)) return { element: current, style };
  }
  return null;
}

/** Contrast of `foreground` over each colour (translucent ones over white); lowest and highest. */
export function contrastRange(foreground: Color, backgrounds: readonly Color[]): { min: number; max: number } {
  const ratios = backgrounds.map((background) => contrastRatio(foreground, background.a < 1 ? compositeColor(background, WHITE) : background));
  return { min: Math.min(...ratios), max: Math.max(...ratios) };
}

/** "#rrggbb" for an opaque colour. */
export function toHex(color: Color): string {
  return `#${[color.r, color.g, color.b].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The text colour to use on `background` for at least `minimum`:1 contrast:
 * `preferred` when it already passes, otherwise `preferred` darkened (or
 * lightened, on a dark background) step by step until it does.
 */
export function readableTextOn(background: Color, minimum = 7, preferred: Color = { r: 34, g: 34, b: 34, a: 1 }): Color {
  const toward = contrastRatio({ r: 0, g: 0, b: 0, a: 1 }, background) >= contrastRatio({ r: 255, g: 255, b: 255, a: 1 }, background) ? 0 : 255;
  let color = { ...preferred, a: 1 };
  for (let step = 0; step < 20 && contrastRatio(color, background) < minimum; step++) {
    const mix = (channel: number) => channel + (toward - channel) * 0.25;
    color = { r: mix(color.r), g: mix(color.g), b: mix(color.b), a: 1 };
  }
  return contrastRatio(color, background) >= minimum ? color : { r: toward, g: toward, b: toward, a: 1 };
}
