// ─── Element preview markers (P07) ───────────────────────────────────────────
// A previewed element plan names snapshot ids. To run it through the normal
// focus operations, each live element gets a marker attribute carrying a
// per-page random token, and the operations receive `[data-awl-preview=…]`
// selectors. The token means page markup cannot pre-mark other elements.
// Markers are removed when the preview is cleared.

import type { PreviewElements } from "../shared/elementPlan";
import type { SiteElements } from "../shared/sitePatch";
import { resolveSnapshotId } from "./domSnapshot";

const ATTRIBUTE = "data-awl-preview";
const token = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
const marked = new Map<string, Element>();

function selectorFor(id: string): string | null {
  const element = resolveSnapshotId(id);
  if (!element) return null;
  const value = `${token}-${id}`;
  if (element.getAttribute(ATTRIBUTE) !== value) element.setAttribute(ATTRIBUTE, value);
  marked.set(id, element);
  return `[${ATTRIBUTE}="${value}"]`;
}

/** Marker selectors for a previewed plan; `skip` is left out (hover "peek"). */
export function previewSelectors(elements: PreviewElements, skip: string | null = null): SiteElements {
  const pick = (ids: string[]) => ids.filter((id) => id !== skip).map(selectorFor).filter((selector): selector is string => selector !== null);
  return { hide: pick(elements.hide), dim: pick(elements.dim), highlight: pick(elements.highlight) };
}

export function clearPreviewMarks(): void {
  for (const element of marked.values()) element.removeAttribute(ATTRIBUTE);
  marked.clear();
}
