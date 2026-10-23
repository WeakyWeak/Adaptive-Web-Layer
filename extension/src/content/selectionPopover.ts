// ─── Selection popover (P08) ─────────────────────────────────────────────────
// After a text selection a small "Understand" button appears; it opens
// Explain simply / Define / Translate. Results show in the popover next to the
// original text, which is never changed. Keyboard: the buttons are focusable,
// Escape closes.

import { MAX_SELECTION_CHARS, type SelectionKind, type SelectionResult } from "../shared/comprehension";
import { DEFAULT_TARGET, TARGET_LANGUAGES } from "../shared/languages";
import type { UnderstandSelection } from "../shared/messages";
import { stripCodeMarks } from "../shared/textMask";
import { selectionText } from "./pageText";
import { createShadowHost, el, SOURCE_LABEL } from "./shadowHost";

const CSS = `
  .panel { position: absolute; box-sizing: border-box; }
  .toolbar { display: inline-flex; gap: 4px; padding: 4px; border-radius: 999px; white-space: nowrap; }
  .toolbar button { border-radius: 999px; padding: 4px 12px; }
  .open { font-weight: 600; }
  .card { width: min(400px, calc(100vw - 24px)); overflow: hidden; }
  .head { display: flex; align-items: center; gap: 8px; padding: 10px 10px 8px 14px; border-bottom: 1px solid #e5e7eb; }
  .head h3 { flex: 1; margin: 0; font-size: 14px; font-weight: 600; }
  .x { border: none; background: transparent; color: inherit; font-size: 18px; line-height: 1; padding: 2px 8px; }
  .x:hover { background: rgba(127, 127, 127, .15); }
  .body { padding: 12px 14px; max-height: min(50vh, 380px); overflow: auto; }
  .result { margin: 0; font-size: 15px; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; }
  .result[lang="hi"] { font-size: 17px; line-height: 1.85; }
  .term { font-weight: 600; }
  .original { margin-top: 12px; }
  .original summary { cursor: pointer; font-size: 12px; color: #6b7280; }
  blockquote { margin: 6px 0 0; padding: 4px 10px; border-left: 3px solid #c7d2fe; font-size: 13px; color: #4b5563; max-height: 120px; overflow: auto; overflow-wrap: anywhere; }
  .note { margin: 10px 0 0; font-size: 12px; color: #6b7280; }
  .foot { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-top: 1px solid #e5e7eb; }
  .foot .chip { margin-right: auto; }
  .error { margin: 0; color: #b91c1c; font-weight: 600; }
  .loading { display: flex; align-items: center; gap: 10px; margin: 0; color: #4b5563; }
  .spinner { width: 16px; height: 16px; border-radius: 50%; border: 2px solid #c7d2fe; border-top-color: #4f46e5; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-color-scheme: dark) {
    .head, .foot { border-color: #374151; }
    blockquote { color: #d1d5db; border-color: #4338ca; }
    .original summary, .note, .loading { color: #9ca3af; }
    .error { color: #fca5a5; }
  }
`;
const TITLE: Record<SelectionKind, string> = { simplify: "✨ Explained simply", define: "📖 Definition", translate: "🌐 Hindi translation" };
const DEFINE_MAX_WORDS = 8;

/** Page coordinates: x and y below the selection's end, top above its start. */
interface Captured { text: string; context: string; plain: string; x: number; y: number; top: number }
export interface SelectionError { code: string; message: string; hint: string }

export class SelectionPopover {
  private host: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private captured: Captured | null = null;
  private pending: { id: string; kind: SelectionKind } | null = null;
  private enabled = false;

