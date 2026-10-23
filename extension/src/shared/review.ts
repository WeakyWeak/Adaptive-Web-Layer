// ─── Supervised fix (P10): the cloud reviews the local model's draft ─────────
// The local model drafts a plan, code measures it, a cloud model reviews the
// draft against the measurements and screenshots, and code folds the review
// back in through the same validators a plan goes through. Everything here is
// pure: the reply schema, merging a review into a draft, and the regression
// checks that undo any change which makes the page measurably worse.

import { z } from "zod";
import { AI_FIELDS, describeChange, PlanChangesSchema, type PlanChanges } from "./aiFields";
import { blockLabel, dropUnrequestedElements, ELEMENT_ACTIONS, ElementsSchema, validateElements, type ElementAction, type ElementItem, type Elements, type RejectedElement } from "./elementPlan";
import type { FindingType } from "./inspector";
import { fieldJsonSchema, type JsonSchema } from "./jsonSchema";
import type { DomSnapshot } from "./plan";

// ── What the reviewer may answer ─────────────────────────────────────────────
export const MAX_MISSED_REGIONS = 3;

const RegionSchema = z.object({
  /** Left, top, width and height in % of the screenshot (the visible viewport). */
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
  w: z.number().min(0).max(100),
  h: z.number().min(0).max(100),
  action: z.enum(ELEMENT_ACTIONS),
  reason: z.string().max(200),
});
export type MissedRegion = z.infer<typeof RegionSchema>;

export const ReviewReplySchema = z.object({
  verdict: z.enum(["approve", "revise"]),
  drop: z.array(z.object({ ref: z.string().min(1).max(40), reason: z.string().max(200) })).max(20),
  add: z.object({ changes: z.record(z.unknown()), elements: ElementsSchema }),
  missedRegions: z.array(RegionSchema).max(MAX_MISSED_REGIONS),
  notes: z.string().max(400),
});
export type ReviewReply = z.infer<typeof ReviewReplySchema>;

/**
 * Every property is required (lists may be empty): llama.cpp-style grammars
 * emit optional properties last, where a model never reaches them, and some
 * providers silently skip optional ones.
 */
export function reviewJsonSchema(draftRefs: readonly string[], blockIds: readonly string[]): JsonSchema {
  // Enum values must be unique (drill-down can list a block twice).
  const ids: JsonSchema = blockIds.length ? { type: "string", enum: [...new Set(blockIds)] } : { type: "string" };
  const list = (action: string): JsonSchema => ({ type: "array", maxItems: 15, items: ids, description: `Block ids to ${action} that the draft missed` });
  return {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "drop", "add", "missedRegions", "notes"],
    properties: {
      verdict: { type: "string", enum: ["approve", "revise"], description: "approve if the draft is good as it is" },
      drop: {
        type: "array",
        maxItems: 20,
        description: "Draft items to remove, by ref, each with a short reason",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["ref", "reason"],
          properties: { ref: draftRefs.length ? { type: "string", enum: [...new Set(draftRefs)] } : { type: "string" }, reason: { type: "string", maxLength: 200 } },
        },
      },
      add: {
        type: "object",
        additionalProperties: false,
        required: ["changes", "elements"],
        properties: {
          changes: { type: "object", additionalProperties: false, properties: Object.fromEntries(AI_FIELDS.map((field) => [field.key, fieldJsonSchema(field)])), description: "Settings to add or change; empty if none" },
          elements: { type: "object", additionalProperties: false, required: [...ELEMENT_ACTIONS], properties: Object.fromEntries(ELEMENT_ACTIONS.map((action) => [action, list(action)])) },
        },
      },
      missedRegions: {
        type: "array",
        maxItems: MAX_MISSED_REGIONS,
        description: "Clutter visible in the screenshot that has no numbered box; position in % of the screenshot",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["x", "y", "w", "h", "action", "reason"],
          properties: {
            x: { type: "number", minimum: 0, maximum: 100 },
            y: { type: "number", minimum: 0, maximum: 100 },
            w: { type: "number", minimum: 0, maximum: 100 },
            h: { type: "number", minimum: 0, maximum: 100 },
            action: { type: "string", enum: [...ELEMENT_ACTIONS] },
            reason: { type: "string", maxLength: 200 },
          },
        },
      },
      notes: { type: "string", maxLength: 400, description: "One or two plain sentences for the reader about the review" },
    },
  };
}

