// ─── Element plans (P07 "Clean this page") ───────────────────────────────────
// A model may hide, dim or highlight page blocks, but only by naming ids from
// the snapshot it was given. Every rule that keeps this safe lives here, in
// code: ids must exist, the main content can never be hidden, there are count
// and area caps, and protected blocks (navigation, forms, alerts, interactive
// dialogs) are only hidden after the user confirms each one.

import { z } from "zod";
import type { DomSnapshot } from "./plan";

export const ELEMENT_ACTIONS = ["hide", "dim", "highlight"] as const;
export type ElementAction = typeof ELEMENT_ACTIONS[number];

export const MAX_HIDDEN = 15;
/**
 * Upper bound on the share of the page (in %) one plan may hide. Fixed/sticky
 * overlays cover the page rather than being part of it, so they don't count.
 */
export const MAX_HIDDEN_AREA = 60;
export const MAX_BLOCKS = 60;
/**
 * A block holding this share of the page's prose (in %) is content, not
 * clutter: it is never hidden or dimmed, even when the main-content finder
 * missed it. Comment threads are the exception (some readers hide them).
 */
export const MAX_CLUTTER_TEXT_SHARE = 35;
const COMMENTS = /comment|discussion|disqus|replies/i;

export const ProtectKindSchema = z.enum(["navigation", "form", "alert", "dialog"]);
export type ProtectKind = z.infer<typeof ProtectKindSchema>;

const BlockIdSchema = z.string().min(1).max(32);

export const SnapshotBlockSchema = z.object({
  id: BlockIdSchema,
  tag: z.string().max(20),
  role: z.string().max(24).optional(),
  /** Sanitised class/id/aria-label words, e.g. "cookie-banner consent". */
  hints: z.string().max(80).default(""),
  /** Visible text preview; never form values. */
  text: z.string().max(100).default(""),
  /** [left, top, width, height] in % of the viewport, top measured from the page top. */
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  /** position: fixed or sticky (overlays, sticky bars). */
  fixed: z.boolean().default(false),
  /** Share of the whole page's area, in %. */
  area: z.number().min(0).max(100),
  /** Share of the block's text that is link text, 0–1. */
  linkDensity: z.number().min(0).max(1).default(0),
  protect: ProtectKindSchema.optional(),
  /** Other copies of the same clutter widget on the page (ad slots, share bars); hidden together with it. */
  similar: z.number().int().min(0).max(40).optional(),
  /** The main content region or one of its ancestors. */
  main: z.boolean().default(false),
  /** Inside the main content region (an in-article box, the comments). */
  inMain: z.boolean().default(false),
  /** Visible parts inside it that the model may ask to see (P10 drill-down). */
  children: z.number().int().min(0).max(99).default(0),
  /** Measured ad signals: a cross-site frame, sponsored links, ad-slot markup. */
  ad: z.boolean().default(false),
  /** Share of the page's prose (paragraphs, list items) inside the block, in %. */
  textShare: z.number().min(0).max(100).default(0),
  /** Holds the page's title heading (its h1). */
  title: z.boolean().default(false),
  /** Id of the nearest enclosing block, if any. */
  within: BlockIdSchema.optional(),
});
export type SnapshotBlock = z.infer<typeof SnapshotBlockSchema>;

const IdListSchema = z.array(BlockIdSchema).max(30).default([]);

/** The element part of a model's plan: snapshot ids per action. */
export const ElementsSchema = z.object({ hide: IdListSchema, dim: IdListSchema, highlight: IdListSchema });
export type Elements = z.infer<typeof ElementsSchema>;

export const ElementItemSchema = z.object({
  id: BlockIdSchema,
  action: z.enum(ELEMENT_ACTIONS),
  label: z.string().max(160),
  /** Set when hiding needs the user's explicit confirmation. */
  protect: ProtectKindSchema.optional(),
  enabled: z.boolean(),
});
export type ElementItem = z.infer<typeof ElementItemSchema>;

export const RejectedElementSchema = z.object({
  id: z.string().max(64),
  action: z.enum(ELEMENT_ACTIONS),
  label: z.string().max(160),
  reason: z.string().max(200),
});
export type RejectedElement = z.infer<typeof RejectedElementSchema>;

export interface ElementReview {
  items: ElementItem[];
  rejected: RejectedElement[];
}

/** Snapshot ids grouped by action; what the content script previews. */
export const PreviewElementsSchema = z.object({
  hide: z.array(BlockIdSchema).max(30),
  dim: z.array(BlockIdSchema).max(30),
  highlight: z.array(BlockIdSchema).max(30),
});
export type PreviewElements = z.infer<typeof PreviewElementsSchema>;

/** P10: the one-click request behind "Fix this page" (it also gets the measured problems). */
export const FIX_PAGE_REQUEST = "Fix this page so it is easier for me to read: adjust text size, spacing, width and contrast where the measured problems call for it, and hide distracting clutter like pop-ups and promo bars; keep the main content and navigation";

