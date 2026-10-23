import { z } from "zod";
import { registerOperation, type Operation } from "../shared/registry";
import { motionOperations } from "./motionOps";
import { findContentRegion } from "./domUtils";
import { setStyleEntry } from "./styleEntry";
import type { FocusPrefs, MotionPrefs } from "../shared/settings";

const PROTECTED_SELECTOR = "form, input, textarea, select, button, [role='alert'], [role='alertdialog'], [role='dialog'], nav, [role='navigation'], a[href^='#']";
const SIDEBAR_SELECTOR = "aside, [role='complementary'], [class*='sidebar' i], [id*='sidebar' i], [class*='recommend' i], [id*='recommend' i], [class*='advert' i], [id*='advert' i], [class*='sponsor' i]";
const selectorSchema = z.string().min(1).max(512).refine((value) => !/[{};]/.test(value), "Selector contains unsafe CSS characters");

const css = setStyleEntry;

export function isSafeHeuristicCandidate(element: Element): boolean {
  return !element.matches(PROTECTED_SELECTOR) && !element.querySelector(PROTECTED_SELECTOR);
}

function mark(elements: Iterable<Element>, attribute: string, token: string): Array<{ element: Element; prior: string | null }> {
  const marked: Array<{ element: Element; prior: string | null }> = [];
  let index = 0;
  for (const element of elements) {
    marked.push({ element, prior: element.getAttribute(attribute) });
    element.setAttribute(attribute, `${token}-${index++}`);
  }
  return marked;
}
function restore(attribute: string, marked: Array<{ element: Element; prior: string | null }>): void { marked.forEach(({ element, prior }) => { if (prior === null) element.removeAttribute(attribute); else element.setAttribute(attribute, prior); }); }

/** Beside the main content (a sidebar or rail), not above or below it in the same column. */
function beside(element: Element, main: Element): boolean {
  const box = element.getBoundingClientRect();
  const reading = main.getBoundingClientRect();
  // Without layout (no sizes at all), judge by structure alone.
  if (box.width === 0 && reading.width === 0) return true;
  return box.right <= reading.left + 4 || box.left >= reading.right - 4;
}

/** The page title is content: never dimmed or collapsed with the clutter around it. */
const holdsTitle = (element: Element) => element.matches("h1") || element.querySelector("h1") !== null;

/** Blocks beside the main content, from its own siblings up to the page's top level. */
function besideMain(main: Element, root: Document): Element[] {
  const found: Element[] = [];
  for (let child: Element = main, parent = main.parentElement; parent; child = parent, parent = parent.parentElement) {
    for (const sibling of Array.from(parent.children)) {
      if (sibling !== child && beside(sibling, main) && isSafeHeuristicCandidate(sibling) && !holdsTitle(sibling)) found.push(sibling);
    }
    if (parent === root.body) break;
  }
  return found;
}

/** Conservative structural candidates, including sidebars whose class names are unknown. */
export function sidebarCandidates(root: Document = document): Element[] {
  const main = findContentRegion(root);
  const known = Array.from(root.querySelectorAll(SIDEBAR_SELECTOR));
  if (!main) return known.filter(isSafeHeuristicCandidate);
  return [...new Set([...known, ...besideMain(main, root)])].filter((element) => isSafeHeuristicCandidate(element) && !element.contains(main) && !holdsTitle(element));
}

function nonReadingCandidates(root: Document = document): Element[] {
  const main = findContentRegion(root);
  if (!main) return sidebarCandidates(root);
  const landmarks = Array.from(root.querySelectorAll("header, footer, aside, [role='complementary']")).filter((element) => isSafeHeuristicCandidate(element) && !element.contains(main) && !holdsTitle(element));
  return [...new Set([...besideMain(main, root), ...landmarks])];
}

function selectedCss(selectors: string[], declarations = "display: none !important;"): string | null {
  const safe = selectors.filter((selector) => selectorSchema.safeParse(selector).success);
  return safe.length ? `${safe.join(", ")} { ${declarations} }` : null;
}

const DIM_CSS = "opacity: .35 !important; filter: grayscale(.5) !important; transition: none !important;";
const HIGHLIGHT_CSS = "outline: 3px solid #f59e0b !important; outline-offset: 3px !important; background-color: rgba(250, 204, 21, .12) !important; border-radius: 4px;";

