import { z } from "zod";
import { FONT_FAMILY_OPTIONS } from "./settings";
import { DomSnapshotSchema } from "./plan";
import { PreviewElementsSchema } from "./elementPlan";
import { GlossaryTermSchema, MAX_SELECTION_CHARS, PAGE_KINDS, SELECTION_KINDS, SelectionResultSchema, SummaryResultSchema } from "./comprehension";
import { TARGET_CODES } from "./languages";

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

// ── P06R: AI commands (side panel → background) ─────────────────────────────
// Results are not returned in the reply: the background writes the job record
// to chrome.storage.session and the side panel renders whatever is stored.
const TabIdSchema = z.number().int().nonnegative();
export const AiRunSchema = z.object({ type: z.literal("AI_RUN"), tabId: TabIdSchema, request: z.string().trim().min(1).max(1000) });
export const AiJobActionSchema = z.object({
  type: z.enum(["AI_CANCEL", "AI_APPLY", "AI_DISCARD", "AI_UNDO", "AI_USE_FALLBACK"]),
  tabId: TabIdSchema,
});
export const AiSaveProfileSchema = z.object({ type: z.literal("AI_SAVE_PROFILE"), tabId: TabIdSchema, name: z.string().trim().min(1).max(64) });
/** P07: per-item toggle in a preview; enabling a protected hide is the user's confirmation. */
export const AiSetElementSchema = z.object({ type: z.literal("AI_SET_ELEMENT"), tabId: TabIdSchema, id: z.string().min(1).max(32), enabled: z.boolean() });

// ── P06R: Preview overlay (background → content) ────────────────────────────
export const SetPreviewSchema = z.object({
  type: z.literal("SET_PREVIEW"),
  /** Changes previewed on top of saved settings; null clears the preview. */
  changes: z.record(z.union([z.string(), z.number(), z.boolean()])).nullable(),
  /** Snapshot ids previewed as hidden/dimmed/highlighted (P07). */
  elements: PreviewElementsSchema.optional(),
});
export type SetPreview = z.infer<typeof SetPreviewSchema>;

// ── P07: element plans (background/side panel → content) ───────────────────
/** Turn snapshot ids into selectors that survive a reload (for Apply). */
export const ResolveSelectorsSchema = z.object({ type: z.literal("RESOLVE_SELECTORS"), ids: z.array(z.string().min(1).max(32)).max(60) });
export const SelectorsSchema = z.object({ type: z.literal("SELECTORS"), selectors: z.record(z.string().nullable()) });
/** Outline one snapshot block on the page (null clears the outline). */
export const OutlineElementSchema = z.object({ type: z.literal("OUTLINE_ELEMENT"), id: z.string().min(1).max(32).nullable() });
/** Which saved element selectors no longer match anything on this page. */
export const CheckSavedSelectorsSchema = z.object({ type: z.literal("CHECK_SAVED_SELECTORS") });
export const SavedSelectorsSchema = z.object({ type: z.literal("SAVED_SELECTORS"), total: z.number(), stale: z.array(z.string()) });

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
export type TestProviderConnection = z.infer<typeof TestProviderConnectionSchema>;

export const SetCloudConsentSchema = z.object({
  type: z.literal("SET_CLOUD_CONSENT"),
  hostname: z.string().min(1).max(253),
  decision: z.enum(["allow-once", "allow-site", "deny"]),
});

// ── Generic ack ───────────────────────────────────────────────────────────────

// ── P08: comprehension ─────────────────────────────────────────────────────────
// Side panel → background
export const UnderstandRunSchema = z.object({ type: z.literal("UNDERSTAND_RUN"), tabId: z.number().int().nonnegative(), kind: z.enum(PAGE_KINDS), refresh: z.boolean().optional() });
export const UnderstandHideSchema = z.object({ type: z.literal("UNDERSTAND_HIDE"), tabId: z.number().int().nonnegative(), what: z.enum(["summary", "glossary"]) });
export const UnderstandRetrySchema = z.object({ type: z.literal("UNDERSTAND_RETRY"), tabId: z.number().int().nonnegative(), local: z.boolean().optional() });
export const UnderstandCancelSchema = z.object({ type: z.literal("UNDERSTAND_CANCEL"), tabId: z.number().int().nonnegative() });
// Content (selection popover) → background; the tab comes from the sender.
export const UnderstandSelectionSchema = z.object({
  type: z.literal("UNDERSTAND_SELECTION"),
  requestId: z.string().min(1).max(64),
  kind: z.enum(SELECTION_KINDS),
  // Code markers from the extractor may add a little to the visible length.
  text: z.string().min(1).max(MAX_SELECTION_CHARS + 400),
  context: z.string().max(2000).default(""),
  target: z.enum(TARGET_CODES).optional(),
  local: z.boolean().optional(),
});
// Background → content
export const GetPageTextSchema = z.object({ type: z.literal("GET_PAGE_TEXT") });
export const PageTextSchema = z.object({ type: z.literal("PAGE_TEXT"), url: z.string(), title: z.string(), text: z.string().max(400_000), skippedCode: z.number() });
export const ShowSummarySchema = z.object({ type: z.literal("SHOW_SUMMARY"), summary: SummaryResultSchema.nullable() });
export const ShowGlossarySchema = z.object({ type: z.literal("SHOW_GLOSSARY"), terms: z.array(GlossaryTermSchema).nullable() });
export const SelectionResultMessageSchema = z.object({
  type: z.literal("SELECTION_RESULT"),
  requestId: z.string().max(64),
  result: SelectionResultSchema.optional(),
  error: z.object({ code: z.string(), message: z.string(), hint: z.string() }).optional(),
});
export type PageText = z.infer<typeof PageTextSchema>;
export type UnderstandSelection = z.infer<typeof UnderstandSelectionSchema>;

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
  AiRunSchema,
  AiJobActionSchema,
  AiSaveProfileSchema,
  AiSetElementSchema,
  SetPreviewSchema,
  ResolveSelectorsSchema,
  SelectorsSchema,
  OutlineElementSchema,
  CheckSavedSelectorsSchema,
  SavedSelectorsSchema,
  GetProviderStatusSchema,
  ProviderStatusSchema,
  TestProviderConnectionSchema,
  SetCloudConsentSchema,
  // P08
  UnderstandRunSchema,
  UnderstandHideSchema,
  UnderstandRetrySchema,
  UnderstandCancelSchema,
  UnderstandSelectionSchema,
  GetPageTextSchema,
  PageTextSchema,
  ShowSummarySchema,
  ShowGlossarySchema,
  SelectionResultMessageSchema,
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
