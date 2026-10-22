// ─── DOM Snapshot builder (content script side) ───────────────────────────────
// Builds minimal, token-budgeted metadata about the current page for the AI.
// Never includes form values, passwords, or sensitive field content.
// Plans returned by the model reference stable snapshot ids, never selectors.

import { type DomSnapshot } from "../shared/plan";
import { PROTECTED_SELECTOR } from "./domUtils";

// Stable id → element map, so plans can reference elements without selectors.
const _snapshotMap = new Map<string, Element>();
let _snapshotSeq = 0;

function freshId(): string {
  return `awl-snap-${++_snapshotSeq}`;
}

function getOrAssignId(el: Element): string {
  // Check if element already has a snapshot id
  const existing = el.getAttribute("data-awl-snap");
  if (existing) return existing;
  const id = freshId();
  el.setAttribute("data-awl-snap", id);
  _snapshotMap.set(id, el);
  return id;
}

/** Resolve a snapshot id to a live element, if still present. */
export function resolveSnapshotId(id: string): Element | undefined {
  const el = _snapshotMap.get(id);
  if (!el || !document.contains(el)) {
    _snapshotMap.delete(id);
    return undefined;
  }
  return el;
}

// Estimate token count (rough: 1 token ≈ 4 chars)
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

const MAX_TOKENS = 2000;

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

  const blockEls = Array.from(
    root?.querySelectorAll("p, blockquote, li, td, th") ?? []
  ).slice(0, 60) as HTMLElement[];

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
    imageCnt,
    tableCnt,
    codeBlockCnt,
    tokenEstimate: 0,
  };

  // Compute running token estimate and add text blocks until budget
  const base = JSON.stringify({ ...snap, textBlocks: [] });
  let usedTokens = estimateTokens(base);

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
