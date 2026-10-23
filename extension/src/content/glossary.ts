// ─── Glossary underlines (P08) ───────────────────────────────────────────────
// Terms are marked with the CSS Custom Highlight API: ranges over the page's
// own text nodes, so the text is never changed or wrapped. The underline style
// is the `glossaryHighlights` operation's entry in the managed stylesheet.
// Definitions show on hover, or on focus of an element that contains a term.

import { z } from "zod";
import { registerOperation, type Operation } from "../shared/registry";
import type { GlossaryTerm } from "../shared/comprehension";
import { contentRoot } from "./pageText";
import { createShadowHost, el } from "./shadowHost";
import { setStyleEntry } from "./styleEntry";

export const GLOSSARY_HIGHLIGHT = "awl-glossary";
const SKIP_PARENTS = "pre, code, kbd, samp, script, style, textarea, [hidden], [data-awl-overlay]";
const PER_TERM = 25;
const MAX_RANGES = 400;

export interface TermRange { term: string; range: Range }

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");

/** Whole-word, case-insensitive matches of each term inside text nodes (longest terms first, no overlaps). */
export function findTermRanges(root: Node, terms: readonly string[], limit = MAX_RANGES): TermRange[] {
  const ordered = [...terms].sort((a, b) => b.length - a.length);
  const patterns = ordered.map((term) => ({ term, regex: new RegExp(`(?<![\\p{L}\\p{N}])${escape(term)}(?![\\p{L}\\p{N}])`, "giu") }));
  const counts = new Map<string, number>();
  const found: TermRange[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.parentElement?.closest(SKIP_PARENTS) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  for (let node = walker.nextNode() as Text | null; node && found.length < limit; node = walker.nextNode() as Text | null) {
    const taken: Array<[number, number]> = [];
    for (const { term, regex } of patterns) {
      regex.lastIndex = 0;
      for (const match of node.data.matchAll(regex)) {
        const start = match.index ?? 0;
        const end = start + match[0].length;
        if ((counts.get(term) ?? 0) >= PER_TERM || found.length >= limit) break;
        if (taken.some(([from, to]) => start < to && end > from)) continue;
        taken.push([start, end]);
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, end);
        found.push({ term, range });
        counts.set(term, (counts.get(term) ?? 0) + 1);
      }
    }
  }
  return found;
}

let active: TermRange[] = [];
export const activeGlossaryRanges = (): readonly TermRange[] => active;

const glossaryHighlights: Operation<{ terms: string[] }> = {
  id: "glossaryHighlights",
  label: "Underline glossary terms",
  target: "content-region",
  protectedElements: ["pre", "code", "kbd", "samp"],
  paramsSchema: z.object({ terms: z.array(z.string().min(1).max(60)).max(12) }),
  validate: () => null,
  apply(ctx, params) {
    const supported = typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
    if (!supported || params.terms.length === 0) return setStyleEntry(ctx, "glossaryHighlights", null);
    active = findTermRanges(contentRoot(), params.terms);
    CSS.highlights.set(GLOSSARY_HIGHLIGHT, new Highlight(...active.map((item) => item.range)));
    return setStyleEntry(ctx, "glossaryHighlights", `::highlight(${GLOSSARY_HIGHLIGHT}) { text-decoration: underline dotted 2px #6366f1; text-underline-offset: 3px; background-color: rgba(99, 102, 241, .12); }`, () => {
      CSS.highlights.delete(GLOSSARY_HIGHLIGHT);
      active = [];
    });
  },
};

export function registerComprehensionOps(): void {
  registerOperation(glossaryHighlights as Operation<unknown>);
}

const TOOLTIP_CSS = `.panel { position: fixed; max-width: 320px; padding: 8px 12px; pointer-events: none; } strong { display: block; }`;

/** Shows a term's definition while the pointer is over it, or focus is inside an element that contains it. */
export class GlossaryTooltip {
  private definitions = new Map<string, string>();
  private host: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private shown: TermRange | null = null;
  private frame = 0;

  setTerms(terms: readonly GlossaryTerm[]): void {
    this.definitions = new Map(terms.map((item) => [item.term.toLowerCase(), item.definition]));
    if (this.host) return;
    const { host, root } = createShadowHost("glossary-tooltip", TOOLTIP_CSS, "position:fixed;inset:0 auto auto 0;z-index:2147483647;pointer-events:none;");
    this.panel = el("div", { class: "panel", role: "tooltip", "aria-live": "polite", hidden: "" });
    root.append(this.panel);
    document.documentElement.append(host);
    this.host = host;
    document.addEventListener("mousemove", this.onMove, { passive: true });
    document.addEventListener("focusin", this.onFocus);
    document.addEventListener("keydown", this.onKey);
    window.addEventListener("scroll", this.hide, { passive: true, capture: true });
  }

  clear(): void {
    document.removeEventListener("mousemove", this.onMove);
    document.removeEventListener("focusin", this.onFocus);
    document.removeEventListener("keydown", this.onKey);
    window.removeEventListener("scroll", this.hide, { capture: true });
    this.host?.remove();
    this.host = null;
    this.panel = null;
    this.shown = null;
  }

  private show(item: TermRange): void {
    if (!this.panel || this.shown === item) return;
    const definition = this.definitions.get(item.term.toLowerCase());
    if (!definition) return;
    this.shown = item;
    this.panel.replaceChildren(el("strong", {}, item.term), definition);
    const rect = item.range.getBoundingClientRect();
    this.panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 336))}px`;
    this.panel.style.top = `${rect.bottom + 6 > window.innerHeight - 80 ? Math.max(8, rect.top - 86) : rect.bottom + 6}px`;
    this.panel.hidden = false;
  }

  private hide = (): void => {
    if (this.panel) this.panel.hidden = true;
    this.shown = null;
  };

  private onMove = (event: MouseEvent): void => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const hit = activeGlossaryRanges().find(({ range }) => Array.from(range.getClientRects()).some((rect) =>
        event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom));
      if (hit) this.show(hit); else this.hide();
    });
  };

  private onFocus = (event: FocusEvent): void => {
    const target = event.target;
    const hit = target instanceof Node ? activeGlossaryRanges().find(({ range }) => target.contains(range.startContainer)) : undefined;
    if (hit) this.show(hit); else this.hide();
  };

  private onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") this.hide(); };
}
