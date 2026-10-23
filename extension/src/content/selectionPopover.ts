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
  .panel { position: absolute; padding: 8px; max-width: 420px; }
  .row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .open { padding: 3px 9px; font-weight: 600; }
  h3 { margin: 0 0 6px; font-size: 13px; }
  blockquote { margin: 0 0 8px; padding: 4px 8px; border-left: 3px solid #c7d2fe; max-height: 90px; overflow: auto; }
  .result { margin: 0 0 8px; max-height: 260px; overflow: auto; white-space: pre-wrap; }
  .result[lang="hi"] { font-size: 16px; line-height: 1.7; }
  .error { color: #b91c1c; }
  @media (prefers-color-scheme: dark) { .error { color: #fca5a5; } }
`;
const TITLE: Record<SelectionKind, string> = { simplify: "Explained simply", define: "Definition", translate: "Translation" };
const DEFINE_MAX_WORDS = 8;

interface Captured { text: string; context: string; plain: string; x: number; y: number }
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
    const body: Array<Node | string> = [el("h3", {}, TITLE[kind])];
    const original = result?.original ?? this.captured?.plain ?? "";
    if (original) body.push(el("blockquote", { "aria-label": "Original text" }, original.length > 280 ? `${original.slice(0, 280)}…` : original));
    if (result) {
      if (result.term) body.push(el("p", { class: "result" }, el("strong", {}, `${result.term.term}: `), result.term.definition));
      else body.push(el("p", { class: "result", ...(result.kind === "translate" ? { lang: "hi" } : {}) }, result.text ?? ""));
      for (const note of result.notes) body.push(el("p", { class: "muted" }, note));
      const label = `${SOURCE_LABEL[result.source] ?? result.source}${result.gradeLevel ? ` · about grade ${Math.round(result.gradeLevel)}` : ""}${result.cached ? " · saved result" : ""}`;
      const copy = el("button", { type: "button" }, "Copy");
      copy.addEventListener("click", () => void navigator.clipboard?.writeText(result.term ? `${result.term.term}: ${result.term.definition}` : result.text ?? ""));
      body.push(el("div", { class: "row" }, el("span", { class: "chip" }, label), copy, this.closeButton()));
    } else if (error) {
      body.push(el("p", { class: "error", role: "alert" }, error.message), el("p", { class: "muted" }, error.hint));
      const row = el("div", { class: "row" });
      if (kind === "translate" && error.code === "unsupported" && this.captured) {
        const local = el("button", { type: "button" }, "Use the local model (lower quality)");
        local.addEventListener("click", () => this.run("translate", true));
        row.append(local);
      }
      if (error.code === "consent-required") body.push(el("p", { class: "muted" }, "Open the side panel (toolbar → Adaptive Web Layer → AI assistant) to allow cloud AI for this site."));
      row.append(this.closeButton());
      body.push(row);
    }
    this.render(body, retried && !this.host);
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
    this.captured = { text, context, plain, x: rect.left + window.scrollX, y: rect.bottom + window.scrollY + 6 };
    this.pending = null;
    const open = el("button", { type: "button", class: "open", "aria-label": "Understand the selected text", title: "Explain, define or translate the selection" }, "✨ Understand");
    open.addEventListener("click", () => this.showActions());
    this.render([open]);
  }

  private showActions(): void {
    if (!this.captured) return;
    if (this.captured.plain.length > MAX_SELECTION_CHARS) {
      this.render([el("p", { class: "muted" }, `Select at most ${MAX_SELECTION_CHARS} characters (this selection has ${this.captured.plain.length}).`), this.closeButton()]);
      return;
    }
    const button = (label: string, kind: SelectionKind) => {
      const element = el("button", { type: "button" }, label);
      element.addEventListener("click", () => this.run(kind));
      return element;
    };
    const target = TARGET_LANGUAGES.find((language) => language.code === DEFAULT_TARGET);
    const actions = el("div", { class: "row", role: "group", "aria-label": "Understand the selection" }, button("Explain simply", "simplify"));
    if (this.captured.plain.split(/\s+/).length <= DEFINE_MAX_WORDS) actions.append(button("Define", "define"));
    actions.append(button(`Translate to ${target?.nativeName ?? DEFAULT_TARGET}`, "translate"), this.closeButton());
    this.render([actions]);
    actions.querySelector("button")?.focus();
  }

  private run(kind: SelectionKind, local = false): void {
    if (!this.captured) return;
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.pending = { id, kind };
    this.send({ requestId: id, kind, text: this.captured.text, context: this.captured.context, target: kind === "translate" ? DEFAULT_TARGET : undefined, local: local || undefined });
    this.render([el("p", { class: "muted", role: "status" }, `${TITLE[kind]}: working…`), this.closeButton()]);
  }

  private closeButton(): HTMLButtonElement {
    const close = el("button", { type: "button" }, "Close");
    close.addEventListener("click", () => this.close());
    return close;
  }

  private render(children: Array<Node | string>, floating = false): void {
    if (!this.host) {
      const { host, root } = createShadowHost("selection", CSS, "position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;");
      this.panel = el("div", { class: "panel", role: "dialog", "aria-label": "Understand selection" });
      root.append(this.panel);
      document.documentElement.append(host);
      this.host = host;
    }
    const panel = this.panel!;
    panel.replaceChildren(...children);
    const width = Math.min(420, window.innerWidth - 24);
    const x = floating || !this.captured ? window.scrollX + window.innerWidth - width - 16 : Math.min(this.captured.x, window.scrollX + window.innerWidth - width - 12);
    const y = floating || !this.captured ? window.scrollY + 16 : this.captured.y;
    panel.style.left = `${Math.max(window.scrollX + 8, x)}px`;
    panel.style.top = `${y}px`;
  }

  close(): void {
    this.host?.remove();
    this.host = null;
    this.panel = null;
    this.pending = null;
  }
}
