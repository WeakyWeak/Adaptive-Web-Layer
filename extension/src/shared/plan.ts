import { z } from "zod";

// ─── Plan operation (one step in an AI-generated plan) ────────────────────────
// Models return op ids and params, NEVER selectors.
// targetRef is an optional stable element id from the DOM snapshot Map.
export const PlanOperationSchema = z.object({
  opId: z.string().min(1).max(64),
  params: z.record(z.unknown()),
  targetRef: z.string().optional(), // stable id from DOM snapshot
});
export type PlanOperation = z.infer<typeof PlanOperationSchema>;

// ─── Full plan returned by the AI model ──────────────────────────────────────
export const PlanSchema = z.object({
  interpretedRequest: z.string().max(512),
  operations: z.array(PlanOperationSchema).max(20),
  preserved: z.array(z.string()).max(20).default([]),
  reasons: z.array(z.string().max(256)).max(20).default([]),
  confidence: z.number().min(0).max(1).default(0.8),
});
export type Plan = z.infer<typeof PlanSchema>;

// ─── Validated plan (after the planner's allowlist + bounds checks) ────────────
export interface ValidatedPlan {
  plan: Plan;
  /** Operations that passed validation */
  validOps: PlanOperation[];
  /** Validation errors (op-level) */
  errors: string[];
}

// ─── Plan provider errors ─────────────────────────────────────────────────────
export type ProviderErrorCode =
  | "server-not-running"
  | "model-not-loaded"
  | "auth"
  | "timeout"
  | "invalid-json"
  | "context-overflow"
  | "network"
  | "rate-limit"
  | "proxy-down"
  | "safety-block"
  | "consent-required"
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

/** Human-readable message + optional recovery hint for the UI. */
export function formatProviderError(err: ProviderError): {
  message: string;
  hint: string;
} {
  const hints: Record<ProviderErrorCode, string> = {
    "server-not-running":
      "Start llama-server: `llama-server -m <model.gguf> -c 8192 --port 8080`",
    "model-not-loaded":
      "The model may not be loaded. Check your llama-server logs.",
    auth: "Check your API key. For llama-server use --api-key; for Ollama set OLLAMA_ORIGINS.",
    timeout:
      "The model took too long to respond. Try a smaller context size or shorter input.",
    "invalid-json":
      "The model returned an unexpected response. Try again or switch model.",
    "context-overflow":
      "Your request exceeded the model's context limit. Try a shorter page or simpler request.",
    network: "Network error communicating with the local AI server.",
    "rate-limit": "The cloud proxy is temporarily rate-limited. Wait a minute and try again.",
    "proxy-down": "The local cloud proxy is not running. Start it, then try again.",
    "safety-block": "The cloud provider declined this request for safety reasons.",
    "consent-required": "Cloud AI needs your consent before any page data is sent.",
    unknown: "An unexpected error occurred.",
  };
  return {
    message: err.message,
    hint: err.hint ?? hints[err.code] ?? hints.unknown,
  };
}

// ─── DOM snapshot (built by content script, sent to background) ───────────────
export const DomSnapshotSchema = z.object({
  url: z.string(),
  title: z.string(),
  contentRegion: z.string(), // CSS selector for the main content region
  headings: z.array(z.object({
    level: z.number(),
    text: z.string().max(200),
    id: z.string(), // stable snapshot id
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
  imageCnt: z.number(),
  tableCnt: z.number(),
  codeBlockCnt: z.number(),
  /** Current applied operations (opId → param summary) */
  currentOps: z.record(z.string()).default({}),
  /** Token count estimate */
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

  // "save this as <name>" / "save as <name>"
  // Use original input to preserve name casing
  const saveMatch = input.trim().match(/^[Ss]ave(?:\s+this)?\s+as\s+(.+)$/i);
  if (saveMatch) {
    const name = saveMatch[1].trim();
    if (name.length >= 1 && name.length <= 64) return { type: "save-profile", name };
  }

  return null;
}
