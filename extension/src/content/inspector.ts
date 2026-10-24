// ─── Accessibility inspector: deterministic checks (P09) ─────────────────────
// Measures the page as it is shown now, with the user's settings applied, so a
// second run after a fix shows the effect. Budget: at most SCAN_LIMIT
// elements, read in idle-time chunks. All reads come first; the only writes
// are snapshot ids on reported elements and, last, moving keyboard focus to a
// few links and buttons to see whether focus is visible (focus is restored).

import { compositeColor, contrastRatio, parseCssColor, type Color } from "../lib/color";
import { MAX_FINDINGS, type Finding, type Fix, type InspectReport } from "../shared/inspector";
import { longWordShare, wordsOf } from "../shared/syllables";
import { contrastRange, createBackdropResolver, gradientStops, imageLayerOf, requiredContrast, toHex as hex } from "./contrast";
import { getOrAssignId, protectionOf } from "./domSnapshot";
import { PROSE_SELECTOR } from "./domUtils";
import {
  contrastSeverity,
  headingIssues,
  HUGE_BLOCK_CHARS,
  isGlare,
  isLiteralCaps,
  LENS_HUGE_BLOCK_CHARS,
  LONG_SENTENCE_WORDS,
  LONG_WORD_SYLLABLES,
  lineHeightSeverity,
  lineLengthIssue,
  longWordSeverity,
  median,
  MIN_LENS_SENTENCES,
  MIN_LENS_WORDS,
  sentenceLengths,
  sentenceSeverity,
  SMALL_TEXT_PX,
  smallTextSeverity,
  stickySeverity,
  styledShareSeverity,
  TIGHT_LINE_HEIGHT,
} from "./inspectorRules";

export const SCAN_LIMIT = 4000;
const CHUNK_SIZE = 300;
const MAX_CONTRAST_GROUPS = 6;
const FOCUS_SAMPLES = 8;
const IGNORE = "script, style, noscript, template, [data-awl-overlay], [data-awl-picker]";
const CODE = "pre, code, kbd, samp";
const TEXT_BLOCKS = "p, li, dd, td, blockquote, figcaption";
const NAVIGATION = "nav, [role='navigation']";

export interface InspectOptions {
  /** Main content region: typography fixes only reach text inside it. */
  region: Element;
  /** Current value of every AI settings field on this site (fixes are only offered when they change something). */
  current: Record<string, string | number | boolean>;
  /** Smart colours already fix contrast, so no contrast fix is offered with them. */
  smartColours: boolean;
  limit?: number;
  /** Move keyboard focus to a few controls to check the focus indicator (restored afterwards). */
  testFocus?: boolean;
  /** P11: also check through the dyslexia lens (stricter wall-of-text threshold). */
  lens?: boolean;
}

interface Measured { element: Element; style: CSSStyleDeclaration; rect: DOMRect; ownText: number }

/** A finding before it gets an id; `element` becomes its highlight ref, `hide` a hide fix. */
type Draft = Omit<Finding, "id" | "elementRef" | "label" | "suggestedFix"> & { element?: Element; fix?: Omit<Fix, "hide"> & { hide?: Element[] } };

const px = (value: string): number => Number.parseFloat(value) || 0;
const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const sum = (items: readonly Measured[]) => items.reduce((total, item) => total + item.ownText, 0);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function ownTextLength(element: Element): number {
  let length = 0;
  for (const node of Array.from(element.childNodes)) if (node.nodeType === 3) length += (node.textContent ?? "").replace(/\s+/g, " ").trim().length;
  return length;
}

function labelOf(element: Element): string {
  const text = ((element as HTMLElement).innerText ?? element.textContent ?? "").replace(/\s+/g, " ").trim();
  const tag = element.tagName.toLowerCase();
  return text ? `${tag} “${text.length > 50 ? `${text.slice(0, 49)}…` : text}”` : tag;
}

