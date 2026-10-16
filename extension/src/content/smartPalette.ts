import { compositeColor, parseCssColor, relativeLuminance, type Color } from "../lib/color";
import { APPEARANCE_PRESERVE_SELECTOR } from "./appearancePreserve";

export type SmartTheme = "light" | "dark";

export interface SmartColorChanges {
  backgroundColor?: string;
  color?: string;
}

const WHITE: Color = { r: 255, g: 255, b: 255, a: 1 };

export function mapSmartColors(background: string, foreground: string, theme: SmartTheme): SmartColorChanges {
  const bg = parseCssColor(background);
  const fg = parseCssColor(foreground);
  if (!bg || !fg) return {};
  const changes: SmartColorChanges = {};
  const bgLuminance = relativeLuminance(bg);
  const fgLuminance = relativeLuminance(fg, bg);

  if (theme === "light" && bg.a > 0 && bgLuminance < 0.42) {
    changes.backgroundColor = bgLuminance < 0.12 ? "#ffffff" : bgLuminance < 0.28 ? "#fafafa" : "#f1f3f4";
  } else if (theme === "dark" && bg.a > 0 && bgLuminance > 0.55) {
    changes.backgroundColor = bgLuminance > 0.9 ? "#202124" : bgLuminance > 0.72 ? "#292a2d" : "#35363a";
  }

  if (theme === "light" && fgLuminance > 0.62) changes.color = "#202124";
  else if (theme === "dark" && fgLuminance < 0.36) changes.color = "#e8eaed";
  return changes;
}

interface MarkedElement { element: Element; previous: string | null }

export interface SmartPaletteResult {
  css: string;
  restore(): void;
}

export function buildSmartPalette(doc: Document, theme: SmartTheme, limit = 2500): SmartPaletteResult {
  const win = doc.defaultView;
  const body = doc.body;
  if (!win || !body) return { css: "", restore: () => undefined };

  const candidates = [doc.documentElement, body, ...Array.from(body.querySelectorAll("*"))].slice(0, limit);
  const marked: MarkedElement[] = [];
  const rules: string[] = [];
  const token = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let index = 0;

  for (const element of candidates) {
    if (element.matches(APPEARANCE_PRESERVE_SELECTOR) || element.closest(APPEARANCE_PRESERVE_SELECTOR)) continue;
    let style: CSSStyleDeclaration;
    try { style = win.getComputedStyle(element); } catch { continue; }

    const background = nearestBackgroundColor(element, body, win) ?? "rgb(255, 255, 255)";
    const changes = mapSmartColors(background, style.color, theme);
    const ownBackground = parseCssColor(style.backgroundColor);
    if (!ownBackground || ownBackground.a === 0) delete changes.backgroundColor;
    if (element.tagName === "A") {
      if (theme === "light" && isLightColor(style.color)) changes.color = "#1a5fb4";
      if (theme === "dark" && isDarkColor(style.color)) changes.color = "#8ab4f8";
    }
    if (!changes.backgroundColor && !changes.color) continue;

    const value = `${token}-${index++}`;
    marked.push({ element, previous: element.getAttribute("data-awl-smart-target") });
    element.setAttribute("data-awl-smart-target", value);
    const declarations = [
      changes.backgroundColor ? `background-color: ${changes.backgroundColor} !important;` : "",
      changes.color ? `color: ${changes.color} !important;` : "",
    ].filter(Boolean).join(" ");
    rules.push(`[data-awl-smart-target="${value}"] { ${declarations} }`);
  }

  return {
    css: rules.join("\n"),
    restore: () => marked.forEach(({ element, previous }) => {
      if (previous === null) element.removeAttribute("data-awl-smart-target");
      else element.setAttribute("data-awl-smart-target", previous);
    }),
  };
}

function nearestBackgroundColor(element: Element, body: HTMLElement, win: Window): string | null {
  let current: Element | null = element;
  while (current) {
    try {
      const color = parseCssColor(win.getComputedStyle(current).backgroundColor);
      if (color && color.a > 0) return toOpaqueCss(color);
    } catch { return null; }
    if (current === body) break;
    current = current.parentElement;
  }
  return "rgb(255, 255, 255)";
}

function toOpaqueCss(color: Color): string {
  const opaque = color.a < 1 ? compositeColor(color, WHITE) : color;
  return `rgb(${Math.round(opaque.r)}, ${Math.round(opaque.g)}, ${Math.round(opaque.b)})`;
}

function isLightColor(value: string): boolean {
  try {
    const color = parseCssColor(value);
    return color !== null && relativeLuminance(color) > 0.62;
  } catch { return false; }
}

function isDarkColor(value: string): boolean {
  try {
    const color = parseCssColor(value);
    return color !== null && relativeLuminance(color) < 0.36;
  } catch { return false; }
}
