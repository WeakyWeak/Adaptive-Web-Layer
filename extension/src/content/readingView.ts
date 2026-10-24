// ─── Reading view overlay (P11) ──────────────────────────────────────────────
// Shown over the page in a Shadow DOM panel, in the reader's settings:
// - the dyslexia reading view: the checked rewrite, a 3-line summary first;
// - the plain reading view: the main content exactly as written, no AI.
// The page underneath is never changed; "Show original" hides the panel (a
// small button brings it back). Text is set with textContent only, so page or
// model text cannot inject markup.

import type { ReadingViewResult } from "../shared/comprehension";
import type { AppearancePrefs, TypographyPrefs } from "../shared/settings";
import { TINT_COLOURS, tintTextColour } from "./dyslexiaOps";
import { createShadowHost, el, SOURCE_LABEL } from "./shadowHost";

/** The reader's own settings, so the view reads like their pages do (with dyslexia-friendly floors). */
export function readingViewStyle(typography: TypographyPrefs, appearance: AppearancePrefs): string {
  const font = typography.fontFamily ? `"${typography.fontFamily}", ` : "";
  const tint = appearance.backgroundTint === "none" ? "cream" : appearance.backgroundTint;
  return `
  .view { font-family: ${font}"Atkinson Hyperlegible", Verdana, system-ui, sans-serif; font-size: ${Math.max(18, typography.fontSize)}px; line-height: ${Math.max(1.6, typography.lineHeight)};
    letter-spacing: ${typography.letterSpacing}em; word-spacing: ${typography.wordSpacing}em; background: ${TINT_COLOURS[tint]}; color: ${tintTextColour(tint)}; }`;
}

const CSS = `
  .view { position: fixed; inset: 0; display: flex; flex-direction: column; text-align: start; font-style: normal; }
  .bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 8px 16px; background: #1e293b; color: #e2e8f0; font: 14px/1.4 system-ui, sans-serif; letter-spacing: normal; word-spacing: normal; }
  .bar .tag { font-weight: 600; margin-right: auto; }
  .scroll { overflow-y: auto; flex: 1; }
  article { max-width: 68ch; margin: 0 auto; padding: 24px 20px 64px; }
  h1 { font-size: 1.4em; margin: 0 0 16px; }
  h2 { font-size: 1.15em; margin: 1.4em 0 .5em; }
  p { margin: 0 0 1.2em; }
  ul, ol { margin: 0 0 1.2em; padding-left: 1.4em; }
  blockquote { margin: 0 0 1.2em; padding-left: 14px; border-left: 3px solid rgba(0,0,0,.25); }
  pre { font: 14px/1.5 ui-monospace, monospace; letter-spacing: normal; word-spacing: normal; white-space: pre-wrap; background: rgba(0,0,0,.06); padding: 10px 12px; border-radius: 6px; margin: 0 0 1.2em; }
  li { margin: 0 0 .4em; }
  .summary { border-left: 4px solid #4f46e5; padding: 4px 0 4px 14px; margin-bottom: 24px; }
  .summary h2 { margin-top: 0; }
  .notes { font: 13px/1.5 system-ui, sans-serif; letter-spacing: normal; word-spacing: normal; opacity: .85; border-top: 1px solid rgba(0,0,0,.15); padding-top: 12px; }
  .pill { position: fixed; right: 16px; bottom: 16px; }
`;

/** One block of a reading view: headings, paragraphs and lists (P11), and quotes and code in the plain view. */
export interface ReaderBlock { kind: "heading" | "paragraph" | "list" | "quote" | "code"; text: string; items: string[]; ordered?: boolean }

export interface ReaderContent {
  /** "Dyslexia reading view" or "Reading view". */
  label: string;
  /** Where the text came from, e.g. "Local AI" or "Original text, no AI". */
  chip: string;
  title: string;
  summary: string[];
  blocks: ReaderBlock[];
  notes: string[];
}

/** The rewritten view as overlay content. */
export function rewrittenContent(view: ReadingViewResult, title: string): ReaderContent {
  return { label: "Dyslexia reading view", chip: `${SOURCE_LABEL[view.source] ?? view.source}${view.cached ? " · saved result" : ""}`, title, summary: view.summary, blocks: view.blocks, notes: view.notes };
}

function blockElement(block: ReaderBlock): HTMLElement[] {
  if (block.kind === "heading") return [el("h2", {}, block.text)];
  if (block.kind === "quote") return [el("blockquote", {}, block.text)];
  if (block.kind === "code") return [el("pre", {}, block.text)];
  if (block.kind === "list") {
    const items = block.items.map((item) => el("li", {}, item));
    return [...(block.text ? [el("p", {}, block.text)] : []), block.ordered ? el("ol", {}, ...items) : el("ul", {}, ...items)];
  }
  return [el("p", {}, block.text)];
}

export class ReadingViewOverlay {
  private host: HTMLElement | null = null;
  private pill: HTMLElement | null = null;

  show(content: ReaderContent, style: string): void {
    this.hide();
    const { host, root } = createShadowHost("reading-view", `${CSS}\n${style}`, "position:fixed;inset:0;z-index:2147483646;");
    const original = el("button", { type: "button" }, "Show original");
    const close = el("button", { type: "button" }, "Close");
    const article = el("article", {}, el("h1", {}, content.title));
    if (content.summary.length) article.append(el("section", { class: "summary", "aria-label": "In short" }, el("h2", {}, "In short"), el("ul", {}, ...content.summary.map((line) => el("li", {}, line)))));
    for (const block of content.blocks) article.append(...blockElement(block));
    if (content.notes.length) article.append(el("div", { class: "notes" }, ...content.notes.map((note) => el("p", {}, note))));
    const panel = el("div", { class: "view", role: "region", "aria-label": content.label, tabindex: "-1" },
      el("div", { class: "bar" }, el("span", { class: "tag" }, content.label), el("span", { class: "chip" }, content.chip), original, close),
      el("div", { class: "scroll" }, article));
    root.append(panel);
    const back = createShadowHost("reading-view-pill", CSS, "position:fixed;z-index:2147483646;right:0;bottom:0;");
    const pillButton = el("button", { type: "button", class: "pill" }, "Back to reading view");
    back.root.append(pillButton);
    // The shadow hosts reset `all: initial`, which beats the hidden attribute: toggle display instead.
    const show = (element: HTMLElement, visible: boolean) => element.style.setProperty("display", visible ? "block" : "none", "important");
    show(back.host, false);

    const showOriginal = () => { show(host, false); show(back.host, true); pillButton.focus(); };
    original.addEventListener("click", showOriginal);
    panel.addEventListener("keydown", (event) => { if (event.key === "Escape") showOriginal(); });
    pillButton.addEventListener("click", () => { show(back.host, false); show(host, true); panel.focus(); });
    close.addEventListener("click", () => this.hide());

    document.documentElement.append(host, back.host);
    this.host = host;
    this.pill = back.host;
    panel.focus();
  }

  hide(): void {
    this.host?.remove();
    this.pill?.remove();
    this.host = null;
    this.pill = null;
  }
}
