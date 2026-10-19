import { z } from "zod";
import { FONT_FAMILY_OPTIONS } from "./settings";
import { DomSnapshotSchema, PlanOperationSchema, PlanSchema } from "./plan";

// ─── Typed message protocol (Zod discriminated union) ───────────────────────
// All messages between popup ↔ content script ↔ background use this schema.
// New messages are added here and nowhere else.

// ── Popup → Content ──────────────────────────────────────────────────────────

export const GetPageInfoRequestSchema = z.object({
  type: z.literal("GET_PAGE_INFO"),
});
export type GetPageInfoRequest = z.infer<typeof GetPageInfoRequestSchema>;

// ── Content → Popup (response) ───────────────────────────────────────────────

export const PageInfoSchema = z.object({
  hostname: z.string(),
  url: z.string().url(),
  title: z.string(),
});
export type PageInfo = z.infer<typeof PageInfoSchema>;

export const GetPageInfoResponseSchema = z.object({
  type: z.literal("PAGE_INFO"),
  payload: PageInfoSchema,
});
export type GetPageInfoResponse = z.infer<typeof GetPageInfoResponseSchema>;

// ── Popup → Background ────────────────────────────────────────────────────────

export const PingRequestSchema = z.object({
  type: z.literal("PING"),
});
export type PingRequest = z.infer<typeof PingRequestSchema>;

// ── Background → Popup (response) ─────────────────────────────────────────────

export const PongResponseSchema = z.object({
  type: z.literal("PONG"),
  version: z.string(),
});
export type PongResponse = z.infer<typeof PongResponseSchema>;

// ── P01: Popup/Options → Content (live preview) ───────────────────────────────

export const TypographyPrefsPayloadSchema = z.object({
  fontFamily: z.enum(FONT_FAMILY_OPTIONS),
  fontSize: z.number(),
  lineHeight: z.number(),
  letterSpacing: z.number(),
  wordSpacing: z.number(),
  paragraphSpacing: z.number(),
  maxContentWidth: z.number(),
});

export const ApplyTypographySchema = z.object({
  type: z.literal("APPLY_TYPOGRAPHY"),
  payload: TypographyPrefsPayloadSchema,
  applyToWholePage: z.boolean().default(false),
});
export type ApplyTypography = z.infer<typeof ApplyTypographySchema>;

export const RevertTypographySchema = z.object({
  type: z.literal("REVERT_TYPOGRAPHY"),
});
export type RevertTypography = z.infer<typeof RevertTypographySchema>;

export const PageActionSchema = z.object({ type: z.enum(["UNDO_PAGE", "RESET_PAGE"]) });
export const GetAppearanceStatusSchema = z.object({ type: z.literal("GET_APPEARANCE_STATUS") });
export const AppearanceStatusSchema = z.object({
  type: z.literal("APPEARANCE_STATUS"),
  alreadyDark: z.boolean(),
  explicitDark: z.boolean(),
  signals: z.array(z.string()),
});
export const StartElementPickerSchema = z.object({ type: z.literal("START_ELEMENT_PICKER") });
export const GetFocusCandidatesSchema = z.object({ type: z.literal("GET_FOCUS_CANDIDATES") });
export const FocusCandidatesSchema = z.object({ type: z.literal("FOCUS_CANDIDATES"), candidates: z.array(z.object({ selector: z.string(), label: z.string() })) });

// ── P05: DOM snapshot (content → background) ────────────────────────────────
export const GetDomSnapshotSchema = z.object({ type: z.literal("GET_DOM_SNAPSHOT") });
export const DomSnapshotResponseSchema = z.object({
  type: z.literal("DOM_SNAPSHOT"),
  payload: DomSnapshotSchema,
});

// ── P05: NL command (popup → background) ─────────────────────────────────────
export const NlCommandSchema = z.object({
  type: z.literal("NL_COMMAND"),
  request: z.string().min(1).max(1000),
  /** tabId of the page to snapshot and apply to */
  tabId: z.number(),
});
export type NlCommand = z.infer<typeof NlCommandSchema>;

