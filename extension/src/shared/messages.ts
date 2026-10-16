import { z } from "zod";
import { FONT_FAMILY_OPTIONS } from "./settings";

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
  signals: z.array(z.string()),
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