const idle = (): Promise<void> => new Promise((resolve) => {
  const request = (globalThis as { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
  if (request) request(() => resolve(), { timeout: 50 }); else setTimeout(resolve, 0);
});

/** Styles and boxes of the visible elements among the first `limit`, one chunk per idle period. */
export async function measure(root: Element, limit = SCAN_LIMIT): Promise<{ measured: Measured[]; scanned: number; capped: boolean }> {
  const all = root.querySelectorAll("*");
  const scanned = Math.min(all.length, limit);
  const measured: Measured[] = [];
  for (let start = 0; start < scanned; start += CHUNK_SIZE) {
    if (start > 0) await idle();
    for (let index = start; index < Math.min(scanned, start + CHUNK_SIZE); index++) {
      const element = all[index];
      if (element.closest(IGNORE)) continue;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      measured.push({ element, style, rect, ownText: ownTextLength(element) });
    }
  }
  return { measured, scanned, capped: all.length > limit };
}

// ── Text size ────────────────────────────────────────────────────────────────
function smallText(measured: readonly Measured[], options: InspectOptions): Draft[] {
  const text = measured.filter((item) => item.ownText >= 20 && !item.element.closest(CODE));
  const small = text.filter((item) => px(item.style.fontSize) < SMALL_TEXT_PX);
  const smallChars = sum(small);
  if (smallChars < 60) return [];
  const smallest = Math.min(...small.map((item) => px(item.style.fontSize)));
  const share = smallChars / Math.max(1, sum(text));
  const severity = smallTextSeverity(smallest, share);
  if (!severity) return [];
  const ref = small.reduce((best, item) => (item.ownText > best.ownText ? item : best));
  const fixable = options.region.contains(ref.element) && ref.element.matches(PROSE_SELECTOR) && Number(options.current.fontSize) < 18;
  return [{
    type: "small-text", severity, confidence: "high",
    title: "Small text",
    detail: `${round(share * 100, 0)}% of the text is under ${SMALL_TEXT_PX}px; the smallest is ${round(smallest)}px (${plural(small.length, "element")}).`,
    evidence: { smallestPx: round(smallest), sharePercent: round(share * 100, 0), elements: small.length },
    element: ref.element,
    ...(fixable
      ? { fix: { changes: { fontSize: 18 }, description: "Set the article text to 18px" } }
      : { advice: "This text is outside the article area the text-size setting reaches; zoom the page (Ctrl and +) to enlarge it." }),
  }];
}

// ── Contrast ─────────────────────────────────────────────────────────────────
function lowContrast(measured: readonly Measured[], options: InspectOptions): Draft[] {
  const backdropOf = createBackdropResolver(window);
  const groups = new Map<string, { ratio: number; required: number; fg: Color; bg: Color; items: Measured[] }>();
  const gradient = { min: Infinity, max: 0, required: 4.5, items: [] as Measured[] };
  for (const item of measured) {
    if (item.ownText < 2 || item.element.closest(CODE)) continue;
    const fg = parseCssColor(item.style.color);
    if (!fg || fg.a === 0) continue;
    const required = requiredContrast(item.style);
    const backdrop = backdropOf(item.element);
    if (backdrop === "image") {
      // Gradients: judge against every colour stop; images (url) cannot be judged at all.
      const layer = imageLayerOf(window, item.element);
      const stops = layer ? gradientStops(layer.style.backgroundImage) : null;
      if (!stops) continue;
      const range = contrastRange(fg, stops);
      if (range.min >= required) continue;
      gradient.min = Math.min(gradient.min, range.min);
      gradient.max = Math.max(gradient.max, range.max);
      if (!gradient.items.length) gradient.required = required;
      gradient.items.push(item);
      continue;
    }
    const ratio = contrastRatio(fg, backdrop);
    if (ratio >= required) continue;
    // Translucent text is reported as the colour it ends up as.
    const shown = fg.a < 1 ? compositeColor(fg, backdrop) : fg;
    const key = `${hex(shown)}|${hex(backdrop)}|${required}`;
    const group = groups.get(key) ?? { ratio, required, fg: shown, bg: backdrop, items: [] };
    group.ratio = Math.min(group.ratio, ratio);
    group.items.push(item);
    groups.set(key, group);
  }
  const canFix = !options.current.fixContrast && !options.smartColours;
  const drafts: Draft[] = [...groups.values()].sort((a, b) => a.ratio - b.ratio).slice(0, MAX_CONTRAST_GROUPS).map((group) => ({
    type: "low-contrast" as const,
    severity: contrastSeverity(group.ratio, group.required) ?? "medium",
    confidence: "high" as const,
    title: "Low-contrast text",
    detail: `${round(group.ratio, 2)}:1 contrast, needs ${group.required}:1 (${hex(group.fg)} on ${hex(group.bg)}, ${plural(group.items.length, "element")}).`,
    evidence: { ratio: round(group.ratio, 2), required: group.required, elements: group.items.length, foreground: hex(group.fg), background: hex(group.bg) },
    element: group.items[0].element,
    ...(canFix
      ? { fix: { changes: { fixContrast: true }, description: "Darken (or lighten) faint text until it is readable" } }
      : { advice: "The contrast fix is already on (or Smart colours are), but this text is inside a control or code the fix leaves alone." }),
  }));
  if (gradient.items.length) {
    drafts.push({
      type: "low-contrast", severity: "medium", confidence: "low",
      title: "Text over a gradient may be hard to read",
      detail: `Contrast is between ${round(gradient.min, 2)}:1 and ${round(gradient.max, 2)}:1 depending on where the text sits; needs ${gradient.required}:1 (${plural(gradient.items.length, "element")}). Uncertain: the background changes under the text.`,
      evidence: { minRatio: round(gradient.min, 2), maxRatio: round(gradient.max, 2), required: gradient.required, elements: gradient.items.length },
      element: gradient.items[0].element,
      advice: "Check it by eye. Dark mode with Smart colours, or hiding the banner, may help.",
    });
  }
  return drafts;
}

// ── Dense text and line length ──────────────────────────────────────────────
function paragraphs(measured: readonly Measured[], options: InspectOptions): Draft[] {
  const drafts: Draft[] = [];
  const shaped = measured.filter((item) => item.element.tagName === "P" && options.region.contains(item.element) && item.ownText >= 80).map((item) => {
    const fontSize = px(item.style.fontSize) || 16;
    const lineHeight = item.style.lineHeight === "normal" ? fontSize * 1.2 : px(item.style.lineHeight) || fontSize * 1.2;
    const height = item.rect.height - px(item.style.paddingTop) - px(item.style.paddingBottom) - px(item.style.borderTopWidth) - px(item.style.borderBottomWidth);
    const lines = Math.max(1, Math.round(height / lineHeight));
    const chars = (item.element.textContent ?? "").replace(/\s+/g, " ").trim().length;
    return { item, ratio: lineHeight / fontSize, lines, chars };
  });
  const multiLine = shaped.filter((paragraph) => paragraph.lines >= 2);

  const tight = multiLine.filter((paragraph) => paragraph.ratio < TIGHT_LINE_HEIGHT);
  if (tight.length) {
    const worst = tight.reduce((best, paragraph) => (paragraph.ratio < best.ratio ? paragraph : best));
    const fixable = Number(options.current.lineHeight) < 1.6;
    drafts.push({
      type: "tight-line-height", severity: lineHeightSeverity(worst.ratio) ?? "medium", confidence: "high",
      title: "Lines packed too tightly",
      detail: `Line height ${round(worst.ratio, 2)}× the text size (comfortable is about 1.5×) in ${plural(tight.length, "paragraph")}.`,
      evidence: { lineHeight: round(worst.ratio, 2), paragraphs: tight.length },
      element: worst.item.element,
      ...(fixable ? { fix: { changes: { lineHeight: 1.6 }, description: "Set line height to 1.6" } } : { advice: "Line height is already raised; this text is outside the article area it reaches." }),
    });
  }

  if (multiLine.length >= 2) {
    const perLine = median(multiLine.map((paragraph) => paragraph.chars / paragraph.lines));
    const issue = lineLengthIssue(perLine, window.innerWidth);
    const regionWidth = Math.round(options.region.getBoundingClientRect().width);
    if (issue?.type === "long-lines") {
      const width = Number(options.current.maxContentWidth);
      const fixable = width > 720;
      drafts.push({
        type: "long-lines", severity: issue.severity, confidence: "high",
        title: "Lines too long to follow",
        detail: `About ${Math.round(perLine)} characters per line (comfortable is 50–90); the text area is ${regionWidth}px wide.`,
        evidence: { charsPerLine: Math.round(perLine), regionWidthPx: regionWidth },
        element: multiLine[0].item.element,
        ...(fixable ? { fix: { changes: { maxContentWidth: 720 }, description: "Narrow the text column to 720px" } } : { advice: "The column width setting is already narrow; this text is outside the area it reaches." }),
      });
    } else if (issue?.type === "narrow-column") {
      drafts.push({
        type: "narrow-column", severity: issue.severity, confidence: "high",
        title: "Very narrow text column",
        detail: `About ${Math.round(perLine)} characters per line in a ${regionWidth}px column on a ${window.innerWidth}px window.`,
        evidence: { charsPerLine: Math.round(perLine), regionWidthPx: regionWidth, windowWidthPx: window.innerWidth },
        element: multiLine[0].item.element,
        advice: "Sidebars may be squeezing the article: try Clean this page, or a wider window.",
      });
    }
  }

  const limit = options.lens ? LENS_HUGE_BLOCK_CHARS : HUGE_BLOCK_CHARS;
  const huge = measured.filter((item) => item.element.tagName === "P" && (item.element.textContent ?? "").length > limit);
  if (huge.length) {
    const longest = huge.reduce((best, item) => ((item.element.textContent ?? "").length > (best.element.textContent ?? "").length ? item : best));
    const chars = (longest.element.textContent ?? "").replace(/\s+/g, " ").trim().length;
    drafts.push({
      type: "huge-block", severity: chars > 2500 || (options.lens && chars > 2 * limit) ? "medium" : "low", confidence: "high",
      title: "Wall of text",
      detail: `${plural(huge.length, "paragraph")} over ${limit} characters; the longest has ${chars}.`,
      evidence: { paragraphs: huge.length, longestChars: chars },
      element: longest.element,
      advice: options.lens
        ? "The Dyslexia reading view (Understand this page) splits it into short paragraphs; TL;DR gives the main points."
        : "Use TL;DR or select the paragraph and choose Explain simply (Understand this page).",
    });
  }
  return drafts;
}

// ── Headings ─────────────────────────────────────────────────────────────────
function headings(doc: Document): Draft[] {
  const list = Array.from(doc.querySelectorAll("h1, h2, h3, h4, h5, h6")).filter((heading) =>
    !heading.closest(`${IGNORE}, [hidden], [aria-hidden='true']`) && getComputedStyle(heading).display !== "none");
  const info = list.map((heading) => ({
    level: Number(heading.tagName[1]),
    empty: !(heading.textContent ?? "").trim() && !heading.querySelector("img[alt]:not([alt=''])"),
  }));
  const titles = { "no-h1": "No main heading (h1)", "multiple-h1": "Several main headings (h1)", "skipped-heading": "Heading levels skipped", "empty-heading": "Empty heading" } as const;
  const advice = {
    "no-h1": "Screen-reader users often jump to the h1 to find where the content starts.",
    "multiple-h1": "Not wrong on its own, but the page outline is less clear.",
    "skipped-heading": "Skipped levels make the outline harder to follow with a screen reader.",
    "empty-heading": "Screen readers announce a heading with nothing in it.",
  } as const;
  return headingIssues(info).map((issue) => ({
    type: issue.type, severity: issue.severity, confidence: "high",
    title: titles[issue.type],
    detail: issue.detail,
    evidence: { headings: info.length, affected: issue.indexes.length },
    element: issue.indexes.length ? list[issue.indexes[0]] : undefined,
    advice: `${advice[issue.type]} Only the site can change its headings.`,
  }));
}

// ── Layout: overflow, clipping, overlap, sticky bars ─────────────────────────
function layout(measured: readonly Measured[], doc: Document, options: InspectOptions): Draft[] {
  const drafts: Draft[] = [];
  const root = doc.documentElement;
  const viewWidth = root.clientWidth || window.innerWidth;
  const viewHeight = window.innerHeight;
  const byElement = new Map(measured.map((item) => [item.element, item]));

  const scrollsSideways = root.scrollWidth > viewWidth + 4 && ![getComputedStyle(root).overflowX, doc.body ? getComputedStyle(doc.body).overflowX : ""].some((value) => value === "hidden" || value === "clip");
  if (scrollsSideways) {
    const right = (item: Measured) => item.rect.right + window.scrollX;
    const culprit = measured.find((item) => {
      if (right(item) <= viewWidth + 4) return false;
      const parent = item.element.parentElement ? byElement.get(item.element.parentElement) : undefined;
      return !parent || right(parent) <= viewWidth + 4;
    });
    drafts.push({
      type: "horizontal-overflow", severity: "medium", confidence: "high",
      title: "Page scrolls sideways",
      detail: `The page is ${root.scrollWidth - viewWidth}px wider than the window${culprit ? `; ${culprit.element.tagName.toLowerCase()} sticks out by ${Math.round(right(culprit) - viewWidth)}px` : ""}.`,
      evidence: { overflowPx: root.scrollWidth - viewWidth },
      element: culprit?.element,
      advice: "Reading means scrolling left and right. A narrower text column or zooming out may help.",
    });
  }

  const clipped = measured.filter((item) => {
    if (item.element === doc.body || item.style.position === "fixed" || !["hidden", "clip"].includes(item.style.overflowY)) return false;
    const element = item.element as HTMLElement;
    return element.clientHeight > 0 && element.scrollHeight > element.clientHeight + 4 && (element.textContent ?? "").trim().length > 40;
  });
  if (clipped.length) {
    const first = clipped[0].element as HTMLElement;
    drafts.push({
      type: "clipped-content", severity: "medium", confidence: "medium",
      title: "Text cut off",
      detail: `${plural(clipped.length, "box")} hide${clipped.length === 1 ? "s" : ""} part of ${clipped.length === 1 ? "its" : "their"} text; the first hides ${first.scrollHeight - first.clientHeight}px.`,
      evidence: { elements: clipped.length, hiddenPx: first.scrollHeight - first.clientHeight },
      element: first,
      advice: "Some boxes clip on purpose (a \"read more\" fold). Larger text can make clipping worse.",
    });
  }

  // Absolutely positioned boxes painted over static text.
  const coverers = measured.filter((item) => item.style.position === "absolute" && item.rect.width * item.rect.height >= 1500 &&
    ((parseCssColor(item.style.backgroundColor)?.a ?? 0) >= 0.5 || /^(IMG|VIDEO|IFRAME|CANVAS)$/.test(item.element.tagName))).slice(0, 40);
  const texts = measured.filter((item) => item.ownText >= 15 && item.style.position === "static" && !item.element.closest(CODE)).slice(0, 2000);
  const covered: Array<{ text: Measured; by: Measured }> = [];
  for (const text of texts) {
    const area = text.rect.width * text.rect.height;
    const by = coverers.find((cover) => {
      if (cover.element.contains(text.element) || text.element.contains(cover.element)) return false;
      const width = Math.min(text.rect.right, cover.rect.right) - Math.max(text.rect.left, cover.rect.left);
      const height = Math.min(text.rect.bottom, cover.rect.bottom) - Math.max(text.rect.top, cover.rect.top);
      return width > 0 && height > 0 && (width * height) / area >= 0.25;
    });
    if (by) covered.push({ text, by });
  }
  if (covered.length) {
    drafts.push({
      type: "overlap", severity: "medium", confidence: "medium",
      title: "Text covered by another element",
      detail: `${plural(covered.length, "text element")} sit${covered.length === 1 ? "s" : ""} under a positioned ${covered[0].by.element.tagName.toLowerCase()}.`,
      evidence: { elements: covered.length },
      element: covered[0].text.element,
      advice: "Part of this text cannot be read. Larger text or a different window size can move it out from under.",
    });
  }

  const bars = measured.filter((item) => (item.style.position === "fixed" || item.style.position === "sticky") && item.rect.width >= viewWidth * 0.5)
    .filter((item) => !measured.some((other) => other !== item && other.element.contains(item.element) && (other.style.position === "fixed" || other.style.position === "sticky")));
  for (const bar of bars.slice(0, 3)) {
    const share = Math.min(bar.rect.height, viewHeight) / viewHeight;
    const severity = stickySeverity(share);
    if (!severity) continue;
    const atTop = bar.style.position === "sticky" ? bar.style.bottom === "auto" : bar.rect.top < viewHeight / 2;
    const unstick = atTop && bar.rect.height < 280 && !options.current.staticifyStickyHeaders;
    const hideable = !unstick && !protectionOf(bar.element) && !bar.element.contains(options.region);
    drafts.push({
      type: "sticky-cover", severity, confidence: "high",
      title: atTop ? "Sticky header covers the page" : "Fixed bar covers the page",
      detail: `A ${bar.style.position} ${bar.element.tagName.toLowerCase()} takes ${Math.round(share * 100)}% of the window height (${Math.round(bar.rect.height)}px) while you scroll.`,
      evidence: { windowSharePercent: Math.round(share * 100), heightPx: Math.round(bar.rect.height) },
      element: bar.element,
      ...(unstick ? { fix: { changes: { staticifyStickyHeaders: true }, description: "Stop headers from following the scroll" } }
        : hideable ? { fix: { changes: {}, hide: [bar.element], description: "Hide this bar on this site" } }
        : { advice: "It contains navigation or a form, so it is not hidden automatically; Clean this page can hide it after you confirm." }),
    });
  }
  return drafts;
}

// ── Links and keyboard focus ─────────────────────────────────────────────────
function linkDistinction(measured: readonly Measured[], options: InspectOptions): Draft[] {
  const hidden = measured.filter((item) => {
    if (!item.element.matches("a[href]") || item.element.closest(NAVIGATION)) return false;
    const block = item.element.parentElement?.closest(TEXT_BLOCKS);
    if (!block) return false;
    const style = item.style;
    if (style.textDecorationLine.includes("underline") || (style.borderBottomStyle !== "none" && px(style.borderBottomWidth) > 0)) return false;
    const blockStyle = getComputedStyle(block);
    if (Math.abs(px(style.fontWeight) - px(blockStyle.fontWeight)) >= 300) return false;
    const link = parseCssColor(style.color);
    const text = parseCssColor(blockStyle.color);
    return Boolean(link && text) && contrastRatio(link!, text!) < 3;
  });
  if (!hidden.length) return [];
  const sample = hidden[0];
  const ratio = contrastRatio(parseCssColor(sample.style.color)!, parseCssColor(getComputedStyle(sample.element.parentElement!.closest(TEXT_BLOCKS)!).color)!);
  return [{
    type: "link-distinction", severity: hidden.length >= 5 ? "high" : "medium", confidence: "high",
    title: "Links look like plain text",
    detail: `${plural(hidden.length, "link")} in the text ${hidden.length === 1 ? "has" : "have"} no underline and only ${round(ratio, 2)}:1 colour difference from the text around ${hidden.length === 1 ? "it" : "them"} (needs 3:1).`,
    evidence: { links: hidden.length, colourRatio: round(ratio, 2) },
    element: sample.element,
    ...(!options.current.underlineLinks ? { fix: { changes: { underlineLinks: true }, description: "Underline links in the text" } } : { advice: "Underlining is on, but these links are outside running text." }),
  }];
}

const FOCUS_PROPERTIES = ["outlineStyle", "outlineWidth", "outlineColor", "boxShadow", "borderTopColor", "borderBottomColor", "backgroundColor", "color", "textDecorationLine"] as const;

function looksFocused(before: Record<string, string>, after: CSSStyleDeclaration): boolean {
  if (after.outlineStyle !== "none" && px(after.outlineWidth) > 0) return true;
  return FOCUS_PROPERTIES.some((property) => !property.startsWith("outline") && before[property] !== after[property]);
}

/** Rules in readable stylesheets that remove the focus outline and add nothing in its place. */
function outlineRemovals(doc: Document): number {
  let count = 0;
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; } // cross-origin sheets cannot be read
    for (const rule of Array.from(rules).slice(0, 3000)) {
      if (!(rule instanceof CSSStyleRule) || !/:focus(?![-\w])/.test(rule.selectorText)) continue;
      const style = rule.style;
      const removes = style.outlineStyle === "none" || style.outlineWidth === "0px" || /^(none|0)$/.test(style.getPropertyValue("outline").trim());
      if (removes && !style.boxShadow && !style.borderColor && !style.backgroundColor && !style.textDecorationLine) count++;
    }
  }
  return count;
}

