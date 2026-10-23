// ─── DOM Snapshot builder (content script side) ───────────────────────────────
// Builds minimal, token-budgeted metadata about the current page for the AI.
// Never includes form values, passwords, or sensitive field content.
// Plans returned by the model reference stable snapshot ids, never selectors.

import { MAX_BLOCKS, type ProtectKind, type SnapshotBlock } from "../shared/elementPlan";
import { type DomSnapshot } from "../shared/plan";
import { getContentRegionSelector, PROTECTED_SELECTOR, proseTotals } from "./domUtils";

// Stable id → element map, so plans can reference elements without selectors.
const _snapshotMap = new Map<string, Element>();
let _snapshotSeq = 0;

function freshId(): string {
  return `s${++_snapshotSeq}`;
}

export function getOrAssignId(el: Element): string {
  // Reuse an id only if this script assigned it to this element: a page could
  // copy data-awl-snap values onto other elements to make ids ambiguous.
  const existing = el.getAttribute("data-awl-snap");
  if (existing && _snapshotMap.get(existing) === el) return existing;
  const id = freshId();
  el.setAttribute("data-awl-snap", id);
  _snapshotMap.set(id, el);
  return id;
}

/** Resolve a snapshot id to a live element, if still present. */
export function resolveSnapshotId(id: string): Element | undefined {
  const el = _snapshotMap.get(id);
  if (!el || !el.isConnected) {
    _snapshotMap.delete(id);
    return undefined;
  }
  return el;
}

// ─── Candidate blocks (P07) ──────────────────────────────────────────────────
const BLOCK_SELECTOR = [
  "main", "nav", "aside", "header", "footer", "dialog", "iframe", "form",
  "section[aria-label]", "section[aria-labelledby]",
  "[role='main']", "[role='navigation']", "[role='banner']", "[role='contentinfo']", "[role='complementary']",
  "[role='dialog']", "[role='alertdialog']", "[role='alert']", "[role='region']", "[role='search']", "[aria-modal='true']",
].join(", ");
const CLUTTER_HINT = /cookie|consent|gdpr|newsletter|subscri|signup|promo|banner|related|recommend|comment|share|social|advert|sponsor|(^|[\s_-])ads?([\s_-]|$)|popup|modal|overlay|(^|[\s_-])toc([\s_-]|$)|contents|sidebar|widget|paywall/i;
const NAVIGATION = "nav, [role='navigation']";
const FORMS = "form, input:not([type='hidden']), select, textarea, [role='search']";
const ALERTS = "[role='alert'], [role='alertdialog'], [aria-live='assertive']";
const DIALOGS = "dialog, [role='dialog'], [role='alertdialog'], [aria-modal='true']";
const FOCUSABLE = "a[href], button, input, select, textarea, [tabindex]";
const SKIP_TEXT = "script, style, noscript, template, textarea, select, option, input, [contenteditable], [data-awl-overlay], [data-awl-picker]";
// Class/id hints are cheap to read, so the whole page is scanned for them;
// computed styles (fixed/sticky) only for the first SCAN_LIMIT elements.
const SCAN_LIMIT = 4000;
const HINT_SCAN_LIMIT = 25_000;
// Widgets that repeat down a page and are safe to hide as a kind. Narrower than
// CLUTTER_HINT: never "toc", "contents", "sidebar", "widget" or "comment".
const SAME_KIND = /^(?:.*[_-])?(?:ad|ads|advert|advertisement|sponsor(?:ed)?|promo|promotion|banner|newsletter|subscribe|signup|cookie|consent|gdpr|related|recommend(?:ed|ations)?|share|sharing|social|popup|modal|overlay|paywall)(?:[_-].*)?$/i;
const MAX_SAME_KIND = 40;
// Only containers can be clutter blocks; a heading or button that happens to
// say "newsletter" is part of a block, not one.
const CONTAINER_TAGS = new Set(["DIV", "SECTION", "ASIDE", "HEADER", "FOOTER", "NAV", "UL", "OL", "FORM", "IFRAME", "DIALOG", "ARTICLE", "FIGURE", "TABLE", "DETAILS", "INS"]);

const IMPLICIT_ROLE: Record<string, string> = { main: "main", nav: "navigation", aside: "complementary", dialog: "dialog", form: "form" };

