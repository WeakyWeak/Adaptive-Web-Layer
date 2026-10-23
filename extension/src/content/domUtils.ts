// ─── Protected elements ───────────────────────────────────────────────────────
// These must NEVER be touched by typography operations.
export const PROTECTED_ELEMENTS = [
  "pre", "code", "kbd", "samp", "img", "video", "picture", "canvas", "svg", "iframe",
  "input", "textarea", "select", "button", "[data-awl-preserve]",
] as const;
export const PROTECTED_SELECTOR = PROTECTED_ELEMENTS.join(", ");

// ─── Prose element selector ───────────────────────────────────────────────────
// These are the elements inside the content region that receive typography.
export const PROSE_SELECTOR = "p, li, blockquote, h1, h2, h3, h4, h5, h6, td, th, label, figcaption";

// ─── Content-region detection ─────────────────────────────────────────────────
// One finder for the whole extension (typography, measurements, the AI
// snapshot): the element that holds most of the page's prose. Page builders
// often have no <main>/<article> and share class names between header and
// article, so the result is always a selector that matches exactly one element.
const PROSE_TEXT = "p, li, blockquote, dd, pre, td";
/** Less prose than this (characters) and the page is not an article (a gallery, an app). */
const MIN_PROSE = 400;
/** The main region holds at least this share of the page's prose. */
const MAIN_SHARE = 0.6;
/** Marks the detected region when it has no unique id or tag. */
export const MAIN_MARK = "data-awl-main";

const rendered = (el: Element): boolean => typeof (el as HTMLElement).checkVisibility !== "function" || (el as HTMLElement).checkVisibility();

/** Characters of link text inside `el` (menus and link lists are not prose). */
function linkText(el: Element): number {
  return Array.from(el.querySelectorAll("a")).reduce((sum, link) => sum + (link.textContent ?? "").trim().length, 0);
}

/** Characters of prose under each ancestor of every paragraph-like element (each counted once; mostly-link items skipped). */
export function proseTotals(root: Element): Map<Element, number> {
  const totals = new Map<Element, number>();
  for (const paragraph of Array.from(root.querySelectorAll(PROSE_TEXT)).slice(0, 5000)) {
    if (paragraph.parentElement?.closest(PROSE_TEXT) || !rendered(paragraph)) continue;
    const length = (paragraph.textContent ?? "").replace(/\s+/g, " ").trim().length;
    if (length < 20 || linkText(paragraph) >= length / 2) continue;
    for (let el: Element | null = paragraph; el && el !== root.parentElement; el = el.parentElement) totals.set(el, (totals.get(el) ?? 0) + length);
  }
  return totals;
}

/** The smallest element holding most of the page's prose; null when the page has little prose. */
function proseRegion(body: Element): Element | null {
  const totals = proseTotals(body);
  const total = totals.get(body) ?? 0;
  if (total < MIN_PROSE) return null;
  let current = body;
  for (;;) {
    const next = Array.from(current.children).find((child) => (totals.get(child) ?? 0) >= total * MAIN_SHARE);
    // Stop above a single paragraph or list item: the region is what holds them.
    if (!next || next.matches(PROSE_TEXT)) break;
    current = next;
  }
  return current === body ? null : current;
}

const textOf = (el: Element) => (el.textContent ?? "").length;

/**
 * The main content element, in priority order: a <main>/[role=main] that holds
 * the prose, the <article> that holds it, the prose region itself; on pages
 * with little prose, the <main> or the largest <article>. Null: the whole page.
 */
export function findContentRegion(root: Document = document): Element | null {
  const body = root.body;
  if (!body) return null;
  const prose = proseRegion(body);
  const mains = Array.from(root.querySelectorAll("main, [role='main']")).filter(rendered);
  const main = mains.find((el) => prose ? el.contains(prose) : textOf(el) > 0);
  if (main) return main;
  if (prose) return prose.closest("article") ?? prose;
  const articles = Array.from(root.querySelectorAll("article")).filter(rendered).sort((a, b) => textOf(b) - textOf(a));
  return articles[0] ?? null;
}

/** A selector that matches `el` and nothing else. */
function uniqueSelector(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if ((tag === "main" || tag === "article") && document.querySelectorAll(tag).length === 1) return tag;
  if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
  document.querySelectorAll(`[${MAIN_MARK}]`).forEach((other) => { if (other !== el) other.removeAttribute(MAIN_MARK); });
  el.setAttribute(MAIN_MARK, "");
  return `[${MAIN_MARK}]`;
}

/** Selector for the main content region; "body" when there is none. */
export function detectContentRegion(): string {
  const region = findContentRegion();
  return region ? uniqueSelector(region) : "body";
}

// ─── Content region selector (cached per page) ────────────────────────────────
let _cachedRegion: string | null = null;
let _detectedAt = 0;
/** With no region found yet (still loading, content arriving later), look again at most this often. */
const REDETECT_MS = 1000;

export function getContentRegionSelector(applyToWholePage: boolean): string {
  if (applyToWholePage) return "body";
  // Look again when nothing was found yet, or when the region left the DOM (single-page apps).
  const stale = !_cachedRegion
    || (_cachedRegion === "body" ? Date.now() - _detectedAt > REDETECT_MS : !document.querySelector(_cachedRegion));
  if (stale) {
    _cachedRegion = detectContentRegion();
    _detectedAt = Date.now();
  }
  return _cachedRegion!;
}

/** Forget the region (a single-page app navigated); the next call finds it again. */
export function forgetContentRegion(): void {
  _cachedRegion = null;
}

// ─── Build CSS selector for prose inside content region ──────────────────────
// Typography ops target prose elements INSIDE the content region,
// but NOT inside any protected elements.
export function buildProseSelector(regionSelector: string): string {
  const protectedTags = PROTECTED_SELECTOR.split(",").map((tag) => tag.trim());
  const exclusions = protectedTags
    .flatMap((tag) => [`:not(${tag})`, `:not(${tag} *)`])
    .join("");
  return `${regionSelector} :is(${PROSE_SELECTOR})${exclusions}`;
}

// ─── Build CSS selector for content region itself ────────────────────────────
export function buildRegionSelector(regionSelector: string): string {
  return regionSelector;
}