function focusIndicator(measured: readonly Measured[], doc: Document, options: InspectOptions): Draft[] {
  const controls = measured.filter((item) => item.element.matches("a[href], button:not([disabled])") && !item.element.closest(IGNORE)).slice(0, FOCUS_SAMPLES);
  if (!controls.length) return [];
  let tested = 0;
  const missing: Element[] = [];
  if (options.testFocus !== false) {
    const previous = doc.activeElement as HTMLElement | null;
    for (const { element } of controls) {
      const control = element as HTMLElement;
      const style = getComputedStyle(control);
      const before = Object.fromEntries(FOCUS_PROPERTIES.map((property) => [property, style[property]]));
      control.focus({ preventScroll: true, focusVisible: true } as FocusOptions);
      // Script focus only shows the keyboard indicator when the browser treats it as keyboard-like.
      if (doc.activeElement !== control || !control.matches(":focus-visible")) continue;
      tested++;
      if (!looksFocused(before, getComputedStyle(control))) missing.push(control);
    }
    if (previous && previous !== doc.body && typeof previous.focus === "function") previous.focus({ preventScroll: true });
    else (doc.activeElement as HTMLElement | null)?.blur?.();
  }
  const fix = !options.current.focusRing ? { fix: { changes: { focusRing: true }, description: "Add a clear outline to the focused link or button" } } : { advice: "The focus outline setting is on; these controls draw their own focus style over it." };
  if (tested > 0) {
    if (missing.length === 0 || missing.length / tested < 0.5) return [];
    return [{
      type: "focus-indicator", severity: missing.length === tested ? "high" : "medium", confidence: tested >= 3 ? "high" : "medium",
      title: "No visible keyboard focus",
      detail: `${missing.length} of ${tested} links and buttons checked show no change when they get keyboard focus.`,
      evidence: { checked: tested, missing: missing.length },
      element: missing[0],
      ...fix,
    }];
  }
  // The browser would not show keyboard focus for script focus (e.g. after a mouse click): read the stylesheets instead.
  const removals = outlineRemovals(doc);
  if (!removals) return [];
  return [{
    type: "focus-indicator", severity: "medium", confidence: "medium",
    title: "Focus outline removed",
    detail: `${plural(removals, "style rule")} remove${removals === 1 ? "s" : ""} the focus outline without adding another indicator.`,
    evidence: { rules: removals },
    element: controls[0].element,
    ...fix,
  }];
}


