// ─── AI-editable settings fields ─────────────────────────────────────────────
// Models never produce operations, selectors or CSS. They return a flat,
// bounded patch over a curated subset of the user's settings. Every bound comes
// from the settings Zod schemas, so the prompt, the JSON schema sent to a model
// and validation can never drift apart.

import { z } from "zod";
import {
  AppearancePrefsSchema,
  FocusPrefsSchema,
  MotionPrefsSchema,
  TypographyPrefsSchema,
} from "./settings";

export type SettingsGroup = "typography" | "appearance" | "focus" | "motion";

export interface AiField {
  key: string;
  group: SettingsGroup;
  label: string;
  /** Unit shown to the model and in the UI ("px", "×"). */
  unit: string;
  /** One line telling the model when to use this field. */
  hint: string;
  schema: z.ZodTypeAny;
}

// Settings schemas carry `.default()`; the AI patch needs the bare bounded type.
function bare(schema: z.ZodTypeAny): z.ZodTypeAny {
  return schema instanceof z.ZodDefault ? schema.removeDefault() : schema;
}

const t = TypographyPrefsSchema.shape;
const a = AppearancePrefsSchema.shape;
const f = FocusPrefsSchema.shape;
const m = MotionPrefsSchema.shape;

// Deliberately excluded: collapseSidebars / hiddenSelectors / preservedSelectors
// (may hide navigation; manual only), appearance engine/forceDark (internal).
export const AI_FIELDS: readonly AiField[] = [
  { key: "fontFamily", group: "typography", label: "Font", unit: "", hint: "\"\" keeps the site font; Atkinson Hyperlegible, Lexend or Verdana are plain and upright (no font helps every reader)", schema: bare(t.fontFamily) },
  { key: "fontSize", group: "typography", label: "Text size", unit: "px", hint: "body text size", schema: bare(t.fontSize) },
  { key: "lineHeight", group: "typography", label: "Line height", unit: "×", hint: "1.5 is typical, higher is airier", schema: bare(t.lineHeight) },
  { key: "letterSpacing", group: "typography", label: "Letter spacing", unit: "em", hint: "0 is normal; 0.05, 0.12 or 0.18 when letters crowd together", schema: bare(t.letterSpacing) },
  { key: "wordSpacing", group: "typography", label: "Word spacing", unit: "em", hint: "0 is normal; 0.16 or 0.3 when words run together", schema: bare(t.wordSpacing) },
  { key: "paragraphSpacing", group: "typography", label: "Paragraph spacing", unit: "em", hint: "extra space after paragraphs", schema: bare(t.paragraphSpacing) },
  { key: "maxContentWidth", group: "typography", label: "Content width", unit: "px", hint: "narrower lines are easier to read; 650-800 for articles", schema: bare(t.maxContentWidth) },
  { key: "theme", group: "appearance", label: "Theme", unit: "", hint: "dark, light or sepia colours", schema: bare(a.theme) },
  { key: "contrast", group: "appearance", label: "Contrast", unit: "×", hint: "1 is unchanged", schema: bare(a.contrast) },
  { key: "brightness", group: "appearance", label: "Brightness", unit: "×", hint: "1 is unchanged", schema: bare(a.brightness) },
  { key: "saturation", group: "appearance", label: "Saturation", unit: "×", hint: "1 is unchanged, 0 is greyscale", schema: bare(a.saturation) },
  { key: "underlineLinks", group: "appearance", label: "Underline links", unit: "", hint: "underline links inside text so they stand out without colour", schema: bare(a.underlineLinks) },
  { key: "focusRing", group: "appearance", label: "Visible focus outline", unit: "", hint: "a clear outline around the link or button that has keyboard focus", schema: bare(a.focusRing) },
  { key: "fixContrast", group: "appearance", label: "Fix low-contrast text", unit: "", hint: "make faint text that is hard to read darker (or lighter on dark backgrounds)", schema: bare(a.fixContrast) },
  { key: "textColor", group: "appearance", label: "Text colour", unit: "", hint: "colour of the page's text when the reader asks for one; \"\" keeps the site's colours; code picks a shade that stays readable", schema: bare(a.textColor) },
  { key: "dimNonMain", group: "focus", label: "Dim distractions", unit: "", hint: "fade content outside the main reading area", schema: bare(f.dimNonMain) },
  { key: "staticifyStickyHeaders", group: "focus", label: "Unstick headers", unit: "", hint: "stop headers from following the scroll", schema: bare(f.staticifyStickyHeaders) },
  { key: "reduceMotion", group: "motion", label: "Reduce motion", unit: "", hint: "calm animations and transitions", schema: bare(m.reduceMotion) },
  { key: "reduceParallax", group: "motion", label: "Reduce parallax", unit: "", hint: "stop scroll-linked movement", schema: bare(m.reduceParallax) },
  { key: "pauseAutoplay", group: "motion", label: "Pause autoplay", unit: "", hint: "pause auto-playing media", schema: bare(m.pauseAutoplay) },
  // P11, last: small models over-use on/off settings near the top of the list.
  { key: "noItalics", group: "typography", label: "No italics", unit: "", hint: "only when the reader mentions italics or dyslexia: upright text instead of italics (emphasis becomes semi-bold)", schema: bare(t.noItalics) },
  { key: "unjustify", group: "typography", label: "Left-aligned text", unit: "", hint: "only when the reader mentions justified text, uneven gaps or dyslexia: left-align justified paragraphs", schema: bare(t.unjustify) },
  { key: "noAllCaps", group: "typography", label: "No ALL CAPS styling", unit: "", hint: "only when the reader mentions capitals or dyslexia: show text the site styles in capitals in normal case", schema: bare(t.noAllCaps) },
  { key: "backgroundTint", group: "appearance", label: "Background tint", unit: "", hint: "only when the reader mentions glare, a bright white page or a tint: a soft page colour (light and sepia themes); text is darkened to stay readable", schema: bare(a.backgroundTint) },
];

const shape = Object.fromEntries(AI_FIELDS.map((field) => [field.key, field.schema.optional()]));

/** A model's proposed changes: every key optional, unknown keys rejected. */
export const PlanChangesSchema = z.object(shape).strict();
export type PlanChanges = Record<string, string | number | boolean>;

export function aiField(key: string): AiField | undefined {
  return AI_FIELDS.find((field) => field.key === key);
}

/** Human-readable line for one change, e.g. "Text size → 20px". */
export function describeChange(key: string, value: unknown): string {
  const field = aiField(key);
  if (!field) return `${key} → ${String(value)}`;
  if (typeof value === "boolean") return `${field.label}: ${value ? "on" : "off"}`;
  if (value === "") return `${field.label} → site default`;
  return `${field.label} → ${String(value)}${field.unit}`;
}

export function describeChanges(changes: PlanChanges): string[] {
  return Object.entries(changes).map(([key, value]) => describeChange(key, value));
}
