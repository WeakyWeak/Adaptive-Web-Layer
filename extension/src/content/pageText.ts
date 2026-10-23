// ─── Main-content text for comprehension jobs ────────────────────────────────
// Reads prose blocks inside the content region only. Code blocks (<pre>) are
// skipped; inline code is wrapped in CODE_START/CODE_END so masking turns it
// into one placeholder. Navigation, sidebars, forms, hidden text and the
// extension's own UI are left out.

import { CODE_END, CODE_START } from "../shared/textMask";
import { getContentRegionSelector } from "./domUtils";

export const BLOCK_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, figcaption, td, th, summary";
const SKIP_SELECTOR = "pre, script, style, noscript, template, nav, aside, form, button, select, textarea, [hidden], [aria-hidden='true'], [data-awl-overlay], [data-awl-picker]";
const SKIP_INLINE = "script, style, noscript, template, textarea, select, button, [hidden], [aria-hidden='true'], [data-awl-overlay]";
const CODE_SELECTOR = "pre, code, kbd, samp, var";
export const MAX_PAGE_CHARS = 200_000;

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();
const noMarks = (text: string) => text.replace(/[]/g, "");

/** Text of a node, with code wrapped in markers and skipped parts left out. */
export function textWithCode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return noMarks((node as Text).data);
  if (node instanceof Element) {
    if (node.matches(CODE_SELECTOR)) return `${CODE_START}${noMarks(node.textContent ?? "")}${CODE_END}`;
    if (node.matches(SKIP_INLINE)) return "";
    if (node.tagName === "BR") return " ";
  } else if (!(node instanceof DocumentFragment)) {
    return "";
  }
  return Array.from(node.childNodes, textWithCode).join("");
}

function visible(element: Element): boolean {
  const check = (element as Element & { checkVisibility?: () => boolean }).checkVisibility;
  return typeof check === "function" ? check.call(element) : true;
}

export function contentRoot(): Element {
  return document.querySelector(getContentRegionSelector(false)) ?? document.body;
}

export function extractPageText(root: Element = contentRoot()): { text: string; skippedCode: number } {
  const blocks = Array.from(root.querySelectorAll(BLOCK_SELECTOR)).filter((element) =>
    !element.closest(SKIP_SELECTOR) && !element.querySelector(BLOCK_SELECTOR) && visible(element));
  const paragraphs = blocks.map((element) => collapse(textWithCode(element))).filter(Boolean);
  return { text: paragraphs.join("\n\n").slice(0, MAX_PAGE_CHARS), skippedCode: root.querySelectorAll("pre").length };
}

/** The selected text (code marked) and the paragraph around it, for Define. */
export function selectionText(range: Range): { text: string; context: string } {
  const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const block = start?.closest(BLOCK_SELECTOR);
  return { text: collapse(textWithCode(range.cloneContents())), context: block ? collapse(textWithCode(block)).slice(0, 1500) : "" };
}