export const NlCommandResultSchema = z.object({
  type: z.literal("NL_COMMAND_RESULT"),
  ok: z.boolean(),
  /** The validated plan (if ok) */
  plan: PlanSchema.optional(),
  /** Human-readable descriptions of each operation */
  descriptions: z.array(z.string()).optional(),
  /** Interpreted request string */
  interpretedRequest: z.string().optional(),
  /** Confidence score */
  confidence: z.number().optional(),
  /** Validation warnings (non-fatal) */
  warnings: z.array(z.string()).optional(),
  /** Error message (if !ok) */
  error: z.string().optional(),
  /** Error code for typed handling */
  errorCode: z.string().optional(),
  /** Hint for the user on how to fix the error */
  hint: z.string().optional(),
  /** Host whose page data needs a cloud-consent choice. */
  consentHost: z.string().optional(),
  /** True if this was a shortcut (no AI call) */
  shortcut: z.boolean().optional(),
});
export type NlCommandResult = z.infer<typeof NlCommandResultSchema>;

// ── P05: Apply / revert NL plan (background → content via popup) ─────────────
export const ApplyNlPlanSchema = z.object({
  type: z.literal("APPLY_NL_PLAN"),
  operations: z.array(PlanOperationSchema),
  /** If true: temporary preview; if false: committed apply */
  preview: z.boolean().default(true),
});
export type ApplyNlPlan = z.infer<typeof ApplyNlPlanSchema>;

export const RevertNlPlanSchema = z.object({
  type: z.literal("REVERT_NL_PLAN"),
});

// ── P05: Provider status (popup → background) ─────────────────────────────────
export const GetProviderStatusSchema = z.object({ type: z.literal("GET_PROVIDER_STATUS") });
export const ProviderStatusSchema = z.object({
  type: z.literal("PROVIDER_STATUS"),
  ok: z.boolean(),
  latencyMs: z.number().optional(),
  modelId: z.string().optional(),
  error: z.string().optional(),
  demoMode: z.boolean().default(false),
  provider: z.enum(["local", "cloud"]).optional(),
});
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

export const TestProviderConnectionSchema = z.object({
  type: z.literal("TEST_PROVIDER_CONNECTION"),
  provider: z.enum(["local", "cloud"]),
});

export const SetCloudConsentSchema = z.object({
  type: z.literal("SET_CLOUD_CONSENT"),
  hostname: z.string().min(1).max(253),
  decision: z.enum(["allow-once", "allow-site", "deny"]),
});

// ── Generic ack ───────────────────────────────────────────────────────────────

export const AckSchema = z.object({
  type: z.literal("ACK"),
  ok: z.boolean(),
  error: z.string().optional(),
});
export type Ack = z.infer<typeof AckSchema>;

// ── Discriminated unions ───────────────────────────────────────────────────────

export const AnyMessageSchema = z.discriminatedUnion("type", [
  GetPageInfoRequestSchema,
  GetPageInfoResponseSchema,
  PingRequestSchema,
  PongResponseSchema,
  ApplyTypographySchema,
  RevertTypographySchema,
  PageActionSchema,
  GetAppearanceStatusSchema,
  AppearanceStatusSchema,
  StartElementPickerSchema,
  GetFocusCandidatesSchema,
  FocusCandidatesSchema,
  // P05
  GetDomSnapshotSchema,
  DomSnapshotResponseSchema,
  NlCommandSchema,
  NlCommandResultSchema,
  ApplyNlPlanSchema,
  RevertNlPlanSchema,
  GetProviderStatusSchema,
  ProviderStatusSchema,
  TestProviderConnectionSchema,
  SetCloudConsentSchema,
  AckSchema,
]);
export type AnyMessage = z.infer<typeof AnyMessageSchema>;

// ── Safe parse helper ─────────────────────────────────────────────────────────

export function parseMessage(raw: unknown): AnyMessage | null {
  const result = AnyMessageSchema.safeParse(raw);
  if (!result.success) {
    console.warn("[AWL] Unknown message:", raw, result.error.flatten());
    return null;
  }
  return result.data;
}