// ── P11: dyslexia lens ───────────────────────────────────────────────────────
const SENTENCE_BLOCKS = "p, li, dd, blockquote";
const MAX_LENS_WORDS = 6000;

/** Body text of the main content: measured elements with real text, outside code and navigation. */
function bodyText(measured: readonly Measured[], options: InspectOptions): Measured[] {
  return measured.filter((item) => item.ownText >= 2 && options.region.contains(item.element) && !item.element.closest(`${CODE}, ${NAVIGATION}`));
}

/** Share of `text` (by characters) that `test` picks, and the element with the most of it. */
function styledShare(text: readonly Measured[], test: (item: Measured) => boolean): { share: number; chars: number; elements: number; top?: Measured } {
  const picked = text.filter(test);
  const chars = sum(picked);
  const top = picked.length ? picked.reduce((best, item) => (item.ownText > best.ownText ? item : best)) : undefined;
  return { share: chars / Math.max(1, sum(text)), chars, elements: picked.length, top };
}

function styleFindings(text: readonly Measured[], options: InspectOptions): Draft[] {
  const drafts: Draft[] = [];
  const percent = (share: number) => Math.round(share * 100);
  const justified = styledShare(text, (item) => /^justify/.test(item.style.textAlign));
  const justifiedLevel = justified.chars >= 200 ? styledShareSeverity(justified.share) : null;
  if (justifiedLevel && justified.top) drafts.push({
    type: "justified-text", severity: justifiedLevel, confidence: "high",
    title: "Justified text",
    detail: `${percent(justified.share)}% of the article text is justified, which stretches the gaps between words unevenly (${plural(justified.elements, "element")}).`,
    evidence: { sharePercent: percent(justified.share), elements: justified.elements },
    element: justified.top.element,
    ...(!options.current.unjustify ? { fix: { changes: { unjustify: true }, description: "Left-align the article text" } } : { advice: "Left-aligned text is on; this text is outside the area it reaches." }),
  });
  const italic = styledShare(text, (item) => /^(italic|oblique)/.test(item.style.fontStyle));
  const italicLevel = italic.chars >= 200 ? styledShareSeverity(italic.share) : null;
  if (italicLevel && italic.top) drafts.push({
    type: "italic-body", severity: italicLevel, confidence: "high",
    title: "Body text in italics",
    detail: `${percent(italic.share)}% of the article text is italic; slanted letters read slowest for many readers (${plural(italic.elements, "element")}).`,
    evidence: { sharePercent: percent(italic.share), elements: italic.elements },
    element: italic.top.element,
    ...(!options.current.noItalics ? { fix: { changes: { noItalics: true }, description: "Show italic text upright (emphasis stays semi-bold)" } } : { advice: "Upright text is on; this text is outside the area it reaches." }),
  });
  const styledCaps = styledShare(text, (item) => item.style.textTransform === "uppercase" && item.ownText >= 20);
  const capsLevel = styledCaps.chars >= 60 ? styledShareSeverity(styledCaps.share, 0.03) : null;
  if (capsLevel && styledCaps.top) drafts.push({
    type: "all-caps-text", severity: capsLevel, confidence: "high",
    title: "Text styled in capitals",
    detail: `${percent(styledCaps.share)}% of the article text is shown in ALL CAPS by the site's style (${plural(styledCaps.elements, "element")}); capitals hide word shapes.`,
    evidence: { sharePercent: percent(styledCaps.share), elements: styledCaps.elements, styled: 1 },
    element: styledCaps.top.element,
    ...(!options.current.noAllCaps ? { fix: { changes: { noAllCaps: true }, description: "Show capitalised text in normal case" } } : { advice: "Normal case is on; this text is outside the area it reaches." }),
  });
  const typedCaps = text.filter((item) => item.style.textTransform !== "uppercase" && isLiteralCaps(ownTextOf(item.element)));
  if (typedCaps.length) drafts.push({
    type: "all-caps-text", severity: "medium", confidence: "high",
    title: "Text typed in capitals",
    detail: `${plural(typedCaps.length, "passage")} ${typedCaps.length === 1 ? "is" : "are"} typed in capital letters, so a style setting cannot change ${typedCaps.length === 1 ? "it" : "them"}.`,
    evidence: { elements: typedCaps.length, styled: 0 },
    element: typedCaps[0].element,
    advice: "The page's own text is never rewritten. Select it and choose Explain simply, or use the Dyslexia reading view, to read it in normal case.",
  });
  return drafts;
}

