import type { StyleLayer } from "../shared/registry";

// ─── Managed style layer ──────────────────────────────────────────────────────
// ONE <style data-awl> element owns all AWL-injected CSS.
// Rules are keyed by operation id; setting a key overwrites it; removing a key
// deletes the block. Revert = remove the rule entry.
// This ensures no scattered inline styles and easy full reset.

export class AWLStyleLayer implements StyleLayer {
  private readonly _el: HTMLStyleElement;
  private readonly _rules = new Map<string, string>();
  private _observer: MutationObserver | null = null;

  constructor() {
    // At document_start, <head> may not exist yet.
    const existing = document.querySelector<HTMLStyleElement>("style[data-awl]");
    if (existing) {
      this._el = existing;
    } else {
      this._el = document.createElement("style");
      this._el.setAttribute("data-awl", "1");
    }
    if (!this._attach()) this._waitForDocumentRoot();
  }

  set(opId: string, css: string): void {
    this._rules.set(opId, css);
    this._flush();
  }

  get(opId: string): string | undefined {
    return this._rules.get(opId);
  }

  remove(opId: string): void {
    this._rules.delete(opId);
    this._flush();
  }

  clear(): void {
    this._rules.clear();
    this._flush();
  }

  private _flush(): void {
    // Rebuild the stylesheet from the map
    // Each rule is prefixed with a comment for debuggability
    const parts: string[] = [];
    for (const [id, css] of this._rules) {
      parts.push(`/* AWL:${id} */\n${css}`);
    }
    this._el.textContent = parts.join("\n\n");
  }

  private _attach(): boolean {
    if (this._el.isConnected) return true;
    const parent = document.head ?? document.documentElement;
    if (!parent) return false;
    parent.appendChild(this._el);
    return true;
  }

  private _waitForDocumentRoot(): void {
    this._observer = new MutationObserver(() => {
      if (!this._attach()) return;
      this._observer?.disconnect();
      this._observer = null;
      this._flush();
    });
    this._observer.observe(document, { childList: true, subtree: true });
    document.addEventListener("DOMContentLoaded", () => {
      if (this._attach()) {
        this._observer?.disconnect();
        this._observer = null;
        this._flush();
      }
    }, { once: true });
  }
}

// Singleton for the content script
let _instance: AWLStyleLayer | null = null;

export function getStyleLayer(): AWLStyleLayer {
  if (!_instance) _instance = new AWLStyleLayer();
  return _instance;
}
