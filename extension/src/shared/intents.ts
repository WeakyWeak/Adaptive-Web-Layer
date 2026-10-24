// ─── Deterministic intents (no model) ────────────────────────────────────────
// Keyword rules that turn common requests into a bounded settings patch. Used
// by Demo mode and as the fallback suggestion when AI is unavailable.

import { z } from "zod";
import { aiField, type PlanChanges } from "./aiFields";
import { suggestElements } from "./elementPlan";
import { BUILT_IN_PROFILES, DYSLEXIA_START_ID, TEXT_COLOR_OPTIONS, type BackgroundTint } from "./settings";
import { numberBounds } from "./jsonSchema";
import type { DomSnapshot, Plan } from "./plan";

type Current = Record<string, string | number | boolean>;

interface IntentRule {
  pattern: RegExp;
  label: string;
  changes: (current: Current, request: string) => PlanChanges;
}

const num = (current: Current, key: string): number => Number(current[key]);

const DIM_DISTRACTIONS = "dim distractions";

/** P11: "dyslexia" means the built-in "Dyslexia-friendly start" profile's settings (a starting point). */
function dyslexiaStart(): PlanChanges {
  const profile = BUILT_IN_PROFILES.find((item) => item.id === DYSLEXIA_START_ID)!;
  const { fontFamily, fontSize, letterSpacing, wordSpacing, lineHeight, unjustify, noItalics } = profile.typography;
  return { fontFamily, fontSize, letterSpacing, wordSpacing, lineHeight, unjustify, noItalics, backgroundTint: profile.appearance.backgroundTint };
}

const TINT_WORDS: Array<[RegExp, BackgroundTint]> = [[/\bpeach\b/, "peach"], [/\byellow\b/, "yellow"], [/\bgr[ae]y\b/, "soft-grey"]];
const COLOUR_NAMES = "red|orange|brown|green|teal|blue|purple|pink|gr[ae]y|black";
/** "make the text red", "red text", "text colour blue". */
const TEXT_COLOR_REQUEST = new RegExp(`\\b(text|font|letters?|words?)\\b.*\\b(${COLOUR_NAMES})\\b|\\b(${COLOUR_NAMES}) (text|font|letters|words)\\b`);

