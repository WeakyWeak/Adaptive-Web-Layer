// ─── Marker helpers for operations that depend on computed styles ───────────
// CSS cannot select "text that is italic" or "a paragraph on a white
// background", so these operations read computed styles once, mark matching
// elements with a data attribute (one token per apply), and style the marks
// from their stylesheet entry. Revert removes the marks and the entry.

import { PROTECTED_SELECTOR } from "./domUtils";

export const INITIAL_LIMIT = 3000;
const BATCH_LIMIT = 600;
/** Never marked: protected content (code, media, controls) and the extension's own UI. */
export const SKIP = `${PROTECTED_SELECTOR}, script, style, noscript, [data-awl-overlay], [data-awl-picker]`;

/** A short random token, so marks from an earlier apply never match the new rules. */
export function markerToken(): string {
  return globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
}

export function hasOwnText(element: Element): boolean {
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === 3 && (node.textContent ?? "").trim().length > 1) return true;
  }
  return false;
}

/** Remove every `attribute` mark that belongs to `token`. */
export function clearMarks(attribute: string, token: string): void {
  document.querySelectorAll(`[${attribute}^="${token}-"]`).forEach((element) => element.removeAttribute(attribute));
}

/** Content added later (infinite scroll, SPA renders), handed over in small batches; returns stop(). */
export function watchAdded(onBatch: (batch: Element[]) => void): () => void {
  const added = new Set<Element>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const observer = new MutationObserver((records) => {
    for (const record of records) record.addedNodes.forEach((node) => { if (node instanceof Element && !node.matches(SKIP)) added.add(node); });
    if (added.size && !timer) timer = setTimeout(() => {
      timer = null;
      const batch = [...added].flatMap((root) => [root, ...Array.from(root.querySelectorAll("*"))]).slice(0, BATCH_LIMIT);
      added.clear();
      onBatch(batch);
    }, 200);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    if (timer) clearTimeout(timer);
  };
}
