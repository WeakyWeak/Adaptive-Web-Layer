import { z } from "zod";
import { registerOperation, type ApplyContext, type ApplyResult, type Operation, type Revert } from "../shared/registry";
import type { FocusPrefs, MotionPrefs } from "../shared/settings";

const PROTECTED_SELECTOR = "form, input, textarea, select, button, [role='alert'], [role='alertdialog'], [role='dialog'], nav, [role='navigation'], a[href^='#']";
const SIDEBAR_SELECTOR = "aside, [role='complementary'], [class*='sidebar' i], [id*='sidebar' i], [class*='recommend' i], [id*='recommend' i], [class*='advert' i], [id*='advert' i], [class*='sponsor' i]";
const selectorSchema = z.string().min(1).max(512).refine((value) => !/[{};]/.test(value), "Selector contains unsafe CSS characters");

function css(ctx: ApplyContext, id: string, value: string | null, restore?: () => void): ApplyResult {
  const previous = ctx.styleLayer.get(id);
  if (value === null) ctx.styleLayer.remove(id); else ctx.styleLayer.set(id, value);
  const revert: Revert = () => { if (previous === undefined) ctx.styleLayer.remove(id); else ctx.styleLayer.set(id, previous); restore?.(); };
  return { ok: true, revert };
}

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

/** Conservative structural candidates, including sidebars whose class names are unknown. */
export function sidebarCandidates(root: Document = document): Element[] {
  const main = root.querySelector("main, article, [role='main']");
  const known = Array.from(root.querySelectorAll(SIDEBAR_SELECTOR));
  if (!main) return known.filter(isSafeHeuristicCandidate);
  const siblings = Array.from(main.parentElement?.children ?? []).filter((element) => element !== main && isSafeHeuristicCandidate(element));
  return [...new Set([...known, ...siblings])].filter((element) => isSafeHeuristicCandidate(element) && !element.contains(main));
}

function nonReadingCandidates(root: Document = document): Element[] {
  const main = root.querySelector("main, article, [role='main']");
  if (!main) return sidebarCandidates(root);
  const directSiblings = Array.from(main.parentElement?.children ?? []).filter((element) => element !== main && isSafeHeuristicCandidate(element));
  const landmarks = Array.from(root.querySelectorAll("header, footer, aside, [role='complementary']")).filter((element) => isSafeHeuristicCandidate(element) && !element.contains(main));
  return [...new Set([...directSiblings, ...landmarks])];
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
const reduceMotion: Operation<{ enabled: boolean }> = {
  id: "reduceMotion", label: "Reduce motion", target: "content-region", protectedElements: [], paramsSchema: z.object({ enabled: z.boolean() }), validate: () => null,
  apply(ctx, params) { return css(ctx, "reduceMotion", params.enabled ? `:root { scroll-behavior: auto !important; } :not(progress):not([role='progressbar']):not([aria-busy='true']), :not(progress):not([role='progressbar']):not([aria-busy='true'])::before, :not(progress):not([role='progressbar']):not([aria-busy='true'])::after { animation: none !important; animation-play-state: paused !important; transition-property: none !important; scroll-behavior: auto !important; } :focus-visible { outline: auto !important; }` : null); },
};
const reduceParallax: Operation<{ enabled: boolean }> = {
  id: "reduceParallax", label: "Reduce parallax", target: "content-region", protectedElements: [], paramsSchema: z.object({ enabled: z.boolean() }), validate: () => null,
  apply(ctx, params) {
    if (!params.enabled || typeof document === "undefined") return css(ctx, "reduceParallax", null);
    const candidates = Array.from(document.querySelectorAll<HTMLElement>("body *")).slice(0, 3000).filter((element) => element.matches(".parallax, [data-parallax], [class*='parallax' i], [class*='scroll' i]") || getComputedStyle(element).backgroundAttachment === "fixed");
    const token = globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36); const marked = mark(candidates, "data-awl-parallax-target", token);
    return css(ctx, "reduceParallax", `[data-awl-parallax-target^="${token}-"] { background-attachment: scroll !important; transform: none !important; }`, () => restore("data-awl-parallax-target", marked));
  },
};
const pauseAutoplay: Operation<{ enabled: boolean }> = {
  id: "pauseAutoplay", label: "Pause autoplay media", target: "content-region", protectedElements: [], paramsSchema: z.object({ enabled: z.boolean() }), validate: () => null,
  apply(ctx, params) {
    const paused = new Set<HTMLMediaElement>(); let lastUserGesture = 0;
    const pause = (node: ParentNode) => { if (node instanceof HTMLMediaElement && node.matches("video[autoplay], audio[autoplay]") && !node.paused) { node.pause(); paused.add(node); } node.querySelectorAll<HTMLMediaElement>("video[autoplay], audio[autoplay]").forEach((media) => { if (!media.paused) { media.pause(); paused.add(media); } }); };
    const gesture = () => { lastUserGesture = Date.now(); };
    const onPlay = (event: Event) => { const media = event.target; if (media instanceof HTMLMediaElement && media.autoplay && Date.now() - lastUserGesture > 1000) { media.pause(); paused.add(media); } };
    let observer: MutationObserver | undefined; let attached = false;
    if (params.enabled && typeof document !== "undefined") { pause(document); document.addEventListener("pointerdown", gesture, true); document.addEventListener("keydown", gesture, true); document.addEventListener("play", onPlay, true); attached = true; observer = new MutationObserver((records) => records.forEach((record) => record.addedNodes.forEach((node) => { if (node instanceof Element) pause(node); }))); observer.observe(document.documentElement, { childList: true, subtree: true }); }
    return css(ctx, "pauseAutoplay", null, () => { observer?.disconnect(); if (attached && typeof document !== "undefined") { document.removeEventListener("pointerdown", gesture, true); document.removeEventListener("keydown", gesture, true); document.removeEventListener("play", onPlay, true); } paused.clear(); });
  },
};

export const focusOperations: Operation<unknown>[] = [hideElements, dimElements, highlightElements, collapseSidebars, dimNonMain, staticifyStickyHeaders, reduceMotion, reduceParallax, pauseAutoplay] as Operation<unknown>[];
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
