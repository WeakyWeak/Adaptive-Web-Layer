// ─── AI job record ───────────────────────────────────────────────────────────
// One job per tab, persisted in chrome.storage.session so the side panel can
// close and reopen (and the MV3 worker can restart) without losing the result.

import { z } from "zod";
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
  source: z.enum(["local", "cloud", "demo", "rules"]).optional(),
  interpretedRequest: z.string().optional(),
  changes: ChangesSchema.optional(),
  descriptions: z.array(z.string()).optional(),
  reasons: z.array(z.string()).optional(),
  confidence: z.number().optional(),
  warnings: z.array(z.string()).optional(),
  error: z.object({ code: z.string(), message: z.string(), hint: z.string() }).optional(),
  /** Keyword-based suggestion offered when AI fails. */
  fallback: z.object({ changes: ChangesSchema, descriptions: z.array(z.string()) }).optional(),
  /** Exact-host site rule before Apply; restored by Undo (null = there was none). */
  previousRule: SiteRuleSchema.nullable().optional(),
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
