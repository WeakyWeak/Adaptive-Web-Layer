// ─── Accessibility inspector (P09): findings, score, fixes ───────────────────
// The content script measures the page and reports findings in this format.
// Everything here is pure: the readability score, merging fixes into one
// settings patch, and what a model may see (numbers, never page text).

import { z } from "zod";
import { PlanChangesSchema, type PlanChanges } from "./aiFields";
import { zodToJsonSchema, type JsonSchema } from "./jsonSchema";

export const FINDING_TYPES = [
  "small-text",
  "low-contrast",
  "tight-line-height",
  "long-lines",
  "narrow-column",
  "huge-block",
  "no-h1",
  "multiple-h1",
  "skipped-heading",
  "empty-heading",
  "horizontal-overflow",
  "clipped-content",
  "overlap",
  "sticky-cover",
  "link-distinction",
  "focus-indicator",
] as const;
export type FindingType = typeof FINDING_TYPES[number];

export const LEVELS = ["high", "medium", "low"] as const;
export type Level = typeof LEVELS[number];

export const CATEGORIES = ["contrast", "text-size", "density", "width", "headings", "layout", "controls"] as const;
export type Category = typeof CATEGORIES[number];

export const CATEGORY_OF: Record<FindingType, Category> = {
  "small-text": "text-size",
  "low-contrast": "contrast",
  "tight-line-height": "density",
  "huge-block": "density",
  "long-lines": "width",
  "narrow-column": "width",
  "no-h1": "headings",
  "multiple-h1": "headings",
  "skipped-heading": "headings",
  "empty-heading": "headings",
  "horizontal-overflow": "layout",
  "clipped-content": "layout",
  overlap: "layout",
  "sticky-cover": "layout",
  "link-distinction": "controls",
  "focus-indicator": "controls",
};

export const CATEGORY_LABEL: Record<Category, string> = {
  contrast: "Text contrast",
  "text-size": "Text size",
  density: "Dense text",
  width: "Line length",
  headings: "Heading structure",
  layout: "Layout and overlap",
  controls: "Links and focus",
};

// ── Readability score ────────────────────────────────────────────────────────
// score = 100 − Σ over categories of min(cap, Σ severity × confidence)
// Weights: severity high 10, medium 5, low 2; confidence high ×1, medium ×0.6,
// low ×0.25 (an "uncertain" gradient finding costs a quarter of a measured one).
// Caps add up to 100, so one category can never take the whole score, and
// fixing (removing or downgrading) a finding can never lower it.
export const SEVERITY_WEIGHT: Record<Level, number> = { high: 10, medium: 5, low: 2 };
export const CONFIDENCE_WEIGHT: Record<Level, number> = { high: 1, medium: 0.6, low: 0.25 };
export const CATEGORY_CAP: Record<Category, number> = { contrast: 25, "text-size": 15, density: 15, width: 10, headings: 10, layout: 15, controls: 10 };

export const FixSchema = z.object({
  /** Settings patch (the same fields a model plan may use). */
  changes: PlanChangesSchema.default({}),
  /** Snapshot ids to hide (element ops, P07 format). */
  hide: z.array(z.string().min(1).max(32)).max(5).default([]),
  description: z.string().max(160),
});
export type Fix = z.infer<typeof FixSchema>;