/** Class/id/aria-label words, lowercased; hash-like tokens are dropped. */
function hintsOf(el: Element): string {
  const raw = [el.id, typeof el.className === "string" ? el.className : "", el.getAttribute("aria-label") ?? ""].join(" ");
  const tokens = raw.toLowerCase().split(/[^a-z0-9_-]+/).filter((token) =>
    token.length >= 2 && token.length <= 24 && /^[a-z]/.test(token) && (token.match(/\d/g)?.length ?? 0) <= 2);
  return [...new Set(tokens)].slice(0, 6).join(" ").slice(0, 80);
}

/** First ~80 visible characters, skipping form fields, scripts and our own UI. */
function textPreview(el: Element, max = 80): string {
  let text = "";
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && text.length < max; node = walker.nextNode()) {
    if (node.parentElement?.closest(SKIP_TEXT)) continue;
    const piece = (node.textContent ?? "").replace(/\s+/g, " ").trim();
    if (piece) text += `${text ? " " : ""}${piece}`;
  }
  return text.slice(0, max);
}

export function protectionOf(el: Element): ProtectKind | undefined {
  const within = (selector: string) => el.matches(selector) || el.querySelector(selector) !== null;
  if (within(NAVIGATION)) return "navigation";
  if (within(FORMS)) return "form";
  if (within(ALERTS)) return "alert";
  if (el.matches(DIALOGS) && el.querySelector(FOCUSABLE)) return "dialog";
  return undefined;
}

function isVisible(style: CSSStyleDeclaration, rect: DOMRect): boolean {
  return style.display !== "none" && style.visibility !== "hidden" && rect.width > 1 && rect.height > 1;
}

