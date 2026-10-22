// ─── DOM Snapshot builder (content script side) ───────────────────────────────
// Builds minimal, token-budgeted metadata about the current page for the AI.
// Never includes form values, passwords, or sensitive field content.
// Plans returned by the model reference stable snapshot ids, never selectors.

import { MAX_BLOCKS, type ProtectKind, type SnapshotBlock } from "../shared/elementPlan";
import { type DomSnapshot } from "../shared/plan";
import { PROTECTED_SELECTOR } from "./domUtils";

// Stable id → element map, so plans can reference elements without selectors.
const _snapshotMap = new Map<string, Element>();
let _snapshotSeq = 0;

function freshId(): string {
  return `s${++_snapshotSeq}`;
}

function getOrAssignId(el: Element): string {
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
const SCAN_LIMIT = 4000;
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

function protectionOf(el: Element): ProtectKind | undefined {
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

function collectBlocks(mainEl: Element | null, budgetTokens: number): SnapshotBlock[] {
  const body = document.body;
  if (!body) return [];
  const viewW = Math.max(window.innerWidth, 1);
  const viewH = Math.max(window.innerHeight, 1);
  const pageArea = Math.max(document.documentElement.scrollWidth, viewW) * Math.max(document.documentElement.scrollHeight, viewH);

  // Score candidates so the most useful ones survive the cap.
  const scores = new Map<Element, number>();
  const consider = (el: Element, score: number) => scores.set(el, Math.max(scores.get(el) ?? 0, score));
  if (mainEl && mainEl !== body) consider(mainEl, 100);
  document.querySelectorAll(BLOCK_SELECTOR).forEach((el) => consider(el, el.matches(DIALOGS) ? 60 : 30));
  const all = body.querySelectorAll("*");
  for (let index = 0; index < Math.min(all.length, SCAN_LIMIT); index++) {
    const el = all[index];
    if (!CONTAINER_TAGS.has(el.tagName)) continue;
    if (CLUTTER_HINT.test(hintsOf(el))) consider(el, 50);
    else if (isRepeatedGroup(el)) consider(el, 15);
    const position = getComputedStyle(el).position;
    if (position === "fixed" || position === "sticky") consider(el, 55);
  }

  const picked: Array<{ el: Element; score: number; style: CSSStyleDeclaration; rect: DOMRect }> = [];
  for (const [el, score] of scores) {
    if (el === body || el === document.documentElement || el.closest("[data-awl-overlay], [data-awl-picker]")) continue;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (!isVisible(style, rect)) continue;
    // Tiny elements are noise unless something marks them as interesting.
    const share = rect.width * rect.height / (viewW * viewH);
    if (share < 0.0025 || (score < 50 && share < (score <= 15 ? 0.03 : 0.01))) continue;
    picked.push({ el, score, style, rect });
  }
  // Highest score first, so the budget drops the least useful blocks.
  const before = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  picked.sort((a, b) => b.score - a.score || before(a.el, b.el));

  const kept: Array<{ el: Element; block: SnapshotBlock }> = [];
  let used = 0;
  for (const { el, style, rect } of picked.slice(0, MAX_BLOCKS)) {
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
      box: [round(rect.left / viewW * 100), round(top / viewH * 100), round(rect.width / viewW * 100), round(rect.height / viewH * 100)],
      fixed,
      area: Math.min(100, round(rect.width * rect.height / pageArea * 100, 1)),
      linkDensity: textLength ? Math.min(1, round(links / textLength, 2)) : 0,
      protect: protectionOf(el),
      main: mainEl !== null && mainEl !== body && el.contains(mainEl),
    };
    const cost = estimateTokens(JSON.stringify(block)) + 4;
    if (used + cost > budgetTokens) break;
    used += cost;
    kept.push({ el, block });
  }

  // Back to page order, and link each block to its nearest kept ancestor.
  kept.sort((a, b) => before(a.el, b.el));
  const ids = new Map(kept.map(({ el, block }) => [el, block.id]));
  return kept.map(({ el, block }) => {
    let within: string | undefined;
    for (let parent = el.parentElement; parent && !within; parent = parent.parentElement) within = ids.get(parent);
    return within ? { ...block, within } : block;
  });
}

// Estimate token count (rough: 1 token ≈ 4 chars)
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

// Blocks are included first; text blocks fill what remains.
const MAX_TOKENS = 3200;
const BLOCK_TOKENS = 2000;

/**
 * Build a snapshot of the current page.
 * Truncates deterministically to stay within the token budget.
 */
export function buildDomSnapshot(applyToWholePage: boolean): DomSnapshot {
  const contentRegion = applyToWholePage
    ? "body"
    : detectContentRegion();

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

  const mainEl = contentRegion === "body" ? null : document.querySelector(contentRegion);
  snap.blocks = collectBlocks(mainEl, BLOCK_TOKENS);
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

/** Detect the main content region selector. Re-uses domUtils logic. */
function detectContentRegion(): string {
  if (document.querySelector("main")) return "main";
  if (document.querySelector("article")) return "article";
  if (document.querySelector("[role='main']")) return "[role='main']";

  const candidates = Array.from(
    document.querySelectorAll("div, section")
  ) as HTMLElement[];

  let best: HTMLElement | null = null;
  let bestScore = 0;

  for (const el of candidates) {
    const text = el.innerText?.trim() ?? "";
    if (text.length < 200) continue;
    const rect = el.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area < 10000) continue;
    const score = (text.length * text.length) / area;
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }

  if (best) {
    if (best.id) return `#${CSS.escape(best.id)}`;
    const first = best.className?.split(/\s+/)[0];
    if (first) return `.${CSS.escape(first)}`;
    return best.tagName.toLowerCase();
  }

  return "body";
}