function ownTextOf(element: Element): string {
  return Array.from(element.childNodes).filter((node) => node.nodeType === 3).map((node) => node.textContent ?? "").join(" ");
}

function languageFindings(options: InspectOptions): Draft[] {
  const blocks = Array.from(options.region.querySelectorAll(SENTENCE_BLOCKS)).filter((block) =>
    !block.closest(`${CODE}, ${NAVIGATION}, ${IGNORE}`) && !block.parentElement?.closest(SENTENCE_BLOCKS)).slice(0, 400);
  const texts = blocks.map((block) => ((block as HTMLElement).innerText ?? block.textContent ?? "").replace(/\s+/g, " ").trim()).filter((text) => text.length >= 20);
  const drafts: Draft[] = [];
  const lengths = texts.flatMap(sentenceLengths);
  const typical = median(lengths);
  const sentenceLevel = lengths.length >= MIN_LENS_SENTENCES ? sentenceSeverity(typical) : null;
  if (sentenceLevel) {
    const longest = blocks[texts.findIndex((text) => Math.max(...sentenceLengths(text)) === Math.max(...lengths))] ?? blocks[0];
    drafts.push({
      type: "long-sentences", severity: sentenceLevel, confidence: "high",
      title: "Long sentences",
      detail: `Sentences are ${Math.round(typical)} words long on average (median of ${lengths.length}); over ${LONG_SENTENCE_WORDS} is hard to hold in mind.`,
      evidence: { medianWords: Math.round(typical), sentences: lengths.length, longest: Math.max(...lengths) },
      element: longest,
      advice: "The Dyslexia reading view (Understand this page) splits long sentences without changing the facts; the page itself is never rewritten.",
    });
  }
  const words = texts.flatMap(wordsOf).slice(0, MAX_LENS_WORDS);
  if (words.length >= MIN_LENS_WORDS) {
    const share = longWordShare(words, LONG_WORD_SYLLABLES);
    const level = longWordSeverity(share);
    if (level) drafts.push({
      type: "long-words", severity: level, confidence: "medium",
      title: "Many long words",
      detail: `${Math.round(share * 100)}% of ${words.length} words have ${LONG_WORD_SYLLABLES} or more syllables (everyday English has about 3–5%). Syllables are counted with English hyphenation patterns, so a few are off by one.`,
      evidence: { sharePercent: Math.round(share * 100), words: words.length },
      element: blocks[0],
      advice: "Select a passage and choose Explain simply, or use the Dyslexia reading view; syllable marks arrive with the reading aids.",
    });
  }
  return drafts;
}