const RULES: readonly IntentRule[] = [
  { pattern: /\b(dyslexi\w*)\b/, label: "dyslexia-friendly start", changes: () => dyslexiaStart() },
  { pattern: /\bitalic\w*/, label: "upright text", changes: () => ({ noItalics: true }) },
  { pattern: /\bjustif\w*/, label: "left-aligned text", changes: () => ({ unjustify: true }) },
  { pattern: /\b(all caps|capitals|upper ?case)\b/, label: "normal case", changes: () => ({ noAllCaps: true }) },
  { pattern: /\b(tint\w*|cream|peach)\b|\b(yellow|soft gr[ae]y) (background|page)\b/, label: "background tint", changes: (_c, request) => ({ backgroundTint: TINT_WORDS.find(([words]) => words.test(request))?.[1] ?? "cream" }) },
  { pattern: /\b(bigger|larger|increase|enlarge)\b.*\b(text|font|letters?|size)\b|\b(text|font)\b.*\b(bigger|larger)\b/, label: "larger text", changes: (c) => ({ fontSize: num(c, "fontSize") + 4 }) },
  { pattern: /\b(smaller|decrease|reduce)\b.*\b(text|font)\b|\b(text|font)\b.*\bsmaller\b/, label: "smaller text", changes: (c) => ({ fontSize: num(c, "fontSize") - 2 }) },
  { pattern: /\b(easier to read|more readable|readability|hard to read)\b/, label: "easier reading", changes: (c) => ({ fontSize: Math.max(num(c, "fontSize"), 18), lineHeight: Math.max(num(c, "lineHeight"), 1.7), maxContentWidth: 760 }) },
  { pattern: /\b(dark|night)\b/, label: "dark theme", changes: () => ({ theme: "dark" }) },
  { pattern: /\b(sepia|warm|paper)\b/, label: "sepia theme", changes: () => ({ theme: "sepia" }) },
  { pattern: /\blight (mode|theme)\b/, label: "light theme", changes: () => ({ theme: "light" }) },
  { pattern: /\b(line height|line spacing|more spac\w*|airier|cramped)\b/, label: "more line spacing", changes: (c) => ({ lineHeight: num(c, "lineHeight") + 0.3 }) },
  { pattern: /\b(narrow(er)?|shorter lines|column)\b/, label: "narrower column", changes: (c) => ({ maxContentWidth: Math.min(num(c, "maxContentWidth"), 720) }) },
  { pattern: /\b(wider|full width|wide)\b/, label: "wider content", changes: (c) => ({ maxContentWidth: num(c, "maxContentWidth") + 200 }) },
  { pattern: /\b(motion|animations?|moving|parallax)\b/, label: "less motion", changes: () => ({ reduceMotion: true, reduceParallax: true }) },
  { pattern: /\b(autoplay|auto-play|videos?)\b/, label: "pause autoplay", changes: () => ({ pauseAutoplay: true }) },
  { pattern: /\b(distract\w*|clutter\w*|focus)\b/, label: DIM_DISTRACTIONS, changes: () => ({ dimNonMain: true }) },
  { pattern: /\bsticky\b/, label: "unstick headers", changes: () => ({ staticifyStickyHeaders: true }) },
  { pattern: TEXT_COLOR_REQUEST, label: "text colour", changes: (_c, request) => ({ textColor: TEXT_COLOR_OPTIONS.find((name) => name && new RegExp(`\\b${name === "grey" ? "gr[ae]y" : name}\\b`).test(request)) ?? "" }) },
  { pattern: /\b(gr[ae]yscale|no colou?rs?|black and white)\b/, label: "greyscale", changes: () => ({ saturation: 0 }) },
  { pattern: /\b(more|higher|increase)\b.*\bcontrast\b/, label: "more contrast", changes: (c) => ({ contrast: num(c, "contrast") + 0.3 }) },
  { pattern: /\b(too bright|dimmer|less bright)\b/, label: "dimmer", changes: (c) => ({ brightness: num(c, "brightness") - 0.15 }) },
];

/** Clamp a proposed value into its field's Zod bounds; drop it if still invalid. */
function clamp(key: string, value: string | number | boolean): string | number | boolean | undefined {
  const field = aiField(key);
  if (!field) return undefined;
  let next = value;
  if (typeof value === "number" && field.schema instanceof z.ZodNumber) {
    const { minimum = -Infinity, maximum = Infinity } = numberBounds(field.schema);
    next = Math.round(Math.min(maximum, Math.max(minimum, value)) * 100) / 100;
  }
  return field.schema.safeParse(next).success ? next : undefined;
}

export function matchIntents(request: string, current: Current, skip: readonly string[] = []): Plan | null {
  const text = request.toLowerCase();
  const matched = RULES.filter((rule) => rule.pattern.test(text) && !skip.includes(rule.label));
  if (matched.length === 0) return null;
  const changes: PlanChanges = {};
  for (const rule of matched) {
    for (const [key, value] of Object.entries(rule.changes(current, text))) {
      if (value === undefined) continue;
      const safe = clamp(key, value);
      if (safe !== undefined) changes[key] = safe;
    }
  }
  return {
    interpretedRequest: matched.map((rule) => rule.label).join(", "),
    changes,
    reasons: matched.map((rule) => `Matched "${rule.label}" without using a model.`),
    confidence: 0.6,
  };
}

/**
 * Settings intents plus clutter blocks picked by keyword (no model). When the
 * request is a clean-up, hiding named clutter replaces the blunter "dim
 * everything outside the main content" setting.
 */
export function deterministicPlan(request: string, current: Current, snapshot: DomSnapshot): Plan | null {
  const elements = suggestElements(request, snapshot);
  if (!elements) return matchIntents(request, current);
  const settingsPlan = matchIntents(request, current, [DIM_DISTRACTIONS]);
  return {
    interpretedRequest: settingsPlan ? `${settingsPlan.interpretedRequest}, hide clutter` : "hide clutter",
    changes: settingsPlan?.changes ?? {},
    elements,
    reasons: [...(settingsPlan?.reasons ?? []), `Picked ${elements.hide.length} clutter block(s) by name, without using a model.`],
    confidence: 0.6,
  };
}
