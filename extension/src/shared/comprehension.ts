// ─── Comprehension jobs (P08): TL;DR, glossary, simplify, define, translate ──
// Reply schemas (Zod, with generated JSON Schema), checks on what a model says,
// and the per-tab "Understand this page" state the side panel renders.

import { z } from "zod";
import { zodToJsonSchema, type JsonSchema } from "./jsonSchema";
import { TARGET_CODES } from "./languages";

export const PAGE_KINDS = ["summarize", "glossary"] as const;
export const SELECTION_KINDS = ["simplify", "define", "translate"] as const;
export type PageKind = typeof PAGE_KINDS[number];
export type SelectionKind = typeof SELECTION_KINDS[number];
export type ComprehensionKind = PageKind | SelectionKind;

export const MAX_TERMS = 12;
export const MAX_DEFINITION_WORDS = 25;
export const MAX_SELECTION_CHARS = 4000;
/** Words per minute used for the reading-time estimate. */
const READING_WPM = 220;

// ── Model replies ────────────────────────────────────────────────────────────
export const SummaryReplySchema = z.object({
  bullets: z.array(z.string().min(1).max(300)).min(3).max(5).describe("3 to 5 short, plain sentences covering the main points"),
  readingMinutes: z.number().int().min(0).max(600).describe("Estimated minutes to read the whole text"),
  keyTerms: z.array(z.string().min(1).max(60)).max(8).describe("Up to 8 important terms, copied exactly from the text"),
});
export const GlossaryReplySchema = z.object({
  terms: z.array(z.object({
    term: z.string().min(1).max(60).describe("Copied exactly from the text"),
    definition: z.string().min(1).max(300).describe(`Plain-English meaning, at most ${MAX_DEFINITION_WORDS} words`),
  })).max(MAX_TERMS),
});
export const SimplifyReplySchema = z.object({
  text: z.string().min(1).max(8000).describe("The same content in plain English; placeholders like [[1]] copied unchanged"),
  gradeLevel: z.number().min(1).max(16).describe("School grade level of your rewrite"),
});
export const TranslateReplySchema = z.object({
  text: z.string().min(1).max(12000).describe("The translation; placeholders like [[1]] copied unchanged"),
});

export const REPLY_SCHEMAS = {
  summarize: SummaryReplySchema,
  glossary: GlossaryReplySchema,
  simplify: SimplifyReplySchema,
  define: GlossaryReplySchema,
  translate: TranslateReplySchema,
} as const satisfies Record<ComprehensionKind, z.ZodTypeAny>;

export function replyJsonSchema(kind: ComprehensionKind): JsonSchema {
  return zodToJsonSchema(REPLY_SCHEMAS[kind]);
}

// ── Checks on replies (page text is untrusted; so is what a model makes of it) ──
const normalise = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

export interface GlossaryTerm { term: string; definition: string }

/** Keeps terms that occur in the source, with short definitions; one entry per term. */
export function verifyGlossary(terms: readonly GlossaryTerm[], source: string): { terms: GlossaryTerm[]; dropped: string[] } {
  const haystack = normalise(source);
  const kept: GlossaryTerm[] = [];
  const dropped: string[] = [];
  for (const { term, definition } of terms) {
    const clean = term.trim();
    const ok = clean.length > 1 && !clean.includes("[[") && haystack.includes(normalise(clean))
      && wordCount(definition) <= MAX_DEFINITION_WORDS && !kept.some((item) => normalise(item.term) === normalise(clean));
    if (ok && kept.length < MAX_TERMS) kept.push({ term: clean, definition: definition.trim() });
    else dropped.push(clean);
  }
  return { terms: kept, dropped };
}

const LINKISH = /\b(?:https?:\/\/|www\.)[^\s<>"'()]*[^\s<>"'().,;:!?]|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gi;

/**
 * Drops summary sentences that bring in a link or email that is not in the
 * page (the usual shape of an injected "tell the reader to visit …").
 */
export function verifyBullets(bullets: readonly string[], source: string): { bullets: string[]; dropped: number } {
  const kept = bullets.filter((bullet) => (bullet.match(LINKISH) ?? []).every((link) => source.includes(link)));
  return { bullets: kept, dropped: bullets.length - kept.length };
}

export function readingMinutes(text: string): number {
  return Math.max(1, Math.round(wordCount(text) / READING_WPM));
}

export function hasDevanagari(text: string): boolean {
  return /[ऀ-ॿ]/.test(text);
}

// ── Results kept for the side panel and the in-page UI ──────────────────────
export const ResultSourceSchema = z.enum(["local", "cloud", "sarvam", "demo"]);
export type ResultSource = z.infer<typeof ResultSourceSchema>;
const Meta = { source: ResultSourceSchema, cached: z.boolean().default(false), notes: z.array(z.string()).default([]) };

export const GlossaryTermSchema = z.object({ term: z.string().max(60), definition: z.string().max(300) });

export const SummaryResultSchema = z.object({
  bullets: z.array(z.string().max(600)).max(5),
  readingMinutes: z.number(),
  keyTerms: z.array(z.string().max(60)).max(8),
  /** Share of the main text the summary covers (long pages are cut to a budget). */
  coverage: z.number().min(0).max(1),
  ...Meta,
});
export type SummaryResult = z.infer<typeof SummaryResultSchema>;

export const GlossaryResultSchema = z.object({ terms: z.array(GlossaryTermSchema).max(MAX_TERMS), shown: z.boolean().default(false), ...Meta });
export type GlossaryResult = z.infer<typeof GlossaryResultSchema>;

export const SelectionResultSchema = z.object({
  kind: z.enum(SELECTION_KINDS),
  original: z.string().max(MAX_SELECTION_CHARS),
  text: z.string().max(16000).optional(),
  gradeLevel: z.number().optional(),
  term: GlossaryTermSchema.optional(),
  target: z.enum(TARGET_CODES).optional(),
  ...Meta,
});
export type SelectionResult = z.infer<typeof SelectionResultSchema>;

export const UnderstandStateSchema = z.object({
  tabId: z.number(),
  url: z.string(),
  summary: SummaryResultSchema.optional(),
  glossary: GlossaryResultSchema.optional(),
  selection: SelectionResultSchema.optional(),
  running: z.object({ id: z.string(), kind: z.enum([...PAGE_KINDS, ...SELECTION_KINDS]), stage: z.string(), startedAt: z.number() }).optional(),
  error: z.object({
    kind: z.enum([...PAGE_KINDS, ...SELECTION_KINDS]),
    code: z.string(),
    message: z.string(),
    hint: z.string(),
    /** The selection, kept (session only) so the side panel can retry it. */
    selection: z.object({ text: z.string().max(MAX_SELECTION_CHARS), context: z.string().max(2000) }).optional(),
  }).optional(),
  updatedAt: z.number(),
});
export type UnderstandState = z.infer<typeof UnderstandStateSchema>;

export const UNDERSTAND_KEY_PREFIX = "awl_understand_";
export const understandKey = (tabId: number): string => `${UNDERSTAND_KEY_PREFIX}${tabId}`;

export async function readUnderstand(tabId: number): Promise<UnderstandState | null> {
  try {
    const stored = await chrome.storage.session.get(understandKey(tabId));
    const parsed = UnderstandStateSchema.safeParse(stored[understandKey(tabId)]);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