function glare(text: readonly Measured[], options: InspectOptions): Draft[] {
  const backdropOf = createBackdropResolver(window);
  const glaring = text.filter((item) => {
    const fg = parseCssColor(item.style.color);
    const bg = backdropOf(item.element);
    return Boolean(fg) && fg!.a >= 0.95 && bg !== "image" && isGlare(bg, fg!);
  });
  const share = sum(glaring) / Math.max(1, sum(text));
  if (glaring.length === 0 || share < 0.5 || sum(glaring) < 200) return [];
  const theme = String(options.current.theme ?? "light");
  const canTint = options.current.backgroundTint === "none" && theme !== "dark";
  return [{
    type: "glare", severity: share >= 0.8 ? "medium" : "low", confidence: "high",
    title: "Black text on bright white",
    detail: `${Math.round(share * 100)}% of the article text is pure black on pure white, which many readers find glaring.`,
    evidence: { sharePercent: Math.round(share * 100), background: "#ffffff", text: "#000000" },
    element: glaring[0].element,
    ...(canTint ? { fix: { changes: { backgroundTint: "cream" }, description: "Use a soft cream background (text stays at least 7:1)" } } : { advice: "A background tint is already set, or dark mode is on." }),
  }];
}

function dyslexiaLens(measured: readonly Measured[], options: InspectOptions): Draft[] {
  const text = bodyText(measured, options);
  return [...styleFindings(text, options), ...languageFindings(options), ...glare(text, options)];
}