  constructor(private readonly send: (request: Omit<UnderstandSelection, "type">) => void) {}

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      document.addEventListener("mouseup", this.onSelectEnd);
      document.addEventListener("keyup", this.onKeyUp);
      document.addEventListener("mousedown", this.onPointerDown, true);
    } else {
      document.removeEventListener("mouseup", this.onSelectEnd);
      document.removeEventListener("keyup", this.onKeyUp);
      document.removeEventListener("mousedown", this.onPointerDown, true);
      this.close();
    }
  }

  /** A result for the current request, or one retried from the side panel. */
  showResult(requestId: string, result?: SelectionResult, error?: SelectionError): void {
    const retried = requestId.startsWith("retry-");
    if (!retried && this.pending?.id !== requestId) return;
    const kind = result?.kind ?? this.pending?.kind ?? "simplify";
    this.pending = null;
    const body: Array<Node | string> = [];
    const foot: Array<Node | string> = [];
    const original = result?.original ?? this.captured?.plain ?? "";
    if (result) {
      if (result.term) body.push(el("p", { class: "result" }, el("span", { class: "term" }, `${result.term.term}: `), result.term.definition));
      else body.push(el("p", { class: "result", ...(result.kind === "translate" ? { lang: "hi" } : {}) }, result.text ?? ""));
      for (const note of result.notes) body.push(el("p", { class: "note" }, note));
      const label = `${SOURCE_LABEL[result.source] ?? result.source}${result.gradeLevel ? ` · grade ${Math.round(result.gradeLevel)}` : ""}${result.cached ? " · saved" : ""}`;
      const copy = el("button", { type: "button" }, "Copy");
      copy.addEventListener("click", () => {
        void navigator.clipboard?.writeText(result.term ? `${result.term.term}: ${result.term.definition}` : result.text ?? "").then(() => { copy.textContent = "Copied"; });
      });
      foot.push(el("span", { class: "chip" }, label), copy);
    } else if (error) {
      body.push(el("p", { class: "error", role: "alert" }, error.message), el("p", { class: "note" }, error.hint));
      if (error.code === "consent-required") body.push(el("p", { class: "note" }, "Open the side panel (toolbar → Adaptive Web Layer → AI assistant) to allow cloud AI for this site."));
      if (kind === "translate" && error.code === "unsupported" && this.captured) {
        const local = el("button", { type: "button" }, "Use the local model (lower quality)");
        local.addEventListener("click", () => this.run("translate", true));
        foot.push(local);
      }
    }
    if (original) body.push(el("details", { class: "original" }, el("summary", {}, "Original text"), el("blockquote", {}, original)));
    this.renderCard(TITLE[kind], body, foot, retried && !this.host);
  }

  private onSelectEnd = (event: MouseEvent): void => {
    if (this.host && event.composedPath().includes(this.host)) return;
    setTimeout(() => this.capture(), 0);
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    if (event.key === "Escape") { this.close(); return; }
    if (event.shiftKey || event.key === "Shift") this.capture();
  };

  private onPointerDown = (event: MouseEvent): void => {
    if (this.host && !event.composedPath().includes(this.host) && !this.pending) this.close();
  };

  private capture(): void {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const anchor = range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    if (!anchor || anchor.closest("input, textarea, [contenteditable=''], [contenteditable='true'], pre, code, [data-awl-overlay]")) return;
    const { text, context } = selectionText(range);
    const plain = stripCodeMarks(text).trim();
    if (plain.length < 2) return;
    const rects = range.getClientRects();
    const rect = rects[rects.length - 1] ?? range.getBoundingClientRect();
    const first = rects[0] ?? rect;
    this.captured = { text, context, plain, x: rect.left + window.scrollX, y: rect.bottom + window.scrollY + 6, top: first.top + window.scrollY - 6 };
    this.pending = null;
    const open = el("button", { type: "button", class: "open", "aria-label": "Understand the selected text", title: "Explain, define or translate the selection" }, "✨ Understand");
    open.addEventListener("click", () => this.showActions());
    this.renderToolbar([open]);
  }

  private showActions(): void {
    if (!this.captured) return;
    if (this.captured.plain.length > MAX_SELECTION_CHARS) {
      this.renderCard("Selection too long", [el("p", { class: "note" }, `Select at most ${MAX_SELECTION_CHARS} characters (this selection has ${this.captured.plain.length}).`)], []);
      return;
    }
    const button = (label: string, kind: SelectionKind) => {
      const element = el("button", { type: "button" }, label);
      element.addEventListener("click", () => this.run(kind));
      return element;
    };
    const target = TARGET_LANGUAGES.find((language) => language.code === DEFAULT_TARGET);
    const actions = el("div", { class: "toolbar-row", role: "group", "aria-label": "Understand the selection", style: "display:contents" }, button("Explain simply", "simplify"));
    if (this.captured.plain.split(/\s+/).length <= DEFINE_MAX_WORDS) actions.append(button("Define", "define"));
    actions.append(button(`Translate to ${target?.nativeName ?? DEFAULT_TARGET}`, "translate"));
    this.renderToolbar([actions]);
    actions.querySelector("button")?.focus();
  }

  private run(kind: SelectionKind, local = false): void {
    if (!this.captured) return;
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.pending = { id, kind };
    this.send({ requestId: id, kind, text: this.captured.text, context: this.captured.context, target: kind === "translate" ? DEFAULT_TARGET : undefined, local: local || undefined });
    this.renderCard(TITLE[kind], [el("p", { class: "loading", role: "status" }, el("span", { class: "spinner", "aria-hidden": "true" }), "Working…")], []);
  }

  private mount(): HTMLElement {
    if (!this.host) {
      const { host, root } = createShadowHost("selection", CSS, "position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;");
      this.panel = el("div", { class: "panel" });
      root.append(this.panel);
      document.documentElement.append(host);
      this.host = host;
    }
    return this.panel!;
  }

  /** The small pill: "✨ Understand", then the three actions. */
  private renderToolbar(children: Array<Node | string>): void {
    const panel = this.mount();
    panel.className = "panel toolbar";
    panel.setAttribute("role", "toolbar");
    panel.setAttribute("aria-label", "Understand selection");
    panel.replaceChildren(...children);
    this.place(panel, false);
  }

  /** The result card: title and close in the header, result in the body, actions in the footer. */
  private renderCard(title: string, body: Array<Node | string>, foot: Array<Node | string>, floating = false): void {
    const panel = this.mount();
    panel.className = "panel card";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", title);
    const close = el("button", { type: "button", class: "x", "aria-label": "Close" }, "×");
    close.addEventListener("click", () => this.close());
    const parts: Node[] = [el("div", { class: "head" }, el("h3", {}, title), close), el("div", { class: "body" }, ...body)];
    if (foot.length) parts.push(el("div", { class: "foot" }, ...foot));
    panel.replaceChildren(...parts);
    this.place(panel, floating);
  }

  /** Below the selection if it fits, otherwise above it; always inside the viewport horizontally. */
  private place(panel: HTMLElement, floating: boolean): void {
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const minX = window.scrollX + 12;
    const maxX = window.scrollX + window.innerWidth - width - 12;
    if (floating || !this.captured) {
      panel.style.left = `${Math.max(minX, maxX - 4)}px`;
      panel.style.top = `${window.scrollY + 16}px`;
      return;
    }
    const below = this.captured.y;
    const fitsBelow = below + height <= window.scrollY + window.innerHeight - 8;
    const above = this.captured.top - height;
    panel.style.left = `${Math.max(minX, Math.min(this.captured.x, maxX))}px`;
    panel.style.top = `${fitsBelow || above < window.scrollY + 8 ? below : above}px`;
  }

  close(): void {
    this.host?.remove();
    this.host = null;
    this.panel = null;
    this.pending = null;
  }
}
