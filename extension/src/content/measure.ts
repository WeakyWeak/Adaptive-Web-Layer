// ─── Page measurements for the supervised fix (P10) ──────────────────────────
// What the page looks like now, as numbers the background can compare before
// and after a change: the inspector's findings, how much main text is visible,
// how much of it a plan hides on purpose, and how many protected elements
// (navigation, forms, alerts) are visible. Read-only; focus is never moved.

import type { InspectReport } from "../shared/inspector";
import { inspectPage, type InspectOptions } from "./inspector";

const PROTECTED = "nav, [role='navigation'], form, [role='search'], [role='alert'], [role='alertdialog']";
const MAX_PROTECTED = 200;

export interface PageMeasures {
  report: InspectReport;
  mainText: number;
  hiddenText: number;
  protectedVisible: number;
}

function visible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;
  const style = getComputedStyle(element);
  return style.visibility !== "hidden" && style.display !== "none";
}

/** Text length of `region` hidden on purpose by `hidden` (nested hides counted once). */
function hiddenTextIn(region: Element, hidden: readonly Element[]): number {
  const inside = hidden.filter((element) => region.contains(element) && element !== region);
  const outermost = inside.filter((element) => !inside.some((other) => other !== element && other.contains(element)));
  return outermost.reduce((total, element) => total + (element.textContent ?? "").replace(/\s+/g, " ").trim().length, 0);
}

export async function measurePage(doc: Document, options: Omit<InspectOptions, "testFocus"> & { hidden: readonly Element[] }): Promise<PageMeasures> {
  const report = await inspectPage(doc, { ...options, testFocus: false });
  const region = options.region as HTMLElement;
  // innerText leaves out what CSS hides, so a previewed hide shrinks it.
  const mainText = (region.innerText ?? region.textContent ?? "").replace(/\s+/g, " ").trim().length;
  const protectedVisible = Array.from(doc.querySelectorAll(PROTECTED)).slice(0, MAX_PROTECTED).filter(visible).length;
  return { report, mainText, hiddenText: hiddenTextIn(options.region, options.hidden), protectedVisible };
}
