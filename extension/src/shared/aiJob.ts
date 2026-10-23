// ─── AI job record ───────────────────────────────────────────────────────────
// One job per tab, persisted in chrome.storage.session so the side panel can
// close and reopen (and the MV3 worker can restart) without losing the result.

import { z } from "zod";
import { ElementItemSchema, RejectedElementSchema } from "./elementPlan";
import { LedgerEntrySchema, MeasuresSchema } from "./review";
import { SiteRuleSchema } from "./settings";

const ChangesSchema = z.record(z.union([z.string(), z.number(), z.boolean()]));

export const AiJobStatusSchema = z.enum([
  "running",   // waiting for a model
  "preview",   // changes are previewed on the page, not saved
  "applied",   // changes saved to the site rule; undo available
  "nothing",   // the model found nothing to change
  "error",     // failed; may carry a deterministic fallback suggestion
  "cancelled",
]);
export type AiJobStatus = z.infer<typeof AiJobStatusSchema>;

// ── P10 supervised fix: the stepper and the review ──────────────────────────
export const STEP_IDS = ["draft", "measure", "review", "final"] as const;
export const StepSchema = z.object({
  id: z.enum(STEP_IDS),
  status: z.enum(["pending", "running", "done", "skipped", "failed"]),
  note: z.string().max(240).optional(),
});
export type Step = z.infer<typeof StepSchema>;

export const SupervisionSchema = z.object({
  steps: z.array(StepSchema).max(STEP_IDS.length),
  /** off: local mode or Demo mode · not-reviewed: skipped (policy, no consent, cloud denied) · failed: the reviewer errored. */
  review: z.enum(["pending", "running", "reviewed", "not-reviewed", "failed", "off"]),
  /** Model id that reviewed (it may be the fallback model). */
  reviewer: z.string().max(128).optional(),
  verdict: z.enum(["approve", "revise"]).optional(),
  /** The reviewer's notes, or why there was no review. */
  note: z.string().max(400).optional(),
  /** Offer "Review with cloud AI" (hybrid/cloud, not reviewed yet). */
  canReview: z.boolean().default(false),
  /** The site has no cloud decision yet: show the consent card first. */
  needsConsent: z.boolean().default(false),
  ledger: z.array(LedgerEntrySchema).max(80).default([]),
  scores: z.object({ before: z.number().optional(), draft: z.number().optional(), final: z.number().optional() }).default({}),
  /** Measurements before any change; regressions are judged against them. */
  before: MeasuresSchema.optional(),
  /** Before/after screenshots are stored (see background/screenshot.ts). */
  shots: z.boolean().default(false),
  /** Why changes were undone automatically. */
  reverted: z.array(z.string().max(240)).max(10).default([]),
  /** Draft confidence and refusals, for the "when-unsure" policy. */
  confidence: z.number().min(0).max(1).optional(),
});
export type Supervision = z.infer<typeof SupervisionSchema>;

export const AiJobSchema = z.object({
  id: z.string(),
  tabId: z.number(),
  hostname: z.string(),
  request: z.string(),
  status: AiJobStatusSchema,
  stage: z.string(),
  received: z.number().default(0),
  startedAt: z.number(),
  updatedAt: z.number(),
  source: z.enum(["local", "cloud", "demo", "rules", "inspector"]).optional(),
  interpretedRequest: z.string().optional(),
  changes: ChangesSchema.optional(),
  descriptions: z.array(z.string()).optional(),
  /** Page blocks the plan hides/dims/highlights; protected hides start disabled. */
  elements: z.array(ElementItemSchema).optional(),
  /** Element items the validator refused, with reasons (never dropped silently). */
  rejectedElements: z.array(RejectedElementSchema).optional(),
  /** Element items that could not be turned into a saved selector on Apply. */
  unsaved: z.array(z.string()).optional(),
  reasons: z.array(z.string()).optional(),
  confidence: z.number().optional(),
  warnings: z.array(z.string()).optional(),
  error: z.object({ code: z.string(), message: z.string(), hint: z.string() }).optional(),
  /** Keyword-based suggestion offered when AI fails. */
  fallback: z.object({ changes: ChangesSchema, descriptions: z.array(z.string()), elements: z.array(ElementItemSchema).optional() }).optional(),
  /** Exact-host site rule before Apply; restored by Undo (null = there was none). */
  previousRule: SiteRuleSchema.nullable().optional(),
  /** P10: which button started it (typed request, Clean this page, Fix this page). */
  kind: z.enum(["ask", "clean", "fix"]).optional(),
  /** P10: draft → measure → review → final, with what happened to each item. */
  supervision: SupervisionSchema.optional(),
});
export type AiJob = z.infer<typeof AiJobSchema>;

export const JOB_KEY_PREFIX = "awl_job_";
export const jobKey = (tabId: number): string => `${JOB_KEY_PREFIX}${tabId}`;

export async function readJob(tabId: number): Promise<AiJob | null> {
  try {
    const stored = await chrome.storage.session.get(jobKey(tabId));
    const parsed = AiJobSchema.safeParse(stored[jobKey(tabId)]);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