/** Run every check; returns findings with ids, highlight refs and fixes in snapshot-id form. */
export async function inspectPage(doc: Document, options: InspectOptions): Promise<InspectReport> {
  const started = performance.now();
  const body = doc.body;
  const lens = options.lens === true;
  if (!body) return { findings: [], scanned: 0, capped: false, durationMs: 0, lens };
  const { measured, scanned, capped } = await measure(body, options.limit ?? SCAN_LIMIT);
  const drafts = [
    ...smallText(measured, options),
    ...lowContrast(measured, options),
    ...paragraphs(measured, options),
    ...headings(doc),
    ...layout(measured, doc, options),
    ...linkDistinction(measured, options),
    ...(lens ? dyslexiaLens(measured, options) : []),
    // Last: it moves keyboard focus, which may restyle the page.
    ...focusIndicator(measured, doc, options),
  ].slice(0, MAX_FINDINGS);
  const counts = new Map<string, number>();
  const findings: Finding[] = drafts.map(({ element, fix, ...draft }) => {
    const index = (counts.get(draft.type) ?? 0) + 1;
    counts.set(draft.type, index);
    const suggestedFix: Fix | undefined = fix ? { changes: fix.changes, hide: (fix.hide ?? []).map(getOrAssignId), description: fix.description } : undefined;
    return {
      ...draft,
      id: `${draft.type}-${index}`,
      ...(element ? { elementRef: getOrAssignId(element), label: labelOf(element).slice(0, 120) } : {}),
      ...(suggestedFix ? { suggestedFix } : {}),
    };
  });
  return { findings, scanned, capped, durationMs: Math.round(performance.now() - started), lens };
}