/** Parents of four or more siblings that look alike: card grids, link lists. */
function isRepeatedGroup(el: Element): boolean {
  if (el.children.length < 4) return false;
  const counts = new Map<string, number>();
  for (const child of Array.from(el.children)) {
    const key = `${child.tagName}.${child.classList[0] ?? ""}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Math.max(...counts.values()) >= Math.max(4, el.children.length * 0.6);
}

const round = (value: number, digits = 0) => Math.round(value * 10 ** digits) / 10 ** digits;

// ─── Page segmentation (P10) ─────────────────────────────────────────────────
// Every visually distinct block gets a candidate id, whatever its class names,
// so clutter with meaningless classes is still offered to the model. Keyword
// hints only raise a block's rank; the validator, not this list, keeps it safe.
/** A segment covers at least this share of the viewport. */
const MIN_SEGMENT_SHARE = 0.005;
/** A wrapper whose one big child covers this much of it is looked through. */
const WRAPPER_COVER = 0.85;
const MAX_CHILDREN = 12;
const PROSE_TAGS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "DL", "BLOCKQUOTE", "PRE", "TABLE", "HR"]);
// Form controls are part of a block, never a block of their own.
const SKIP_SEGMENT = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "LINK", "META", "BR", "HR", "svg", "SVG", "PATH", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "LABEL", "OPTION", "SUMMARY"]);
const AD_HOSTS = /(doubleclick|googlesyndication|adservice|adnxs|taboola|outbrain|criteo|amazon-adsystem|pubmatic|rubiconproject|adsrvr|ads\.)/i;
const AD_MARKUP = "ins.adsbygoogle, [data-ad], [data-ad-slot], [data-ad-unit], [id^='google_ads'], a[rel~='sponsored']";

interface Viewport { w: number; h: number; area: number }

function viewport(): Viewport {
  const w = Math.max(window.innerWidth, 1);
  const h = Math.max(window.innerHeight, 1);
  return { w, h, area: w * h };
}

function sizable(el: Element, view: Viewport): boolean {
  if (SKIP_SEGMENT.has(el.tagName) || el.closest("[data-awl-overlay], [data-awl-picker]")) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width * rect.height < view.area * MIN_SEGMENT_SHARE) return false;
  const style = getComputedStyle(el);
  return isVisible(style, rect) && style.opacity !== "0";
}

/** Look through wrappers: a block whose single sizable child fills it is that child. */
function unwrap(el: Element, view: Viewport): Element {
  let current = el;
  for (let depth = 0; depth < 12; depth++) {
    const parts = Array.from(current.children).filter((child) => sizable(child, view));
    if (parts.length !== 1) break;
    const outer = current.getBoundingClientRect();
    const inner = parts[0].getBoundingClientRect();
    if (inner.width * inner.height < outer.width * outer.height * WRAPPER_COVER) break;
    current = parts[0];
  }
  return current;
}

/** The visible parts of a block (after looking through wrappers), at most MAX_CHILDREN. */
export function blockParts(el: Element, view: Viewport = viewport()): Element[] {
  return Array.from(unwrap(el, view).children).filter((child) => sizable(child, view)).slice(0, MAX_CHILDREN);
}

function siteOf(hostname: string): string {
  return hostname.split(".").slice(-2).join(".");
}

/** Cross-site frames, ad-network links and ad-slot markup. */
function hasAdSignals(el: Element): boolean {
  const here = siteOf(location.hostname);
  const frames = el.matches("iframe") ? [el] : Array.from(el.querySelectorAll("iframe")).slice(0, 5);
  for (const frame of frames) {
    try {
      const src = new URL(frame.getAttribute("src") ?? "", location.href);
      if (/^https?:$/.test(src.protocol) && (siteOf(src.hostname) !== here || AD_HOSTS.test(src.hostname))) return true;
    } catch { /* srcdoc or invalid src */ }
  }
  if (el.matches(AD_MARKUP) || el.querySelector(AD_MARKUP)) return true;
  return Array.from(el.querySelectorAll("a[href]")).slice(0, 20).some((link) => AD_HOSTS.test((link as HTMLAnchorElement).hostname));
}

/** Segments around the main content: the parts of the page and of each ancestor of main. */
function segmentCandidates(mainEl: Element | null, consider: (el: Element, score: number) => void): void {
  const body = document.body;
  if (!body) return;
  const view = viewport();
  const top = blockParts(body, view);
  for (const part of top) {
    consider(part, 40);
    if (!mainEl || !part.contains(mainEl)) for (const child of blockParts(part, view)) consider(child, 25);
  }
  // Siblings along the path to the main content: sidebars, in-flow banners, rails.
  if (mainEl && mainEl !== body) {
    for (let ancestor = mainEl.parentElement; ancestor && ancestor !== body.parentElement; ancestor = ancestor.parentElement) {
      for (const part of blockParts(ancestor, view)) if (!part.contains(mainEl)) consider(part, 35);
    }
    // Boxes inside the article: comments, in-article promos and sign-up forms.
    // Its prose (paragraphs, headings, lists) is the content, not a candidate.
    for (const part of blockParts(mainEl, view)) if (!PROSE_TAGS.has(part.tagName)) consider(part, 20);
  }
}

function collectBlocks(mainEl: Element | null, budgetTokens: number): SnapshotBlock[] {
  const body = document.body;
  if (!body) return [];

  // Score candidates so the most useful ones survive the cap.
  const scores = new Map<Element, number>();
  const consider = (el: Element, score: number) => scores.set(el, Math.max(scores.get(el) ?? 0, score));
  if (mainEl && mainEl !== body) consider(mainEl, 100);
  document.querySelectorAll(BLOCK_SELECTOR).forEach((el) => consider(el, el.matches(DIALOGS) ? 60 : 30));
  const all = body.querySelectorAll("*");
  for (let index = 0; index < Math.min(all.length, HINT_SCAN_LIMIT); index++) {
    const el = all[index];
    if (!CONTAINER_TAGS.has(el.tagName)) continue;
    if (CLUTTER_HINT.test(hintsOf(el))) consider(el, 50);
    else if (index < SCAN_LIMIT && isRepeatedGroup(el)) consider(el, 15);
    if (index >= SCAN_LIMIT) continue;
    const position = getComputedStyle(el).position;
    if (position === "fixed" || position === "sticky") consider(el, 55);
  }
  segmentCandidates(mainEl, consider);
  return toBlocks(scores, mainEl, budgetTokens);
}

/** Visible candidates → snapshot blocks, best first within the budget, then in page order. */
function toBlocks(scores: Map<Element, number>, mainEl: Element | null, budgetTokens: number, parentId?: string): SnapshotBlock[] {
  const body = document.body;
  const view = viewport();
  const pageArea = Math.max(document.documentElement.scrollWidth, view.w) * Math.max(document.documentElement.scrollHeight, view.h);
  const picked: Array<{ el: Element; score: number; style: CSSStyleDeclaration; rect: DOMRect }> = [];
  for (const [el, score] of scores) {
    if (el === body || el === document.documentElement || el.closest("[data-awl-overlay], [data-awl-picker]")) continue;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (!isVisible(style, rect)) continue;
    // Tiny elements are noise unless something marks them as interesting.
    const share = rect.width * rect.height / view.area;
    if (share < 0.0025 || (score < 50 && share < (score <= 15 ? 0.03 : 0.01))) continue;
    picked.push({ el, score, style, rect });
  }
  // Highest score first, so the budget drops the least useful blocks.
  const before = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  picked.sort((a, b) => b.score - a.score || before(a.el, b.el));

  const hasMain = mainEl !== null && mainEl !== body;
  // How much of the page's prose each block holds: a block with most of it is content, whatever the model thinks.
  const prose = proseTotals(body);
  const totalProse = Math.max(prose.get(body) ?? 0, 1);
  const title = titleHeading(hasMain ? mainEl : null);
  const kept: Array<{ el: Element; block: SnapshotBlock }> = [];
  const kinds = new Set<string>();
  let used = 0;
  for (const { el, style, rect } of picked.slice(0, MAX_BLOCKS)) {
    // One block stands for every copy of a widget ("+ N more like it").
    const kind = sameKindSelector(el, mainEl);
    if (kind && kinds.has(kind.selector)) continue;
    const fixed = style.position === "fixed" || style.position === "sticky";
    const top = fixed ? rect.top : rect.top + window.scrollY;
    const links = Array.from(el.querySelectorAll("a")).reduce((sum, link) => sum + (link.textContent?.trim().length ?? 0), 0);
    const textLength = el.textContent?.trim().length ?? 0;
    const tag = el.tagName.toLowerCase();
    const block: SnapshotBlock = {
      id: getOrAssignId(el),
      tag: tag.slice(0, 20),
      role: (el.getAttribute("role") ?? IMPLICIT_ROLE[tag])?.slice(0, 24),
      hints: hintsOf(el),
      text: textPreview(el),
      box: [round(rect.left / view.w * 100), round(top / view.h * 100), round(rect.width / view.w * 100), round(rect.height / view.h * 100)],
      fixed,
      area: Math.min(100, round(rect.width * rect.height / pageArea * 100, 1)),
      linkDensity: textLength ? Math.min(1, round(links / textLength, 2)) : 0,
      protect: protectionOf(el),
      main: hasMain && el.contains(mainEl),
      inMain: hasMain && el !== mainEl && mainEl.contains(el),
      children: el === mainEl ? 0 : Math.min(99, blockParts(el, view).length),
      // A wrapper around the article is not an ad because an ad sits next to it.
      ad: !(hasMain && el.contains(mainEl)) && hasAdSignals(el),
      textShare: Math.min(100, Math.round((prose.get(el) ?? 0) / totalProse * 100)),
      title: title !== null && el.contains(title),
    };
    if (kind) block.similar = kind.count - 1;
    const cost = estimateTokens(JSON.stringify(block)) + 4;
    if (used + cost > budgetTokens) break;
    used += cost;
    if (kind) kinds.add(kind.selector);
    kept.push({ el, block });
  }

  // Back to page order, and link each block to its nearest kept ancestor.
  kept.sort((a, b) => before(a.el, b.el));
  const ids = new Map(kept.map(({ el, block }) => [el, block.id]));
  return kept.map(({ el, block }) => {
    let within: string | undefined;
    for (let parent = el.parentElement; parent && !within; parent = parent.parentElement) within = ids.get(parent) ?? (parentId && parent === resolveSnapshotId(parentId) ? parentId : undefined);
    return within ? { ...block, within } : block;
  });
}

function mainRegion(applyToWholePage: boolean): Element | null {
  const region = getContentRegionSelector(applyToWholePage);
  return region === "body" ? null : document.querySelector(region);
}

/** The page's title heading: the first visible h1, preferring one in the main content. */
function titleHeading(mainEl: Element | null): Element | null {
  const visible = (el: Element) => el.getBoundingClientRect().height > 0;
  const headings = Array.from(document.querySelectorAll("h1")).filter(visible);
  return headings.find((el) => mainEl?.contains(el)) ?? headings[0] ?? null;
}

/** P10 drill-down: the visible parts of these blocks, as new candidate blocks. */
export function expandBlocks(ids: readonly string[], applyToWholePage: boolean, budgetTokens = 900): SnapshotBlock[] {
  const mainEl = mainRegion(applyToWholePage);
  const blocks: SnapshotBlock[] = [];
  for (const id of ids.slice(0, 3)) {
    const el = resolveSnapshotId(id);
    if (!el || el === mainEl) continue;
    const scores = new Map(blockParts(el).map((part) => [part, 30] as const));
    blocks.push(...toBlocks(scores, mainEl, Math.floor(budgetTokens / Math.max(1, Math.min(ids.length, 3))), id));
  }
  return blocks;
}

/**
 * P10: a region of the screenshot (in % of the viewport) the reviewer says was
 * missed → the smallest block that covers most of it, as a new candidate.
 */
export function blockAtRegion(region: { x: number; y: number; w: number; h: number }, applyToWholePage: boolean): SnapshotBlock | null {
  const view = viewport();
  const box = { left: region.x / 100 * view.w, top: region.y / 100 * view.h, width: region.w / 100 * view.w, height: region.h / 100 * view.h };
  if (box.width < 4 || box.height < 4) return null;
  const centreX = Math.min(view.w - 1, Math.max(0, box.left + box.width / 2));
  const centreY = Math.min(view.h - 1, Math.max(0, box.top + box.height / 2));
  const hits = document.elementsFromPoint(centreX, centreY).filter((el) => !el.closest("[data-awl-overlay], [data-awl-picker]"));
  const regionArea = box.width * box.height;
  for (let el: Element | null = hits[0] ?? null; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    const rect = el.getBoundingClientRect();
    const overlapW = Math.max(0, Math.min(rect.right, box.left + box.width) - Math.max(rect.left, box.left));
    const overlapH = Math.max(0, Math.min(rect.bottom, box.top + box.height) - Math.max(rect.top, box.top));
    // Covers most of the region, and is not much bigger than it.
    if (overlapW * overlapH >= regionArea * 0.6 && rect.width * rect.height <= regionArea * 4 && sizable(el, view)) {
      return toBlocks(new Map([[el, 60]]), mainRegion(applyToWholePage), 400)[0] ?? null;
    }
  }
  return null;
}

/** P10 Set-of-Mark: where the given blocks are in the viewport (CSS px), for drawing numbered boxes on a screenshot. */
export function viewportMarks(ids: readonly string[]): { marks: Array<{ id: string; x: number; y: number; w: number; h: number }>; width: number; height: number } {
  const view = viewport();
  const marks: Array<{ id: string; x: number; y: number; w: number; h: number }> = [];
  for (const id of ids) {
    const el = resolveSnapshotId(id);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (!isVisible(style, rect) || rect.bottom <= 0 || rect.right <= 0 || rect.top >= view.h || rect.left >= view.w) continue;
    const x = Math.max(0, rect.left);
    const y = Math.max(0, rect.top);
    marks.push({ id, x: round(x), y: round(y), w: round(Math.min(view.w, rect.right) - x), h: round(Math.min(view.h, rect.bottom) - y) });
  }
  return { marks, width: view.w, height: view.h };
}

/**
 * A selector for every copy of the same clutter widget (e.g. all `div.ad-slot`),
 * so hiding one hides the rest, including copies a page loads while scrolling.
 * Only for clearly-clutter class names, 2–40 copies, none of which is or
 * contains the main content, navigation or a form.
 */
export function sameKindSelector(el: Element, mainEl: Element | null = document.querySelector(getContentRegionSelector(false))): { selector: string; count: number } | null {
  const tag = el.tagName.toLowerCase();
  for (const token of Array.from(el.classList)) {
    if (!/^[A-Za-z][\w-]{1,40}$/.test(token) || (token.match(/\d/g)?.length ?? 0) > 2 || !SAME_KIND.test(token)) continue;
    const selector = `${tag}.${CSS.escape(token)}`;
    const matches = Array.from(document.querySelectorAll(selector));
    if (matches.length < 2 || matches.length > MAX_SAME_KIND) continue;
    const unsafe = matches.some((match) => (mainEl && mainEl !== document.body && match.contains(mainEl)) || match.matches(NAVIGATION) || match.querySelector(`${NAVIGATION}, form`) || match.closest(NAVIGATION));
    if (!unsafe) return { selector, count: matches.length };
  }
  return null;
}

// Estimate token count (rough: 1 token ≈ 4 chars)
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

// Blocks are included first; text blocks fill what remains.
const MAX_TOKENS = 3600;
const BLOCK_TOKENS = 2400;

/**
 * Build a snapshot of the current page.
 * Truncates deterministically to stay within the token budget.
 */
export function buildDomSnapshot(applyToWholePage: boolean): DomSnapshot {
  const contentRegion = getContentRegionSelector(applyToWholePage);

  // ── Headings ──────────────────────────────────────────────────────────────
  const headingEls = Array.from(
    document.querySelectorAll("h1, h2, h3, h4, h5, h6")
  ).slice(0, 40) as HTMLElement[];

  const headings = headingEls.map((el) => ({
    level: parseInt(el.tagName[1]),
    text: (el.innerText ?? el.textContent ?? "").trim().slice(0, 120),
    id: getOrAssignId(el),
  }));

  // ── Landmarks ─────────────────────────────────────────────────────────────
  const landmarkEls = Array.from(
    document.querySelectorAll(
      "main, nav, aside, header, footer, [role='main'], [role='navigation'], [role='banner'], [role='contentinfo'], [role='complementary']"
    )
  ).slice(0, 20);

  const landmarks = landmarkEls.map((el) => ({
    role: el.tagName.toLowerCase() === "div" || el.tagName.toLowerCase() === "section"
      ? (el.getAttribute("role") ?? "section")
      : el.tagName.toLowerCase(),
    id: getOrAssignId(el),
  }));

  // ── Text blocks ────────────────────────────────────────────────────────────
  const root = applyToWholePage
    ? document.body
    : (document.querySelector(contentRegion) ?? document.body);

  // The schema allows 50 text blocks; take 40 so filtering can never exceed it.
  const blockEls = Array.from(
    root?.querySelectorAll("p, blockquote, li, td, th") ?? []
  ).slice(0, 40) as HTMLElement[];

  const isProtected = (el: Element) =>
    el.closest(PROTECTED_SELECTOR) !== null || el.matches(PROTECTED_SELECTOR);

  const textBlocks = blockEls.map((el) => ({
    id: getOrAssignId(el),
    tagName: el.tagName.toLowerCase(),
    textLength: (el.innerText ?? el.textContent ?? "").trim().length,
    isProtected: isProtected(el),
  })).filter((b) => b.textLength > 20); // skip empty blocks

  // ── Counts ────────────────────────────────────────────────────────────────
  const imageCnt = document.querySelectorAll("img, picture, svg").length;
  const tableCnt = document.querySelectorAll("table").length;
  const codeBlockCnt = document.querySelectorAll("pre, code").length;

  // ── Assemble and truncate ─────────────────────────────────────────────────
  const snap: DomSnapshot = {
    url: window.location.href.slice(0, 200),
    title: document.title.slice(0, 100),
    contentRegion,
    headings: headings.slice(0, 30),
    landmarks: landmarks.slice(0, 20),
    textBlocks: [],
    blocks: [],
    imageCnt,
    tableCnt,
    codeBlockCnt,
    tokenEstimate: 0,
  };

  // Compute running token estimate: blocks first, then text blocks, until budget
  const base = JSON.stringify({ ...snap, textBlocks: [] });
  let usedTokens = estimateTokens(base);

  snap.blocks = collectBlocks(contentRegion === "body" ? null : document.querySelector(contentRegion), BLOCK_TOKENS);
  usedTokens += estimateTokens(JSON.stringify(snap.blocks));

  const includedBlocks: typeof textBlocks = [];
  for (const block of textBlocks) {
    const blockStr = JSON.stringify(block);
    const blockTokens = estimateTokens(blockStr);
    if (usedTokens + blockTokens > MAX_TOKENS) break;
    includedBlocks.push(block);
    usedTokens += blockTokens;
  }

  snap.textBlocks = includedBlocks;
  snap.tokenEstimate = usedTokens;

  return snap;
}