export const FindingSchema = z.object({
  id: z.string().min(1).max(48),
  type: z.enum(FINDING_TYPES),
  severity: z.enum(LEVELS),
  confidence: z.enum(LEVELS),
  title: z.string().max(160),
  /** The measurement in words, e.g. "2.3:1 contrast (needs 4.5:1), 4 elements". */
  detail: z.string().max(300),
  /** Measured numbers (and colours); what the AI interpretation sees. */
  evidence: z.record(z.union([z.number(), z.string().max(40)])),
  /** Snapshot id of the most representative element, for highlighting. */
  elementRef: z.string().max(32).optional(),
  /** Short element label with a text preview; shown in the panel, never sent to a model. */
  label: z.string().max(120).optional(),
  suggestedFix: FixSchema.optional(),
  /** What to do when there is no automatic fix. */
  advice: z.string().max(240).optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const ContributorSchema = z.object({ category: z.enum(CATEGORIES), label: z.string(), penalty: z.number(), findings: z.number() });
export const ScoreSchema = z.object({ value: z.number().min(0).max(100), contributors: z.array(ContributorSchema).max(CATEGORIES.length) });
export type Score = z.infer<typeof ScoreSchema>;

const round1 = (value: number) => Math.round(value * 10) / 10;

export function findingPenalty(finding: Pick<Finding, "severity" | "confidence">): number {
  return SEVERITY_WEIGHT[finding.severity] * CONFIDENCE_WEIGHT[finding.confidence];
}

/** Readability score 0–100 and every category that lowered it, largest first. */
export function readabilityScore(findings: readonly Pick<Finding, "type" | "severity" | "confidence">[]): Score {
  const totals = new Map<Category, { sum: number; count: number }>();
  for (const finding of findings) {
    const category = CATEGORY_OF[finding.type];
    const total = totals.get(category) ?? { sum: 0, count: 0 };
    totals.set(category, { sum: total.sum + findingPenalty(finding), count: total.count + 1 });
  }
  const contributors = [...totals].map(([category, { sum, count }]) => ({ category, label: CATEGORY_LABEL[category], penalty: round1(Math.min(CATEGORY_CAP[category], sum)), findings: count }))
    .sort((a, b) => b.penalty - a.penalty || CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category));
  const lost = contributors.reduce((sum, item) => sum + item.penalty, 0);
  return { value: Math.max(0, Math.min(100, Math.round(100 - lost))), contributors };
}

export function scoreLabel(value: number): string {
  return value >= 85 ? "Good" : value >= 65 ? "Fair" : "Needs work";
}

// ── Fixes ────────────────────────────────────────────────────────────────────
// Width is a maximum, so the narrowest suggestion wins; every other number
// (size, spacing) takes the largest; switches are on if any fix turns them on.
const SMALLER_WINS = new Set(["maxContentWidth"]);

export function mergeFixes(fixes: readonly Fix[]): { changes: PlanChanges; hide: string[]; descriptions: string[] } {
  const changes: PlanChanges = {};
  for (const fix of fixes) {
    for (const [key, value] of Object.entries(fix.changes) as Array<[string, string | number | boolean]>) {
      const current = changes[key];
      if (typeof value === "number" && typeof current === "number") changes[key] = SMALLER_WINS.has(key) ? Math.min(current, value) : Math.max(current, value);
      else if (typeof value === "boolean" && typeof current === "boolean") changes[key] = current || value;
      else changes[key] = value;
    }
  }
  return {
    changes,
    hide: [...new Set(fixes.flatMap((fix) => fix.hide))],
    descriptions: [...new Set(fixes.map((fix) => fix.description))],
  };
}

// ── Report and per-tab state ─────────────────────────────────────────────────
export const MAX_FINDINGS = 60;

export const InspectReportSchema = z.object({
  findings: z.array(FindingSchema).max(MAX_FINDINGS),
  /** Elements looked at, and whether the scan stopped at its cap. */
  scanned: z.number().int().min(0),
  capped: z.boolean(),
  durationMs: z.number().min(0),
});
export type InspectReport = z.infer<typeof InspectReportSchema>;

/** What a model may say about the findings: a summary and an order, nothing else. */
export const InspectReplySchema = z.object({
  summary: z.string().min(1).max(600).describe("2 or 3 plain sentences: what most hurts readability on this page and why"),
  priorities: z.array(z.object({
    id: z.string().min(1).max(48).describe("A finding id from the list, exactly as given"),
    why: z.string().min(1).max(240).describe("One plain sentence on who this affects and why fixing it first helps"),
  })).max(5).describe("The most important findings first; at most 5"),
});
export type InspectReply = z.infer<typeof InspectReplySchema>;

export function inspectReplyJsonSchema(): JsonSchema {
  return zodToJsonSchema(InspectReplySchema);
}

export const InterpretationSchema = InspectReplySchema.extend({
  source: z.enum(["local", "cloud", "demo"]),
  /** Priorities whose id was not a finding (dropped). */
  dropped: z.number().int().min(0).default(0),
});
export type Interpretation = z.infer<typeof InterpretationSchema>;

export const InspectStateSchema = z.object({
  tabId: z.number(),
  url: z.string(),
  running: z.object({ id: z.string(), stage: z.string(), startedAt: z.number() }).optional(),
  report: InspectReportSchema.extend({ score: ScoreSchema, measuredAt: z.number() }).optional(),
  /** Score before the last applied fix, so the panel can show before → after. */
  previousScore: z.number().optional(),
  interpretation: InterpretationSchema.optional(),
  error: z.object({ during: z.enum(["inspect", "explain", "fix"]), code: z.string(), message: z.string(), hint: z.string() }).optional(),
  updatedAt: z.number(),
});
export type InspectState = z.infer<typeof InspectStateSchema>;

export const INSPECT_KEY_PREFIX = "awl_inspect_";
export const inspectKey = (tabId: number): string => `${INSPECT_KEY_PREFIX}${tabId}`;

export async function readInspect(tabId: number): Promise<InspectState | null> {
  try {
    const stored = await chrome.storage.session.get(inspectKey(tabId));
    const parsed = InspectStateSchema.safeParse(stored[inspectKey(tabId)]);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The findings as a model sees them: measurements only, no labels or page text. */
export function findingsForModel(findings: readonly Finding[]): Array<Pick<Finding, "id" | "type" | "severity" | "confidence" | "evidence"> & { fixable: boolean }> {
  return findings.map(({ id, type, severity, confidence, evidence, suggestedFix }) => ({ id, type, severity, confidence, evidence, fixable: Boolean(suggestedFix) }));
}

/** Keep only priorities that name a real finding, once each. */
export function checkInterpretation(reply: InspectReply, findings: readonly Finding[]): { reply: InspectReply; dropped: number } {
  const ids = new Set(findings.map((finding) => finding.id));
  const seen = new Set<string>();
  const priorities = reply.priorities.filter((item) => {
    if (!ids.has(item.id) || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  return { reply: { ...reply, priorities }, dropped: reply.priorities.length - priorities.length };
}

/** Demo mode / no-AI ordering: the findings that cost the most score first. */
export function rankFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => findingPenalty(b) - findingPenalty(a) || LEVELS.indexOf(a.severity) - LEVELS.indexOf(b.severity));
}