const hideElements: Operation<{ selectors: string[] }> = {
  id: "hideElements", label: "Hide selected elements", target: "content-region", protectedElements: PROTECTED_SELECTOR.split(", "),
  paramsSchema: z.object({ selectors: z.array(selectorSchema).max(30) }), validate: () => null,
  apply(ctx, params) { return css(ctx, "hideElements", selectedCss(params.selectors)); },
};
// P07: element plans dim or highlight blocks by selector; marker selectors in
// preview, saved selectors after Apply. Same style-layer entry either way.
const dimElements: Operation<{ selectors: string[] }> = {
  id: "dimElements", label: "Dim selected elements", target: "content-region", protectedElements: [],
  paramsSchema: z.object({ selectors: z.array(selectorSchema).max(30) }), validate: () => null,
  apply(ctx, params) { return css(ctx, "dimElements", selectedCss(params.selectors, DIM_CSS)); },
};
const highlightElements: Operation<{ selectors: string[] }> = {
  id: "highlightElements", label: "Highlight selected elements", target: "content-region", protectedElements: [],
  paramsSchema: z.object({ selectors: z.array(selectorSchema).max(30) }), validate: () => null,
  apply(ctx, params) { return css(ctx, "highlightElements", selectedCss(params.selectors, HIGHLIGHT_CSS)); },
};
const collapseSidebars: Operation<{ enabled: boolean }> = {
  id: "collapseSidebars", label: "Collapse sidebars", target: "content-region", protectedElements: PROTECTED_SELECTOR.split(", "),
  paramsSchema: z.object({ enabled: z.boolean() }), validate: () => null,
  apply(ctx, params) {
    const marked: Array<{ element: Element; prior: string | null }> = [];
    let value: string | null = null;
    if (params.enabled && typeof document !== "undefined") {
      const token = globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36);
      marked.push(...mark(sidebarCandidates(), "data-awl-focus-candidate", token));
      value = `[data-awl-focus-candidate^="${token}-"] { display: none !important; }`;
    }
    return css(ctx, "collapseSidebars", value, () => restore("data-awl-focus-candidate", marked));
  },
};
const dimNonMain: Operation<{ enabled: boolean }> = {
  id: "dimNonMain", label: "Dim non-reading content", target: "content-region", protectedElements: PROTECTED_SELECTOR.split(", "),
  paramsSchema: z.object({ enabled: z.boolean() }), validate: () => null,
  apply(ctx, params) {
    if (!params.enabled || typeof document === "undefined") return css(ctx, "dimNonMain", null);
    const token = globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36);
    const marked = mark(nonReadingCandidates(), "data-awl-dim-target", token);
    return css(ctx, "dimNonMain", `[data-awl-dim-target^="${token}-"] { opacity: .48 !important; }`, () => restore("data-awl-dim-target", marked));
  },
};
const staticifyStickyHeaders: Operation<{ enabled: boolean }> = {
  id: "staticifyStickyHeaders", label: "Make sticky headers static", target: "content-region", protectedElements: PROTECTED_SELECTOR.split(", "),
  paramsSchema: z.object({ enabled: z.boolean() }), validate: () => null,
  apply(ctx, params) {
    if (!params.enabled || typeof document === "undefined") return css(ctx, "staticifyStickyHeaders", null);
    const candidates = Array.from(document.querySelectorAll<HTMLElement>("header, [role='banner'], body *")).filter((element) => {
      if (element.matches(PROTECTED_SELECTOR)) return false;
      const style = getComputedStyle(element); const box = element.getBoundingClientRect();
      return (style.position === "sticky" || style.position === "fixed") && box.top < window.innerHeight * .6 && box.height < 280;
    });
    const token = globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36); const marked = mark(candidates, "data-awl-static-target", token);
    return css(ctx, "staticifyStickyHeaders", `[data-awl-static-target^="${token}-"] { position: static !important; inset: auto !important; top: auto !important; bottom: auto !important; }`, () => restore("data-awl-static-target", marked));
  },
};
export const focusOperations: Operation<unknown>[] = [...[hideElements, dimElements, highlightElements, collapseSidebars, dimNonMain, staticifyStickyHeaders] as Operation<unknown>[], ...motionOperations];
export function registerFocusOps(): void { focusOperations.forEach(registerOperation); }
export function focusPlanSteps(focus: FocusPrefs, motion: MotionPrefs) {
  return [
    { opId: "hideElements", params: { selectors: focus.hiddenSelectors.filter((selector) => !focus.preservedSelectors.includes(selector)) } },
    { opId: "dimElements", params: { selectors: focus.dimSelectors.filter((selector) => !focus.preservedSelectors.includes(selector)) } },
    { opId: "highlightElements", params: { selectors: focus.highlightSelectors } },
    { opId: "collapseSidebars", params: { enabled: focus.collapseSidebars } }, { opId: "dimNonMain", params: { enabled: focus.dimNonMain } }, { opId: "staticifyStickyHeaders", params: { enabled: focus.staticifyStickyHeaders } },
    { opId: "reduceMotion", params: { enabled: motion.reduceMotion } }, { opId: "reduceParallax", params: { enabled: motion.reduceParallax } }, { opId: "pauseAutoplay", params: { enabled: motion.pauseAutoplay } },
  ];
}
export { PROTECTED_SELECTOR, SIDEBAR_SELECTOR };