// ── The draft as the reviewer sees it ────────────────────────────────────────
export interface DraftItem { ref: string; kind: "setting" | ElementAction; label: string }

/** One line per draft item: settings by key, elements by snapshot id. */
export function draftItems(changes: PlanChanges, items: readonly ElementItem[]): DraftItem[] {
  return [
    ...Object.entries(changes).map(([key, value]) => ({ ref: key, kind: "setting" as const, label: describeChange(key, value) })),
    ...items.map((item) => ({ ref: item.id, kind: item.action, label: item.label })),
  ];
}

// ── The ledger: what happened to each item, shown in the side panel ──────────
export const LedgerSourceSchema = z.enum(["local", "cloud", "demo", "rules", "inspector", "you"]);
export type LedgerSource = z.infer<typeof LedgerSourceSchema>;

export const LedgerEntrySchema = z.object({
  ref: z.string().max(64),
  kind: z.enum(["setting", ...ELEMENT_ACTIONS]),
  label: z.string().max(200),
  /** kept: from the draft, unchanged · dropped: removed by the reviewer · added: added by the reviewer · reverted: undone because it made the page worse. */
  status: z.enum(["kept", "dropped", "added", "reverted"]),
  source: LedgerSourceSchema,
  reason: z.string().max(240).optional(),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export interface ReviewOutcome {
  changes: PlanChanges;
  items: ElementItem[];
  ledger: LedgerEntry[];
  rejected: RejectedElement[];
  notes: string[];
}

/** The draft's own ledger, before any review. */
export function draftLedger(changes: PlanChanges, items: readonly ElementItem[], source: LedgerSource, sources: Record<string, LedgerSource> = {}): LedgerEntry[] {
  return draftItems(changes, items).map((item) => ({ ref: item.ref, kind: item.kind, label: item.label.slice(0, 200), status: "kept", source: sources[item.ref] ?? source }));
}

// Same rule as the planner: colours change only when the request is about colour.
const COLOUR_FIELDS = new Set(["theme", "contrast", "brightness", "saturation"]);
const COLOUR_WORDS = /colou?r|dark|night|light|bright|dim|sepia|warm|theme|contrast|gr[ae]y|saturat|eye|glare|white|black|faint|strain|mode/i;

/** A reviewer's setting, normalised like a plan's and checked against its field's bounds. */
function validSetting(key: string, raw: unknown): string | number | boolean | undefined {
  let value = raw;
  if (value === "default") value = "";
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) value = Number(value);
  if (value === "true") value = true;
  if (value === "false") value = false;
  const parsed = PlanChangesSchema.safeParse({ [key]: value });
  return parsed.success ? (parsed.data as PlanChanges)[key] : undefined;
}

/**
 * Fold a review into a draft. Drops come off the draft; additions pass the same
 * checks as a plan (field bounds, the colour rule, the element validator with
 * its main-content, protection, count and area rules). Nothing is dropped
 * silently: refused additions come back in `rejected` or `notes`.
 */
export function applyReview(input: {
  request: string;
  snapshot: DomSnapshot;
  current: Record<string, string | number | boolean>;
  changes: PlanChanges;
  items: readonly ElementItem[];
  ledger: readonly LedgerEntry[];
  reply: ReviewReply;
  /** Why a region-mapped block was added (id → reason). */
  regionReasons?: Record<string, string>;
}): ReviewOutcome {
  const { request, snapshot, reply } = input;
  const notes: string[] = [];
  const ledger = input.ledger.map((entry) => ({ ...entry }));
  const reasons = new Map<string, string>();
  for (const item of reply.drop) reasons.set(item.ref, item.reason);

  // 1. Drops.
  const changes: PlanChanges = {};
  for (const [key, value] of Object.entries(input.changes)) {
    if (reasons.has(key)) continue;
    changes[key] = value;
  }
  const keptItems = input.items.filter((item) => !reasons.has(item.id));
  const known = new Set([...Object.keys(input.changes), ...input.items.map((item) => item.id)]);
  for (const entry of ledger) {
    if (entry.status === "kept" && reasons.has(entry.ref)) Object.assign(entry, { status: "dropped", source: "cloud", reason: reasons.get(entry.ref)?.slice(0, 240) || "Removed by the reviewer." });
  }
  const unknown = reply.drop.filter((item) => !known.has(item.ref)).length;
  if (unknown) notes.push(`Ignored ${unknown} reviewer correction(s) that named nothing in the draft.`);

  // 2. Added or changed settings.
  const colourOk = COLOUR_WORDS.test(request);
  for (const [key, raw] of Object.entries(reply.add.changes)) {
    const value = validSetting(key, raw);
    if (value === undefined) { notes.push(`Ignored the reviewer's ${key}: not a setting, or out of range.`); continue; }
    if (COLOUR_FIELDS.has(key) && !colourOk) { notes.push(`Kept the site's colours (ignored the reviewer's ${key}): the request didn't ask about colour.`); continue; }
    if (input.current[key] === value || changes[key] === value) continue;
    const replaced = key in changes;
    changes[key] = value;
    const entry = ledger.find((item) => item.ref === key && item.status === "kept");
    if (entry) Object.assign(entry, { status: "dropped", source: "cloud", reason: `Replaced by the reviewer (${describeChange(key, value)}).` });
    ledger.push({ ref: key, kind: "setting", label: describeChange(key, value), status: "added", source: "cloud", reason: replaced ? "Changed by the reviewer." : undefined });
  }

  // 3. Added elements: validated together with the kept ones, so caps and nesting see the whole plan.
  const guard = dropUnrequestedElements(request, reply.add.elements);
  if (guard.dropped) notes.push(`Ignored ${guard.dropped} element change(s) from the reviewer: the request didn't ask to hide or highlight anything.`);
  const added: Elements = guard.elements ?? { hide: [], dim: [], highlight: [] };
  const combined: Elements = { hide: [], dim: [], highlight: [] };
  for (const item of keptItems) combined[item.action].push(item.id);
  const draftIds = new Set(keptItems.map((item) => item.id));
  for (const action of ELEMENT_ACTIONS) {
    for (const id of added[action]) if (!draftIds.has(id) && !combined[action].includes(id)) combined[action].push(id);
  }
  const review = validateElements(combined, snapshot);
  const draftState = new Map(keptItems.map((item) => [`${item.action}:${item.id}`, item.enabled]));
  const items = review.items.map((item) => {
    const key = `${item.action}:${item.id}`;
    return draftState.has(key) ? { ...item, enabled: draftState.get(key)! } : item;
  });
  const byId = new Map(snapshot.blocks.map((block) => [block.id, block]));
  for (const item of items) {
    if (draftIds.has(item.id)) continue;
    ledger.push({ ref: item.id, kind: item.action, label: item.label, status: "added", source: "cloud", reason: (input.regionReasons?.[item.id] ?? "Added by the reviewer.").slice(0, 240) });
  }
  // A kept draft item the validator now refuses (e.g. now nested in a reviewer's hide) is no longer applied.
  for (const rejected of review.rejected) {
    const entry = ledger.find((item) => item.ref === rejected.id && item.status === "kept");
    if (entry) Object.assign(entry, { status: "dropped", source: "cloud", reason: rejected.reason });
  }
  const rejected = review.rejected.filter((item) => !draftIds.has(item.id)).map((item) => ({ ...item, label: byId.get(item.id) ? blockLabel(byId.get(item.id)!) : item.label }));
  return { changes, items, ledger, rejected, notes };
}

// ── Measurements and regressions ─────────────────────────────────────────────
export const MeasuresSchema = z.object({
  score: z.number(),
  /** Visible characters of text in the main region. */
  mainText: z.number().min(0),
  /** Characters of main-region text inside blocks the plan hides or dims on purpose. */
  hiddenText: z.number().min(0).default(0),
  /** Visible characters of text on the whole page. */
  pageText: z.number().min(0).default(0),
  /** Visible navigation, forms and alerts. */
  protectedVisible: z.number().min(0),
  overflow: z.number().min(0),
  overlap: z.number().min(0),
  clipped: z.number().min(0),
  /** Types of the problems the inspector measured (small-text, long-lines, …). */
  problems: z.array(z.string().max(40)).max(20).default([]),
});
export type Measures = z.infer<typeof MeasuresSchema>;

/** Text a plan may hide or dim inside the main region on purpose (comments, an in-article promo), as a share of it. */
export const MAX_HIDDEN_MAIN_TEXT = 0.25;
/** Main text that disappears without being hidden on purpose (collateral damage). */
export const MAX_TEXT_LOSS = 0.02;
/**
 * Share of the whole page's text a plan may remove. The safety net for pages
 * where the main content was not found: hiding the article removes most of it.
 */
export const MAX_PAGE_TEXT_LOSS = 0.5;

/**
 * Why `after` is worse than `before`; empty when it is not. `protectedHidden`
 * counts protected blocks the user explicitly agreed to hide.
 */
export function regressions(before: Measures, after: Measures, protectedHidden = 0): string[] {
  const reasons: string[] = [];
  if (after.score < before.score) reasons.push(`The readability score fell from ${before.score} to ${after.score}.`);
  const base = Math.max(before.mainText, 1);
  const lost = (before.mainText - after.mainText - after.hiddenText) / base;
  if (lost > MAX_TEXT_LOSS) reasons.push(`${Math.round(lost * 100)}% of the main text disappeared.`);
  if (after.hiddenText / base > MAX_HIDDEN_MAIN_TEXT) reasons.push(`It would hide or dim ${Math.round(after.hiddenText / base * 100)}% of the main text.`);
  if (before.pageText > 0 && (before.pageText - after.pageText) / before.pageText > MAX_PAGE_TEXT_LOSS) reasons.push(`${Math.round((before.pageText - after.pageText) / before.pageText * 100)}% of the page's text would disappear.`);
  if (after.overflow > before.overflow) reasons.push("The page started scrolling sideways.");
  if (after.overlap > before.overlap) reasons.push("Text started overlapping.");
  if (after.clipped > before.clipped) reasons.push("Some text got cut off.");
  if (after.protectedVisible + protectedHidden < before.protectedVisible) reasons.push("Navigation, a form or an alert disappeared.");
  return reasons;
}

// ── "Fix this page": only what a measured problem calls for ─────────────────
// The local model tends to change every setting it knows. A fix run keeps the
// settings that address a problem code measured on this page, plus calmer
// motion (the request asks to remove distractions); the rest is undone.
export const FIX_FIELDS: Readonly<Partial<Record<FindingType, readonly string[]>>> = {
  "small-text": ["fontSize", "fontFamily"],
  "low-contrast": ["fixContrast", "contrast"],
  "tight-line-height": ["lineHeight", "paragraphSpacing"],
  "huge-block": ["paragraphSpacing", "lineHeight"],
  "long-lines": ["maxContentWidth"],
  "narrow-column": ["maxContentWidth"],
  "sticky-cover": ["staticifyStickyHeaders"],
  "link-distinction": ["underlineLinks"],
  "focus-indicator": ["focusRing"],
};
const CALM_FIELDS = ["reduceMotion", "reduceParallax", "pauseAutoplay"];

/** The settings a fix run may change, given the problem types measured before it. */
export function fixableFields(problems: readonly string[]): Set<string> {
  return new Set([...CALM_FIELDS, ...problems.flatMap((type) => FIX_FIELDS[type as FindingType] ?? [])]);
}

// ── Content width: changed only where it helps ───────────────────────────────
// Small models narrow the column on almost every page, which squeezes card
// grids and already-narrow articles. Code decides whether a width change is
// wanted at all, and how narrow it may go.
export const WIDTH_WORDS = /\b(width|wide|wider|widen|narrow\w*|column|line length|long lines|shorter lines|margins?)\b/i;
/** The narrowest column still holds about this many characters per line. */
export const MIN_CHARS_PER_LINE = 66;
/** Average Latin glyph width as a share of the font size. */
const GLYPH_WIDTH = 0.5;

export function minContentWidth(fontSize: number): number {
  return Math.min(2000, Math.ceil(fontSize * GLYPH_WIDTH * MIN_CHARS_PER_LINE / 10) * 10);
}

export interface WidthFacts {
  /** The reader asked about width, columns or line length. */
  asked: boolean;
  /** The page has an article-like main region (otherwise the width would apply to the whole layout). */
  hasMain: boolean;
  /** Code measured over-long lines before the change. */
  longLines: boolean;
  /** Text size in px the plan ends up with. */
  fontSize: number;
}

/**
 * Keep a content-width change only when it helps: asked for, or the page
 * measured over-long lines in an article. Never narrower than MIN_CHARS_PER_LINE
 * characters at the planned text size. `reason` explains a removal or a change.
 */
export function guardWidth(changes: PlanChanges, facts: WidthFacts): { changes: PlanChanges; removed?: string; widened?: string } {
  const value = changes.maxContentWidth;
  if (typeof value !== "number") return { changes };
  const rest = Object.fromEntries(Object.entries(changes).filter(([key]) => key !== "maxContentWidth"));
  if (!facts.asked && !facts.hasMain) return { changes: rest, removed: "No article was found on this page, so a narrower column would squeeze the whole layout." };
  if (!facts.asked && !facts.longLines) return { changes: rest, removed: "The lines are already a comfortable length, so the width stays as the site made it." };
  const floor = minContentWidth(facts.fontSize);
  if (value >= floor) return { changes };
  return { changes: { ...rest, maxContentWidth: floor }, widened: `Widened to ${floor}px so each line still holds about ${MIN_CHARS_PER_LINE} characters at ${facts.fontSize}px text.` };
}

/** When "when-unsure" review is the policy: is this local draft doubtful? */
export function draftIsUnsure(input: { confidence: number; before?: Measures; draft?: Measures; requested: number; refused: number }): boolean {
  if (input.confidence < 0.6) return true;
  if (input.before && input.draft && input.draft.score <= input.before.score && input.draft.score < 100) return true;
  return input.requested > 0 && input.refused / input.requested > 0.3;
}

// ── Simplified text: deterministic fidelity check ────────────────────────────
export const FIDELITY_PROBLEMS = ["dropped-fact", "changed-meaning", "added-claim", "negation-flipped", "number-changed"] as const;
export type FidelityProblem = typeof FIDELITY_PROBLEMS[number];

export const FidelityIssueSchema = z.object({
  problem: z.enum(FIDELITY_PROBLEMS),
  note: z.string().max(240),
  source: z.enum(["check", "cloud"]),
});
export type FidelityIssue = z.infer<typeof FidelityIssueSchema>;

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const NUMBER = /(?:[$€£₹]\s?)?\d+(?:[.,:]\d+)*\s?%?/g;
const NEGATION = /\b(?:not|no|never|none|nobody|nothing|neither|nor|cannot|can't|won't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|shouldn't|mustn't|without|unless)\b/gi;
const NUMBER_WORDS: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", twenty: "20", thirty: "30", forty: "40", fifty: "50", hundred: "100" };

const normaliseNumber = (value: string) => value.replace(/\s/g, "").replace(/(?<=\d),(?=\d{3}\b)/g, "").replace(/\.0+$/, "");

function numbersIn(text: string): Set<string> {
  const found = new Set((text.match(NUMBER) ?? []).map(normaliseNumber).filter((value) => /\d/.test(value)));
  // "forty litres" in a rewrite still keeps "40 litres".
  for (const word of text.toLowerCase().match(/\b[a-z]+\b/g) ?? []) if (NUMBER_WORDS[word]) found.add(NUMBER_WORDS[word]);
  return found;
}

/** Capitalised words that are not sentence starts: names of people, places, products. */
function namesIn(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(/(?<![.!?]\s|^)\b([A-Z][a-z]{2,}(?:\s[A-Z][a-z]{2,})*)\b/gm)) {
    if (!new RegExp(`^(?:${MONTHS})$`, "i").test(match[1])) names.add(match[1]);
  }
  return names;
}

