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
/**
 * Find the main content container of the page using a set of heuristics,
 * in priority order:
 *  1. <main> element
 *  2. <article> element
 *  3. [role="main"] element
 *  4. Text-density heuristic (highest ratio of text to element area)
 *
 * Returns a CSS selector string for the content region.
 * Falls back to "body" so typography always has a target.
 */
export function detectContentRegion(): string {
  // 1. Semantic landmarks
  if (document.querySelector("main")) return "main";
  if (document.querySelector("article")) return "article";
  if (document.querySelector("[role='main']")) return "[role='main']";

  // 2. Text-density heuristic
  const candidates = Array.from(
    document.querySelectorAll("div, section, aside, .content, #content, .main, #main")
  ) as HTMLElement[];

  let best: HTMLElement | null = null;
  let bestScore = 0;

  for (const el of candidates) {
    const text = el.innerText?.trim() ?? "";
    if (text.length < 200) continue; // skip thin elements

    const rect = el.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area < 10000) continue; // skip tiny/invisible elements

    // score = text chars / area (higher = denser text)
    const score = (text.length * text.length) / area;
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }

  if (best) {
    // Build a stable selector: prefer id, else try a class
    if (best.id) return `#${CSS.escape(best.id)}`;
    if (best.className) {
      const first = best.className.split(/\s+/)[0];
      if (first) return `.${CSS.escape(first)}`;
    }
    return best.tagName.toLowerCase();
  }

  return "body";
}

// ─── Content region selector (cached per page) ────────────────────────────────
let _cachedRegion: string | null = null;

export function getContentRegionSelector(applyToWholePage: boolean): string {
  if (applyToWholePage) return "body";
  if (!_cachedRegion) {
    _cachedRegion = detectContentRegion();
  }
  return _cachedRegion;
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
