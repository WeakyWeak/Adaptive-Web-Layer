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

// ── P11: the dyslexia lens ───────────────────────────────────────────────────
// Sources (see docs/ARCHITECTURE.md): BDA style guide (left-aligned text, no
// ALL CAPS body text, off-white backgrounds), Rello & Baeza-Yates (italics
// read slowest). Thresholds are this project's choices, not clinical cut-offs.

/** Under the lens a paragraph longer than this is a wall of text (stricter than HUGE_BLOCK_CHARS). */
export const LENS_HUGE_BLOCK_CHARS = 600;
/** Median words per sentence above this is hard going. */
export const LONG_SENTENCE_WORDS = 20;
/** A word this many syllables long counts as long. */
export const LONG_WORD_SYLLABLES = 4;
/** Fewer words or sentences than these and the text is too short to judge. */
export const MIN_LENS_WORDS = 80;
export const MIN_LENS_SENTENCES = 4;

/** Share (0–1) of the body text styled a way the lens flags (justified, italic, CSS capitals). */
export function styledShareSeverity(share: number, minimum = 0.1): Level | null {
  if (share < minimum) return null;
  return share >= 0.5 ? "high" : share >= 0.25 ? "medium" : "low";
}

export function sentenceSeverity(medianWords: number): Level | null {
  if (medianWords <= LONG_SENTENCE_WORDS) return null;
  return medianWords > 28 ? "high" : "medium";
}

/** `share`: fraction of words with LONG_WORD_SYLLABLES or more (everyday English is about 3–5%). */
export function longWordSeverity(share: number): Level | null {
  if (share < 0.08) return null;
  return share >= 0.15 ? "high" : share >= 0.11 ? "medium" : "low";
}

/** Words in each sentence of `text` (a sentence ends at . ! or ? before a space and a capital, or at the end). */
export function sentenceLengths(text: string): number[] {
  return text.replace(/\s+/g, " ").split(/(?<=[.!?]["”’)]?)\s+(?=["“‘(]?[A-Z0-9])/)
    .map((sentence) => sentence.split(" ").filter((word) => /[A-Za-z0-9]/.test(word)).length)
    .filter((words) => words > 0);
}

/** Pure white behind pure black: the glare the BDA guide suggests softening. */
export function isGlare(background: { r: number; g: number; b: number }, text: { r: number; g: number; b: number }): boolean {
  return Math.min(background.r, background.g, background.b) >= 250 && Math.max(text.r, text.g, text.b) <= 20;
}

/** Text typed in capitals (not styled): at least 20 letters, 80% of them capitals. */
export function isLiteralCaps(text: string): boolean {
  const letters = text.replace(/[^A-Za-z]/g, "");
  return letters.length >= 20 && letters.replace(/[^A-Z]/g, "").length / letters.length >= 0.8;
}