/** The one-click request behind the side panel's "Clean this page" button. */
export const CLEAN_PAGE_REQUEST = "Clean this page: hide clutter like cookie banners, pop-ups, promos and recommendation rails; keep the main content and navigation";

export const PROTECT_LABEL: Record<ProtectKind, string> = {
  navigation: "navigation",
  form: "a form",
  alert: "an alert",
  dialog: "an interactive dialog",
};

/** Short human label for a block, e.g. `aside “Recommended for you”`. */
export function blockLabel(block: SnapshotBlock): string {
  const kind = block.role && block.role !== block.tag ? `${block.tag} (${block.role})` : block.tag;
  const text = block.text.length > 56 ? `${block.text.slice(0, 55).trimEnd()}…` : block.text;
  if (text) return `${kind} “${text}”`;
  return block.hints ? `${kind} .${block.hints.split(" ")[0]}` : kind;
}

/** One compact line per block for the prompt (inside <page_data>, so untrusted). */
export function describeBlockForPrompt(block: SnapshotBlock): string {
  const [left, top, width] = block.box;
  const centre = left + width / 2;
  const side = centre < 33 ? "left" : centre > 67 ? "right" : "centre";
  const where = `${side}, ${top < 15 ? "top of page" : `${Math.round(top)}% down`}${block.fixed ? ", stays on screen while scrolling" : ""}`;
  const parts = [
    `${block.id} <${block.tag}${block.role && block.role !== block.tag ? ` role=${block.role}` : ""}>`,
    block.hints ? `[${block.hints}]` : "",
    block.text ? JSON.stringify(block.text) : "",
    `· ${where} · ${block.area}% of page`,
    block.linkDensity >= 0.5 ? "· mostly links" : "",
    block.ad ? "· ad signals" : "",
    block.within ? `· inside ${block.within}` : "",
    block.main ? "· MAIN CONTENT" : block.inMain ? "· in the article" : "",
    block.title ? "· PAGE TITLE" : "",
    block.textShare >= 10 ? `· ${block.textShare}% of the page's text` : "",
    block.children >= 2 ? `· ${block.children} parts` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

function isInside(block: SnapshotBlock, ancestors: Set<string>, byId: Map<string, SnapshotBlock>): boolean {
  for (let parent = block.within; parent; parent = byId.get(parent)?.within) {
    if (ancestors.has(parent)) return true;
  }
  return false;
}

/**
 * Check a model's element lists against the snapshot. Nothing is dropped
 * silently: everything that cannot be used comes back in `rejected` with a reason.
 */
export function validateElements(elements: Elements | undefined, snapshot: DomSnapshot): ElementReview {
  const review: ElementReview = { items: [], rejected: [] };
  if (!elements) return review;
  const byId = new Map(snapshot.blocks.map((block) => [block.id, block]));
  const seen = new Set<string>();
  const hidden = new Set<string>();
  // Area is judged against every requested hide, so list order cannot matter.
  const requestedHide = new Set(elements.hide.filter((id) => byId.has(id) && !byId.get(id)!.main));
  let hiddenArea = 0;

  for (const action of ELEMENT_ACTIONS) {
    for (const id of elements[action]) {
      const block = byId.get(id);
      const reject = (reason: string) => review.rejected.push({ id: id.slice(0, 64), action, label: block ? blockLabel(block) : id.slice(0, 64), reason });
      if (!block) { reject("Not an element on this page."); continue; }
      if (seen.has(id)) { reject("Listed more than once."); continue; }
      seen.add(id);
      if (block.main && action !== "highlight") { reject("This is the main content, or contains it."); continue; }
      if (action !== "highlight" && !block.fixed) {
        if (block.title) { reject("This holds the page title."); continue; }
        if (block.textShare >= MAX_CLUTTER_TEXT_SHARE && !COMMENTS.test(block.hints)) { reject(`This holds ${block.textShare}% of the page's text: that is content, not clutter.`); continue; }
      }
      if (action === "hide") {
        if (hidden.size >= MAX_HIDDEN) { reject(`At most ${MAX_HIDDEN} elements can be hidden at once.`); continue; }
        // Overlays, and blocks inside one that is already hidden, add no area.
        const area = block.fixed || isInside(block, requestedHide, byId) ? 0 : block.area;
        if (hiddenArea + area > MAX_HIDDEN_AREA) { reject(`Would hide more than ${MAX_HIDDEN_AREA}% of the page.`); continue; }
        hidden.add(id);
        hiddenArea += area;
      }
      const protect = action === "hide" ? block.protect : undefined;
      const label = action === "hide" && block.similar ? `${blockLabel(block)} + ${block.similar} more like it` : blockLabel(block);
      review.items.push({ id, action, label: label.slice(0, 160), protect, enabled: !protect });
    }
  }
  // A hide inside another hidden block changes nothing and would only add a
  // confirmation; report it instead of listing it.
  const redundant = review.items.filter((item) => item.action === "hide" && isInside(byId.get(item.id)!, hidden, byId));
  for (const item of redundant) {
    let outer = byId.get(item.id)!.within;
    while (outer && !hidden.has(outer)) outer = byId.get(outer)?.within;
    review.rejected.push({ id: item.id, action: "hide", label: item.label, reason: `Already hidden with ${outer ? blockLabel(byId.get(outer)!) : "its container"}.` });
  }
  review.items = review.items.filter((item) => !redundant.includes(item));
  return review;
}

/** The ids the page should currently show as previewed (enabled items only). */
export function previewElementsOf(items: readonly ElementItem[]): PreviewElements {
  const pick = (action: ElementAction) => items.filter((item) => item.enabled && item.action === action).map((item) => item.id);
  return { hide: pick("hide"), dim: pick("dim"), highlight: pick("highlight") };
}

// Element changes are kept only when the request is about page parts. This is
// the code-side defence against page text talking the model into hiding things
// on an unrelated request ("make the text bigger").
export const ELEMENT_WORDS = /\b(hide|hidden|remove|clean|clutter\w*|declutter|distract\w*|get rid|banners?|pop-?ups?|modals?|overlays?|ads?|adverts?\w*|promos?\w*|cookies?|consent|newsletters?|subscri\w*|sidebars?|rails?|recommend\w*|related|comments?|share|social|highlight\w*|emphasi\w*|point out|mark|dim|fade|gr[ae]y out|tidy|noise|annoy\w*|sticky|bar)\b/i;

export function dropUnrequestedElements(request: string, elements: Elements | undefined): { elements: Elements | undefined; dropped: number } {
  if (!elements) return { elements, dropped: 0 };
  const count = elements.hide.length + elements.dim.length + elements.highlight.length;
  if (count === 0 || ELEMENT_WORDS.test(request)) return { elements, dropped: 0 };
  return { elements: undefined, dropped: count };
}

// ─── Deterministic suggestions (Demo mode and the no-AI fallback) ────────────
const CLEANUP_REQUEST = /\b(clean\w*|clutter\w*|declutter|distract\w*|hide|remove|tidy|get rid|annoy\w*|pop-?ups?|banners?|cookies?|ads?|promos?|junk)\b/i;

interface ClutterKind {
  /** Words in the request that name this kind. */
  asked: RegExp;
  /** Block hints (or overlay text) that identify it. */
  matches: RegExp;
  /** Only hidden when named explicitly (comments are content to some readers). */
  optIn?: boolean;
}

const CLUTTER_KINDS: readonly ClutterKind[] = [
  { asked: /cookie|consent|gdpr|pop-?ups?/i, matches: /cookie|consent|gdpr/i },
  { asked: /newsletter|subscri|pop-?ups?|modal|sign-?up/i, matches: /newsletter|subscri|sign-?up|popup|modal/i },
  { asked: /promo|sale|\bads?\b|advert|sponsor|banner/i, matches: /promo|sponsor|advert|(^|[\s_-])ads?([\s_-]|$)/i },
  { asked: /recommend|related|suggest|popular|trending|rail/i, matches: /recommend|related|popular|trending/i },
  { asked: /share|social/i, matches: /share|social/i },
  { asked: /paywall/i, matches: /paywall/i },
  { asked: /comment|discussion/i, matches: /comment|discussion|disqus/i, optIn: true },
];
const KEEP = /(^|[\s_-])toc([\s_-]|$)|contents|on this page/i;

/**
 * Keyword clean-up: hides the clutter kinds the request names (all but comments
 * for a generic "clean this page"), never kinds named after "keep"/"except".
 */
export function suggestElements(request: string, snapshot: DomSnapshot): Elements | null {
  if (!CLEANUP_REQUEST.test(request)) return null;
  const [wanted, ...kept] = request.split(/\b(?:keep|except|but not|don'?t hide|do not hide|leave)\b/i);
  const keepText = kept.join(" ");
  const named = CLUTTER_KINDS.filter((kind) => kind.asked.test(wanted));
  const kinds = (named.length ? named : CLUTTER_KINDS.filter((kind) => !kind.optIn)).filter((kind) => !kind.asked.test(keepText));
  const byId = new Map(snapshot.blocks.map((block) => [block.id, block]));
  const chosen = new Set<string>();
  for (const block of snapshot.blocks) {
    if (block.main || block.protect === "navigation" || KEEP.test(`${block.hints} ${block.text}`)) continue;
    // Page text alone only counts for overlays, asides, dialogs and small
    // blocks outside the article, so an article that mentions "cookies" is never matched.
    const textCounts = block.fixed || block.tag === "aside" || block.role === "dialog" || (!block.inMain && !block.main && block.area < 8 && block.linkDensity < 0.5);
    const matches = kinds.some((kind) => kind.matches.test(block.hints) || (textCounts && kind.matches.test(block.text)));
    if (matches && !isInside(block, chosen, byId)) chosen.add(block.id);
  }
  return chosen.size ? { hide: [...chosen], dim: [], highlight: [] } : null;
}
