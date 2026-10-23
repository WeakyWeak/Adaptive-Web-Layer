// ─── Inspector thresholds (P09) ──────────────────────────────────────────────
// The judgement part of each check, kept free of the DOM so it is unit-tested
// directly. The DOM side (inspector.ts) measures; these decide what counts.

import type { FindingType, Level } from "../shared/inspector";

/** Body text below this size (px) counts as small. */
export const SMALL_TEXT_PX = 14;
/** Line height as a multiple of the font size below which text is tight. */
export const TIGHT_LINE_HEIGHT = 1.3;
/** Characters per line: above LONG is hard to track, below NARROW is choppy. */
export const LONG_LINE_CHARS = 100;
export const NARROW_LINE_CHARS = 35;
/** A paragraph longer than this many characters is a wall of text. */
export const HUGE_BLOCK_CHARS = 1200;
/** A fixed or sticky bar taller than this share of the window covers content. */
export const STICKY_COVER_SHARE = 0.12;

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** `share` is the fraction of the page's body-text characters that are small. */
export function smallTextSeverity(smallestPx: number, share: number): Level | null {
  if (smallestPx >= SMALL_TEXT_PX) return null;
  if (share < 0.03) return "low";
  return smallestPx < 12 || share >= 0.25 ? "high" : "medium";
}

/** WCAG AA contrast: far below the minimum is high severity. */
export function contrastSeverity(ratio: number, required: number): Level | null {
  if (ratio >= required) return null;
  return ratio < required - 1.5 ? "high" : "medium";
}

export function lineHeightSeverity(ratio: number): Level | null {
  if (ratio >= TIGHT_LINE_HEIGHT) return null;
  return ratio < 1.15 ? "high" : "medium";
}

/** Typical characters per line in the main text, judged against the window width. */
export function lineLengthIssue(medianChars: number, viewportWidth: number): { type: Extract<FindingType, "long-lines" | "narrow-column">; severity: Level } | null {
  if (medianChars > LONG_LINE_CHARS) return { type: "long-lines", severity: medianChars > 130 ? "high" : "medium" };
  // A narrow column on a phone-sized window is expected.
  if (medianChars > 0 && medianChars < NARROW_LINE_CHARS && viewportWidth >= 700) return { type: "narrow-column", severity: medianChars < 25 ? "high" : "medium" };
  return null;
}

export function stickySeverity(share: number): Level | null {
  if (share < STICKY_COVER_SHARE) return null;
  return share >= 0.25 ? "high" : "medium";
}

export interface HeadingInfo { level: number; empty: boolean }

export interface HeadingIssue {
  type: Extract<FindingType, "no-h1" | "multiple-h1" | "skipped-heading" | "empty-heading">;
  severity: Level;
  /** Indexes into the heading list (the first is the one to highlight). */
  indexes: number[];
  detail: string;
}

/** Heading outline problems: no h1, several h1, skipped levels, empty headings. */
export function headingIssues(headings: readonly HeadingInfo[]): HeadingIssue[] {
  const issues: HeadingIssue[] = [];
  if (headings.length === 0) return [{ type: "no-h1", severity: "medium", indexes: [], detail: "The page has no headings at all." }];
  const h1 = headings.map((heading, index) => (heading.level === 1 ? index : -1)).filter((index) => index >= 0);
  if (h1.length === 0) issues.push({ type: "no-h1", severity: "medium", indexes: [0], detail: `No h1; the page starts at h${headings[0].level}.` });
  if (h1.length > 1) issues.push({ type: "multiple-h1", severity: "low", indexes: h1, detail: `${h1.length} h1 headings; usually one names the page.` });
  const skipped: number[] = [];
  const jumps: string[] = [];
  let previous = 0;
  headings.forEach((heading, index) => {
    if (previous > 0 && heading.level > previous + 1) {
      skipped.push(index);
      if (jumps.length < 3) jumps.push(`h${previous} → h${heading.level}`);
    }
    previous = heading.level;
  });
  if (skipped.length) issues.push({ type: "skipped-heading", severity: "medium", indexes: skipped, detail: `Heading levels skipped ${skipped.length}× (${jumps.join(", ")}).` });
  const empty = headings.map((heading, index) => (heading.empty ? index : -1)).filter((index) => index >= 0);
  if (empty.length) issues.push({ type: "empty-heading", severity: "medium", indexes: empty, detail: `${empty.length} empty heading${empty.length === 1 ? "" : "s"} (announced by screen readers with no text).` });
  return issues;
}
