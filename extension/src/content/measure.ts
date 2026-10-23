// ─── Page measurements for the supervised fix (P10) ──────────────────────────
// What the page looks like now, as numbers the background can compare before
// and after a change: the inspector's findings, how much main text is visible,
// how much of it a plan hides or dims on purpose, how much text the whole page
// shows, and how many protected elements (navigation, forms, alerts) are
// visible. Read-only; focus is never moved.

import type { InspectReport } from "../shared/inspector";
import { inspectPage, type InspectOptions } from "./inspector";

const PROTECTED = "nav, [role='navigation'], form, [role='search'], [role='alert'], [role='alertdialog']";
const MAX_PROTECTED = 200;

export interface PageMeasures {
  report: InspectReport;
  mainText: number;
  hiddenText: number;
  pageText: number;
  protectedVisible: number;
}

function visible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;
  const style = getComputedStyle(element);
  return style.visibility !== "hidden" && style.display !== "none";
}

const textLength = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim().length;

/** Visible text: innerText leaves out what CSS hides, but returns everything for an element that is not rendered at all. */
function shownText(element: HTMLElement): number {
  const shown = typeof element.checkVisibility !== "function" || element.checkVisibility();
  return shown ? textLength(element.innerText ?? element.textContent) : 0;
}

/** Text length of `region` hidden or dimmed on purpose by `hidden` (nested ones counted once). */
function hiddenTextIn(region: Element, hidden: readonly Element[]): number {
  const inside = hidden.filter((element) => region.contains(element) && element !== region);
  const outermost = inside.filter((element) => !inside.some((other) => other !== element && other.contains(element)));
  return outermost.reduce((total, element) => total + textLength(element.textContent), 0);
}

/** `hidden`: elements the plan hides or dims on purpose. */
export async function measurePage(doc: Document, options: Omit<InspectOptions, "testFocus"> & { hidden: readonly Element[] }): Promise<PageMeasures> {
  const report = await inspectPage(doc, { ...options, testFocus: false });
  // A previewed hide shrinks these; a hidden ancestor of the article empties mainText.
  const mainText = shownText(options.region as HTMLElement);
  const pageText = doc.body ? shownText(doc.body) : 0;
  const protectedVisible = Array.from(doc.querySelectorAll(PROTECTED)).slice(0, MAX_PROTECTED).filter(visible).length;
  return { report, mainText, hiddenText: hiddenTextIn(options.region, options.hidden), pageText, protectedVisible };
}
