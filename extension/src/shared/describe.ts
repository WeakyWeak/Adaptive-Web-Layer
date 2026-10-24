// ─── Profile from a description (P11, job kind "describeMe") ────────────────
// The reader says how reading feels ("letters crowd together", "I lose my
// line"); a model turns that into a starting profile: a bounded settings
// patch (the same AI fields as any plan), reading aids (P12) and the dyslexia
// lens. Code validates it, removes overclaiming notes, and offers the
// reading-fit test to confirm, because a measurement beats a guess.

import { z } from "zod";
import { PlanChangesSchema, type PlanChanges } from "./aiFields";
import { changesJsonSchema, zodToJsonSchema, type JsonSchema } from "./jsonSchema";
import { normaliseChanges } from "./plan";
import { ReadingAidsSchema, type ReadingAids } from "./settings";

export const MAX_DESCRIPTION_CHARS = 1000;

export const DescribeReplySchema = z.object({
  profileName: z.string().min(1).max(40).describe("A short, kind name for the profile, e.g. \"Calm spacing\""),
  changes: z.preprocess(normaliseChanges, PlanChangesSchema),
  aids: z.object({
    lineFocus: z.boolean().describe("Dim all but the current lines, for readers who lose their place"),
    ruler: z.boolean().describe("A reading ruler under the current line"),
    tts: z.boolean().describe("Read aloud with word highlighting"),
    syllables: z.boolean().describe("Mark syllables in long words"),
  }),
  lens: z.boolean().describe("Check pages for what makes reading hard with dyslexia"),
  notes: z.array(z.string().min(1).max(200)).min(1).max(4).describe("One plain sentence per choice, saying which words of the description it answers"),
});
export type DescribeReply = z.infer<typeof DescribeReplySchema>;

/** JSON Schema for the reply; `changes` is the same field-aware schema plans use. */
export function describeJsonSchema(): JsonSchema {
  const rest = zodToJsonSchema(DescribeReplySchema.omit({ changes: true }));
  const properties = rest.properties as Record<string, JsonSchema>;
  return {
    ...rest,
    required: ["profileName", "changes", "aids", "lens", "notes"],
    properties: { profileName: properties.profileName, changes: { ...changesJsonSchema(), description: "Only the settings that address what the reader described" }, aids: properties.aids, lens: properties.lens, notes: properties.notes },
  };
}

export const DESCRIBE_NOTE = "A starting point, adjust anytime. The reading-fit test measures what really helps you.";

// Never promise a treatment, a cure or a diagnosis; no font or setting helps every reader.
const OVERCLAIM = /\b(cure[sd]?|treat(s|ed|ment)?|fix(es)? (your|the) dyslexia|diagnos\w*|proven|guarantee\w*|clinically|scientifically shown|will (help|work for) (every|all)|helps? every(one| reader))\b/i;

export function overclaims(text: string): boolean {
  return OVERCLAIM.test(text);
}

/** Notes without overclaims, plus how many were removed. */
export function cleanNotes(notes: readonly string[]): { notes: string[]; removed: number } {
  const kept = notes.map((note) => note.trim()).filter((note) => note && !overclaims(note));
  return { notes: kept, removed: notes.length - kept.length };
}

// ── Which settings a description may change ─────────────────────────────────
// Text shape, spacing, size and the background are what reading descriptions
// are about. Page-level switches need the reader to mention what they fix.
const NEEDS_WORDS: ReadonlyArray<[readonly string[], RegExp]> = [
  [["reduceMotion", "reduceParallax", "pauseAutoplay", "dimNonMain", "staticifyStickyHeaders"], /\b(mov\w*|animat\w*|distract\w*|flash\w*|busy|clutter\w*|sticky|scroll\w*|video\w*|autoplay)\b/i],
  [["fixContrast", "contrast", "brightness", "saturation", "theme", "textColor"], /\b(faint|pale|grey|gray|contrast|dark|night|colou?r\w*|bright\w*|dim)\b/i],
  [["underlineLinks", "focusRing"], /\b(links?|keyboard|focus|tab key)\b/i],
];

/** The changes a description may make: settings it does not touch on are dropped; OpenDyslexic is only a fit-test candidate. */
export function describedChanges(changes: PlanChanges, description: string): { changes: PlanChanges; dropped: string[] } {
  const dropped: string[] = [];
  const kept: PlanChanges = {};
  for (const [key, value] of Object.entries(changes)) {
    const rule = NEEDS_WORDS.find(([keys]) => keys.includes(key));
    const unasked = rule && !rule[1].test(description);
    if (unasked || (key === "fontFamily" && value === "OpenDyslexic")) dropped.push(key);
    else kept[key] = value;
  }
  return { changes: kept, dropped };
}

// ── Without a model (Demo mode, or when the AI fails) ───────────────────────
interface DescribeRule { words: RegExp; changes?: PlanChanges; aids?: Partial<ReadingAids>; note: string }

const RULES: readonly DescribeRule[] = [
  { words: /\b(crowd\w*|cramp\w*|squash\w*|squeez\w*|close together|run together|blur\w*)\b/i, changes: { letterSpacing: 0.12, wordSpacing: 0.16 }, note: "More space between letters and words, for letters that crowd together." },
  { words: /\b(lose|losing|lost) (my|the) (line|place)|skip(ping)? lines|same line twice\b/i, changes: { lineHeight: 1.8, maxContentWidth: 720 }, aids: { lineFocus: true }, note: "More space between lines, a narrower column and line focus, for losing your place." },
  { words: /\blong words\b|\bsyllabl\w*|\bsound(ing)? (words )?out\b/i, aids: { syllables: true }, note: "Syllable marks for long words." },
  { words: /\b(too bright|glare|glaring|white (page|background)s?|dazzl\w*)\b/i, changes: { backgroundTint: "cream" }, note: "A soft cream background instead of bright white." },
  { words: /\b(small|tiny) (text|letters|print)|\bsquint\w*\b|\btext is too small\b/i, changes: { fontSize: 20 }, note: "Larger text." },
  { words: /\bitalic\w*|\bslant\w*/i, changes: { noItalics: true }, note: "Upright text instead of italics." },
  { words: /\b(all caps|capitals|upper ?case)\b/i, changes: { noAllCaps: true }, note: "Normal case instead of text styled in capitals." },
  { words: /\b(justif\w*|uneven gaps|rivers)\b/i, changes: { unjustify: true }, note: "Left-aligned text, so the gaps between words stay even." },
  { words: /\b(listen\w*|read (it )?(aloud|out)|hear)\b/i, aids: { tts: true }, note: "Read aloud with word highlighting." },
  { words: /\b(mov(e|es|ing)|animat\w*|distract\w*)\b/i, changes: { reduceMotion: true }, note: "Calmer pages with less motion." },
];

/** Keyword rules: a labelled starting point when no model is used. */
export function describeFallback(description: string): DescribeReply {
  const matched = RULES.filter((rule) => rule.words.test(description));
  const changes = Object.assign({}, ...matched.map((rule) => rule.changes ?? {})) as PlanChanges;
  const aids = ReadingAidsSchema.parse(Object.assign({}, ...matched.map((rule) => rule.aids ?? {})));
  return {
    profileName: "My reading start",
    changes,
    aids,
    lens: true,
    notes: matched.length ? matched.map((rule) => rule.note).slice(0, 4) : ["No familiar reading difficulty was recognised; the reading-fit test can find your settings instead."],
  };
}