const negations = (text: string) => (text.match(NEGATION) ?? []).length;

/**
 * Cheap checks that catch the most harmful rewrite errors: numbers, dates and
 * amounts that changed or vanished, names that vanished, and negations that
 * appeared or disappeared ("you must" ↔ "you must not").
 */
export function checkFidelity(original: string, rewrite: string): FidelityIssue[] {
  const issues: FidelityIssue[] = [];
  const before = numbersIn(original);
  const after = numbersIn(rewrite);
  const missing = [...before].filter((value) => !after.has(value));
  const extra = [...after].filter((value) => !before.has(value));
  if (missing.length && extra.length) issues.push({ problem: "number-changed", note: `${missing.slice(0, 3).join(", ")} became ${extra.slice(0, 3).join(", ")}.`, source: "check" });
  else if (missing.length) issues.push({ problem: "dropped-fact", note: `Missing number(s): ${missing.slice(0, 4).join(", ")}.`, source: "check" });
  else if (extra.length) issues.push({ problem: "added-claim", note: `New number(s) not in the original: ${extra.slice(0, 4).join(", ")}.`, source: "check" });
  // "Tuesdays" → "Tuesday" keeps the name.
  const lowerRewrite = rewrite.toLowerCase();
  const lostNames = [...namesIn(original)].filter((name) => !lowerRewrite.includes(name.toLowerCase().replace(/s$/, "")));
  if (lostNames.length) issues.push({ problem: "dropped-fact", note: `Missing name(s): ${lostNames.slice(0, 4).join(", ")}.`, source: "check" });
  if ((negations(original) > 0) !== (negations(rewrite) > 0) || Math.abs(negations(original) - negations(rewrite)) >= 2) {
    issues.push({ problem: "negation-flipped", note: `The original has ${negations(original)} negative word(s) ("not", "never"…), the rewrite ${negations(rewrite)}.`, source: "check" });
  }
  return issues;
}

/** Cloud fidelity review of one rewrite (only with page-text consent). */
export const FidelityReplySchema = z.object({
  issues: z.array(z.object({
    problem: z.enum(FIDELITY_PROBLEMS),
    note: z.string().min(1).max(240).describe("What changed, quoting the original briefly"),
  })).max(6).describe("Meaning errors in the rewrite; empty if it keeps every fact"),
});
export type FidelityReply = z.infer<typeof FidelityReplySchema>;

/**
 * Which chunks of a long rewrite the cloud reviews (Minions-style sampling):
 * every chunk the code check flagged, plus evenly spaced others up to `sample`.
 */
export function chunksToReview(count: number, flagged: readonly number[], sample = 3): number[] {
  const chosen = new Set(flagged.filter((index) => Number.isInteger(index) && index >= 0 && index < count));
  const step = count / Math.max(1, sample);
  for (let i = 0; i < sample && i * step < count; i++) chosen.add(Math.min(count - 1, Math.floor(i * step + step / 2)));
  return [...chosen].sort((a, b) => a - b);
}
