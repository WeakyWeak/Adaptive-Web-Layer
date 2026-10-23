import { z } from "zod";
import { PlanChangesSchema, type PlanChanges } from "./aiFields";
import { ElementsSchema, MAX_BLOCKS, SnapshotBlockSchema } from "./elementPlan";
import { SITE_DEFAULT_TOKEN } from "./jsonSchema";

// ─── Plan returned by a model ────────────────────────────────────────────────
// A plan is a bounded patch over the user's settings (see aiFields.ts) plus,
// optionally, snapshot ids to hide/dim/highlight (see elementPlan.ts). Both are
// applied through the same settings resolver and Operation registry as saved
// preferences, so there is exactly one apply path.
export const PlanSchema = z.object({
  interpretedRequest: z.string().max(512),
  changes: PlanChangesSchema,
  elements: ElementsSchema.optional(),
  /** P10 drill-down: blocks the model wants to look inside before deciding. */
  expand: z.array(z.string().min(1).max(32)).max(3).optional(),
  reasons: z.array(z.string().max(512)).max(20).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
});
export type Plan = z.infer<typeof PlanSchema>;

export type PlanParseResult =
  | { ok: true; plan: Plan }
  | { ok: false; errors: string[] };

/**
 * Validate an untrusted model reply. Small models often wrap numbers in strings
 * or return the "default" enum token; normalise those before strict parsing.
 */
export function parsePlan(raw: unknown): PlanParseResult {
  if (!raw || typeof raw !== "object") return { ok: false, errors: ["Reply is not a JSON object."] };
  const candidate = { ...(raw as Record<string, unknown>) };
  if (candidate.changes && typeof candidate.changes === "object") {
    candidate.changes = Object.fromEntries(Object.entries(candidate.changes as Record<string, unknown>)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => [key, normaliseValue(value)]));
  }
  if (!Array.isArray(candidate.expand)) delete candidate.expand;
  else candidate.expand = (candidate.expand as unknown[]).filter((id) => typeof id === "string").slice(0, 3);
  if (candidate.elements === null || typeof candidate.elements !== "object") delete candidate.elements;
  else candidate.elements = Object.fromEntries(Object.entries(candidate.elements as Record<string, unknown>)
    .filter(([, value]) => Array.isArray(value)));
  if (typeof candidate.confidence === "number") candidate.confidence = Math.min(1, Math.max(0, candidate.confidence));
  const parsed = PlanSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, plan: parsed.data };
  return { ok: false, errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "plan"}: ${issue.message}`) };
}

function normaliseValue(value: unknown): unknown {
  if (value === SITE_DEFAULT_TOKEN) return "";
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

/** Drop changes that equal the current value; they would do nothing. */
export function effectiveChanges(changes: PlanChanges, current: Record<string, unknown>): PlanChanges {
  return Object.fromEntries(Object.entries(changes).filter(([key, value]) => current[key] !== value));
}

// ─── Provider errors ─────────────────────────────────────────────────────────
export type ProviderErrorCode =
  | "server-not-running"
  | "model-not-loaded"
  | "auth"
  | "timeout"
  | "cancelled"
  | "invalid-json"
  | "invalid-plan"
  | "no-changes"
  | "context-overflow"
  | "network"
  | "rate-limit"
  | "proxy-down"
  | "proxy-origin"
  | "not-configured"
  | "safety-block"
  | "consent-required"
  | "consent-denied"
  | "unsupported"
  | "unknown";

export class ProviderError extends Error {
  constructor(
    public code: ProviderErrorCode,
    message: string,
    public hint?: string
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

const HINTS: Record<ProviderErrorCode, string> = {
  "server-not-running": "Start llama-server, e.g. `llama-server -m <model.gguf> -ngl 99 -c 8192 --jinja --port 8080`.",
  "model-not-loaded": "The model may still be loading. Check the llama-server logs.",
  auth: "Check the API key or proxy token in Settings → AI.",
  timeout: "The model took too long. Try a smaller model or a shorter request.",
  cancelled: "The request was cancelled.",
  "invalid-json": "The model returned an unexpected response. Try again or switch model.",
  "invalid-plan": "The model's plan broke the safety rules twice. Try rephrasing, or use the suggested changes.",
  "no-changes": "Nothing needs to change for that request with the current settings.",
  "context-overflow": "The request exceeded the model's context limit. Raise -c on llama-server or use a shorter page.",
  network: "Network error while talking to the AI server.",
  "rate-limit": "The cloud provider is rate-limited. Wait a minute and try again.",
  "proxy-down": "Start the local proxy: `npm run dev --workspace=server`.",
  "proxy-origin": "The proxy rejected this extension's origin. Check ALLOWED_ORIGIN in server/.env.",
  "not-configured": "Add the provider's API key to server/.env and restart the proxy.",
  "safety-block": "The cloud provider declined this request.",
  "consent-required": "Cloud AI needs your consent before any page data is sent.",
  "consent-denied": "Cloud AI is denied for this site. Change it in Settings → Privacy & Consent.",
  unsupported: "This provider does not support that request.",
  unknown: "An unexpected error occurred.",
};

/** Human-readable message + recovery hint for the UI. */
export function formatProviderError(err: ProviderError): { message: string; hint: string } {
  return { message: err.message, hint: err.hint ?? HINTS[err.code] ?? HINTS.unknown };
}

export function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  return new ProviderError("unknown", err instanceof Error ? err.message : String(err));
}

// ─── DOM snapshot (built by content script, sent to background) ───────────────
export const DomSnapshotSchema = z.object({
  url: z.string(),
  title: z.string(),
  contentRegion: z.string(),
  headings: z.array(z.object({
    level: z.number(),
    text: z.string().max(200),
    id: z.string(),
  })).max(30),
  landmarks: z.array(z.object({
    role: z.string(),
    id: z.string(),
  })).max(20),
  textBlocks: z.array(z.object({
    id: z.string(),
    tagName: z.string(),
    textLength: z.number(),
    isProtected: z.boolean(),
  })).max(50),
  /** Candidate page blocks for element plans (P07); ids are the only handle a model gets. */
  blocks: z.array(SnapshotBlockSchema).max(MAX_BLOCKS).default([]),
  imageCnt: z.number(),
  tableCnt: z.number(),
  codeBlockCnt: z.number(),
  tokenEstimate: z.number(),
});
export type DomSnapshot = z.infer<typeof DomSnapshotSchema>;

// ─── Deterministic shortcut detection ─────────────────────────────────────────
export type ShortcutAction =
  | { type: "undo" }
  | { type: "reset" }
  | { type: "save-profile"; name: string }
  | { type: "turn-off" };

export function detectShortcut(input: string): ShortcutAction | null {
  const t = input.trim().toLowerCase();
  if (t === "undo" || t === "undo last" || t === "undo change") return { type: "undo" };
  if (t === "reset" || t === "reset page" || t === "revert") return { type: "reset" };
  if (t === "turn off" || t === "disable" || t === "turn off for this site") return { type: "turn-off" };

  // "save this as <name>" / "save as <name>"; keep the original casing.
  const saveMatch = input.trim().match(/^save(?:\s+this)?\s+as\s+(.+)$/i);
  if (saveMatch) {
    const name = saveMatch[1].trim();
    if (name.length >= 1 && name.length <= 64) return { type: "save-profile", name };
  }

  return null;
}
