import { z } from "zod";

// ─── Schema version ──────────────────────────────────────────────────────────
// Bump this when you add a migration below.
export const SETTINGS_VERSION = 11;

// ─── Typography preferences ──────────────────────────────────────────────────
export const FONT_FAMILY_OPTIONS = [
  "",
  "Lexend",
  "Atkinson Hyperlegible",
  "OpenDyslexic",
  "Georgia",
  "Verdana",
  "Arial",
  "system-ui",
] as const;

/** P11 spacing presets (em, so they scale with the text): research-backed steps, not limits. */
export const LETTER_SPACING_PRESETS = [0, 0.05, 0.12, 0.18] as const;
export const WORD_SPACING_PRESETS = [0, 0.16, 0.3] as const;
/** "Paragraph spacing 2×": twice the usual one-line gap after a paragraph. */
export const DOUBLE_PARAGRAPH_SPACING = 2;

export const TypographyPrefsSchema = z.object({
  fontFamily: z.enum(FONT_FAMILY_OPTIONS).default(""), // "" = site default
  fontSize: z.number().min(10).max(48).default(16),
  lineHeight: z.number().min(1).max(3).default(1.5),
  // P11: em (was px before settings v11).
  letterSpacing: z.number().min(-0.05).max(0.5).default(0),
  wordSpacing: z.number().min(-0.1).max(1).default(0),
  paragraphSpacing: z.number().min(0).max(5).default(0),
  maxContentWidth: z.number().min(400).max(2000).default(800),
  // P11: dyslexia-friendly text shape (computed-style based; protected content untouched).
  noItalics: z.boolean().default(false),
  unjustify: z.boolean().default(false),
  noAllCaps: z.boolean().default(false),
});
export type TypographyPrefs = z.infer<typeof TypographyPrefsSchema>;

/** Named text colours a reader (or the AI) can pick; "" keeps the site's colours. Code picks a readable shade. */
export const TEXT_COLOR_OPTIONS = ["", "red", "orange", "brown", "green", "teal", "blue", "purple", "pink", "grey", "black"] as const;
/** P11: warm or soft page backgrounds (light and sepia themes only); text is darkened to ≥ 7:1. */
export const BACKGROUND_TINTS = ["none", "cream", "peach", "yellow", "soft-grey"] as const;
export type BackgroundTint = typeof BACKGROUND_TINTS[number];

export const AppearancePrefsSchema = z.object({
  theme: z.enum(["light", "dark", "sepia"]).default("light"),
  engine: z.enum(["fast", "smart"]).default("fast"),
  contrast: z.number().min(0.5).max(2).default(1),
  brightness: z.number().min(0.5).max(1.5).default(1),
  saturation: z.number().min(0).max(2).default(1),
  forceDark: z.boolean().default(false),
  // P09: readability fixes the inspector can suggest (also usable on their own).
  underlineLinks: z.boolean().default(false),
  focusRing: z.boolean().default(false),
  fixContrast: z.boolean().default(false),
  textColor: z.enum(TEXT_COLOR_OPTIONS).default(""),
  /** Links in a named colour ("" keeps the site's); code picks a readable shade. */
  linkColor: z.enum(TEXT_COLOR_OPTIONS).default(""),
  backgroundTint: z.enum(BACKGROUND_TINTS).default("none"),
});
export type AppearancePrefs = z.infer<typeof AppearancePrefsSchema>;

export const MAX_SAVED_SELECTORS = 30;

export const FocusPrefsSchema = z.object({
  collapseSidebars: z.boolean().default(false),
  dimNonMain: z.boolean().default(false),
  staticifyStickyHeaders: z.boolean().default(false),
  hiddenSelectors: z.array(z.string().min(1).max(512)).max(MAX_SAVED_SELECTORS).default([]),
  preservedSelectors: z.array(z.string().min(1).max(512)).max(MAX_SAVED_SELECTORS).default([]),
  // P07: elements dimmed or highlighted by "Clean this page" (or by hand).
  dimSelectors: z.array(z.string().min(1).max(512)).max(MAX_SAVED_SELECTORS).default([]),
  highlightSelectors: z.array(z.string().min(1).max(512)).max(MAX_SAVED_SELECTORS).default([]),
});
export type FocusPrefs = z.infer<typeof FocusPrefsSchema>;

export const MotionPrefsSchema = z.object({
  reduceMotion: z.boolean().default(false),
  reduceParallax: z.boolean().default(false),
  pauseAutoplay: z.boolean().default(false),
});
export type MotionPrefs = z.infer<typeof MotionPrefsSchema>;

// ─── Global preferences ──────────────────────────────────────────────────────
export const GlobalPrefsSchema = z.object({
  typography: TypographyPrefsSchema.default({}),
  appearance: AppearancePrefsSchema.default({}),
  focus: FocusPrefsSchema.default({}),
  motion: MotionPrefsSchema.default({}),
  applyToWholePage: z.boolean().default(false),
});
export type GlobalPrefs = z.infer<typeof GlobalPrefsSchema>;

/** P11/P12 reading aids a profile asks for (the aids themselves arrive in P12). */
export const ReadingAidsSchema = z.object({
  lineFocus: z.boolean().default(false),
  ruler: z.boolean().default(false),
  tts: z.boolean().default(false),
  syllables: z.boolean().default(false),
});
export type ReadingAids = z.infer<typeof ReadingAidsSchema>;

// ─── Named profile ───────────────────────────────────────────────────────────
export const NamedProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  typography: TypographyPrefsSchema.default({}),
  appearance: AppearancePrefsSchema.default({}),
  focus: FocusPrefsSchema.optional(),
  motion: MotionPrefsSchema.optional(),
  builtIn: z.boolean().default(false),
  /** P11: the inspector also checks pages through the dyslexia lens and scores them "for you". */
  dyslexiaLens: z.boolean().optional(),
  aids: ReadingAidsSchema.optional(),
  /** P11: shown under the profile ("a starting point, adjust anytime"). */
  note: z.string().max(240).optional(),
});
export type NamedProfile = z.infer<typeof NamedProfileSchema>;

// ─── Site rule ───────────────────────────────────────────────────────────────
export const SiteRuleSchema = z.object({
  hostname: z.string().transform(normalizeHostname),
  enabled: z.boolean().default(true),
  includeSubdomains: z.boolean().default(false),
  profileId: z.string().nullable().default(null),
  disabledOperations: z.array(z.string()).default([]),
  typography: TypographyPrefsSchema.partial().default({}),
  appearance: AppearancePrefsSchema.partial().default({}),
  focus: FocusPrefsSchema.partial().optional(),
  motion: MotionPrefsSchema.partial().optional(),
});
export type SiteRule = z.infer<typeof SiteRuleSchema>;

// ─── AI settings (P05+) ───────────────────────────────────────────────────────
export const CLOUD_BACKENDS = ["gemini", "anthropic", "openai"] as const;
export type CloudBackend = typeof CLOUD_BACKENDS[number];
/** always: every AI run; first-per-site: the first run on each site; when-unsure: only when the local draft looks doubtful. */
export const REVIEW_POLICIES = ["always", "first-per-site", "when-unsure"] as const;
export type ReviewPolicy = typeof REVIEW_POLICIES[number];

export const AiSettingsSchema = z.object({
  mode: z.enum(["local", "cloud", "hybrid"]).default("local"),
  // llama-server default port is 8080; Ollama uses 11434 with /v1 endpoint
  localEndpoint: z.string().default("http://127.0.0.1:8080"),
  // llama-server serves whichever GGUF it was started with; the id is informational.
  localModel: z.string().default("local"),
  localContextSize: z.number().min(512).max(131072).default(8192),
  localApiKey: z.string().default(""),
  // Replies stream, so long generations no longer trip MV3's 30 s fetch limit.
  localTimeoutMs: z.number().min(1000).max(300000).default(120000),
  /** Set only when the local model accepts images (e.g. a model loaded with --mmproj). */
  localVision: z.boolean().default(false),
  // The proxy is local; this token authorizes only that proxy, never a provider.
  cloudBackend: z.enum(CLOUD_BACKENDS).default("gemini"),
  cloudModel: z.string().min(1).max(128).default("gemini-3.5-flash-lite"),
  anthropicModel: z.string().min(1).max(128).default("claude-opus-5-5"),
  /** Model behind the proxy's OpenAI-compatible backend (OPENAI_COMPAT_* in server/.env). */
  openaiModel: z.string().min(1).max(128).default("gpt-compatible"),
  /** P10: the cloud supervisor. Reviews are rare, so a stronger model than `cloudModel` (Gemini only; other backends use their model setting). */
  reviewModel: z.string().min(1).max(128).default("gemini-3.5-flash"),
  /** P10: when hybrid/cloud mode asks the cloud to review the local draft. */
  reviewPolicy: z.enum(REVIEW_POLICIES).default("always"),
  cloudProxyUrl: z.string().url().default("http://127.0.0.1:8787"),
  cloudProxyToken: z.string().max(512).default(""),
  cloudTimeoutMs: z.number().min(1000).max(300000).default(120000),
  demoMode: z.boolean().default(false),
  /** P08: the "✨ Understand" button after selecting text on a page. */
  selectionActions: z.boolean().default(true),
});
export type AiSettings = z.infer<typeof AiSettingsSchema>;

// ─── Privacy settings ────────────────────────────────────────────────────────
export const PrivacySettingsSchema = z.object({
  /** Legacy global consent. Retained only so older settings migrate safely. */
  cloudConsent: z.boolean().default(false),
  cloudConsentTimestamp: z.number().optional(),
  /** Explicit, per-site cloud decisions. */
  cloudSiteConsents: z.record(z.enum(["allow", "deny"])).default({}),
  /** A single queued cloud request; consumed by the background after use. */
  cloudAllowOnceFor: z.string().optional(),
  /** P10: sites whose page text the cloud reviewer may read (to check simplified text). Separate from cloud consent, off by default. */
  cloudTextSites: z.record(z.boolean()).default({}),
  /** P10: sites the cloud has reviewed at least once (for the "first-per-site" review policy). */
  reviewedSites: z.array(z.string().max(253)).max(500).default([]),
  /** Send screenshots of the visible page with cloud reviews (when Chrome allows a capture). */
  reviewScreenshots: z.boolean().default(true),
  /** The reader granted Chrome's every-site permission so reviews can include screenshots anywhere. */
  screenshotsEverySite: z.boolean().default(false),
});
export type PrivacySettings = z.infer<typeof PrivacySettingsSchema>;

export type CloudConsent = "allow" | "deny" | "pending";

/** May the cloud reviewer read page text on this site? Needs cloud consent too. */
export function cloudTextAllowed(privacy: PrivacySettings, hostname: string): boolean {
  return cloudConsentFor(privacy, hostname) === "allow" && privacy.cloudTextSites[normalizeHostname(hostname)] === true;
}

export function cloudConsentFor(privacy: PrivacySettings, hostname: string): CloudConsent {
  const normalized = normalizeHostname(hostname);
  if (privacy.cloudAllowOnceFor === normalized) return "allow";
  return privacy.cloudSiteConsents[normalized] ?? (privacy.cloudConsent ? "allow" : "pending");
}

// ─── Root settings ───────────────────────────────────────────────────────────
export const SettingsSchema = z.object({
  version: z.number().default(SETTINGS_VERSION),
  enabled: z.boolean().default(true),
  global: GlobalPrefsSchema.default({}),
  activeProfileId: z.string().nullable().default(null),
  profiles: z.array(NamedProfileSchema).default([]),
  siteRules: z.array(SiteRuleSchema).default([]),
  ai: AiSettingsSchema.default({}),
  privacy: PrivacySettingsSchema.default({}),
});
export type Settings = z.infer<typeof SettingsSchema>;

// ─── Defaults helper ─────────────────────────────────────────────────────────
export function defaultSettings(): Settings {
  return SettingsSchema.parse({ profiles: BUILT_IN_PROFILES });
}

export function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
}

export const DYSLEXIA_START_ID = "dyslexia-start";
export const DYSLEXIA_START_NOTE = "A starting point, adjust anytime. The reading-fit test finds what works for you.";

export const BUILT_IN_PROFILES: NamedProfile[] = [
  { id: "study", name: "Study", builtIn: true, typography: TypographyPrefsSchema.parse({ fontFamily: "Atkinson Hyperlegible", fontSize: 18, lineHeight: 1.8, maxContentWidth: 900 }), appearance: AppearancePrefsSchema.parse({ theme: "sepia" }), focus: FocusPrefsSchema.parse({ collapseSidebars: true, dimNonMain: true }), motion: MotionPrefsSchema.parse({ reduceMotion: true }) },
  { id: "night", name: "Night", builtIn: true, typography: TypographyPrefsSchema.parse({ fontFamily: "Lexend", fontSize: 17, lineHeight: 1.7, maxContentWidth: 1000 }), appearance: AppearancePrefsSchema.parse({ theme: "dark" }), focus: FocusPrefsSchema.parse({}), motion: MotionPrefsSchema.parse({ reduceMotion: true }) },
  { id: "minimal", name: "Minimal", builtIn: true, typography: TypographyPrefsSchema.parse({ fontSize: 16, lineHeight: 1.5, maxContentWidth: 800 }), appearance: AppearancePrefsSchema.parse({}), focus: FocusPrefsSchema.parse({ collapseSidebars: true, dimNonMain: true, staticifyStickyHeaders: true }), motion: MotionPrefsSchema.parse({ reduceMotion: true, reduceParallax: true, pauseAutoplay: true }) },
  { id: "research", name: "Research", builtIn: true, typography: TypographyPrefsSchema.parse({ fontFamily: "Georgia", fontSize: 17, lineHeight: 1.75, maxContentWidth: 1100 }), appearance: AppearancePrefsSchema.parse({}), focus: FocusPrefsSchema.parse({}), motion: MotionPrefsSchema.parse({}) },
  {
    id: DYSLEXIA_START_ID,
    name: "Dyslexia-friendly start",
    builtIn: true,
    typography: TypographyPrefsSchema.parse({ fontFamily: "Atkinson Hyperlegible", fontSize: 18, letterSpacing: 0.12, wordSpacing: 0.16, lineHeight: 1.6, unjustify: true, noItalics: true }),
    appearance: AppearancePrefsSchema.parse({ backgroundTint: "cream" }),
    focus: FocusPrefsSchema.parse({}),
    motion: MotionPrefsSchema.parse({}),
    dyslexiaLens: true,
    aids: ReadingAidsSchema.parse({}),
    note: DYSLEXIA_START_NOTE,
  },
];

// ─── Resolved typography for a hostname ──────────────────────────────────────
// Resolution order: defaults < global < active profile < site override
export function resolveTypography(
  settings: Settings,
  hostname: string
): TypographyPrefs {
  const base: TypographyPrefs = TypographyPrefsSchema.parse({});
  if (!settings.enabled || !isSiteEnabled(settings, hostname)) return base;

  // Apply global
  let resolved: TypographyPrefs = { ...base, ...settings.global.typography };

  // Apply active profile
  const profileId = matchingSiteRule(settings, hostname)?.profileId ?? settings.activeProfileId;
  if (profileId) {
    const profile = settings.profiles.find((p) => p.id === profileId);
    if (profile) {
      resolved = { ...resolved, ...profile.typography };
    }
  }

  // Apply site override (partial)
  const siteRule = matchingSiteRule(settings, hostname);
  if (siteRule?.enabled !== false) {
    resolved = { ...resolved, ...siteRule?.typography };
    // A disabled operation falls back to its default (the site's own look).
    for (const key of siteRule?.disabledOperations ?? []) {
      if (key in base) (resolved as Record<string, unknown>)[key] = base[key as keyof TypographyPrefs];
    }
  }

  return resolved;
}

export function resolveAppearance(settings: Settings, hostname: string): AppearancePrefs {
  const base = AppearancePrefsSchema.parse({});
  if (!settings.enabled || !isSiteEnabled(settings, hostname)) return base;
  const site = matchingSiteRule(settings, hostname);
  const profileId = site?.profileId ?? settings.activeProfileId;
  const profile = settings.profiles.find((item) => item.id === profileId);
  return {
    ...base,
    ...settings.global.appearance,
    ...(profile?.appearance ?? {}),
    ...(site?.appearance ?? {}),
  };
}

function resolveFeature(settings: Settings, hostname: string, key: "focus" | "motion", schema: z.ZodTypeAny): unknown {
  const base = schema.parse({});
  if (!settings.enabled || !isSiteEnabled(settings, hostname)) return base;
  const site = matchingSiteRule(settings, hostname);
  const profile = settings.profiles.find((item) => item.id === (site?.profileId ?? settings.activeProfileId));
  return schema.parse({ ...base, ...settings.global[key], ...(profile?.[key] ?? {}), ...(site?.[key] ?? {}) });
}

/** The named profile in effect on a site (the site's own, else the active one). */
export function profileFor(settings: Settings, hostname: string): NamedProfile | undefined {
  const site = matchingSiteRule(settings, hostname);
  const id = site?.profileId ?? settings.activeProfileId;
  return id ? settings.profiles.find((profile) => profile.id === id) : undefined;
}

/** P11: is the dyslexia lens on for this site (the profile in effect asks for it)? */
export function lensActive(settings: Settings, hostname: string): boolean {
  return isSiteEnabled(settings, hostname) && profileFor(settings, hostname)?.dyslexiaLens === true;
}

export function resolveFocus(settings: Settings, hostname: string): FocusPrefs { return FocusPrefsSchema.parse(resolveFeature(settings, hostname, "focus", FocusPrefsSchema)); }
export function resolveMotion(settings: Settings, hostname: string): MotionPrefs { return MotionPrefsSchema.parse(resolveFeature(settings, hostname, "motion", MotionPrefsSchema)); }

// ─── Is site enabled? ────────────────────────────────────────────────────────
export function isSiteEnabled(settings: Settings, hostname: string): boolean {
  if (!settings.enabled) return false;
  const rule = matchingSiteRule(settings, hostname);
  return rule?.enabled !== false;
}

export function matchingSiteRule(settings: Settings, hostname: string): SiteRule | undefined {
  const normalized = normalizeHostname(hostname);
  return settings.siteRules.find((rule) => normalized === normalizeHostname(rule.hostname)) ??
    settings.siteRules.find((rule) => rule.includeSubdomains && normalized.endsWith(`.${normalizeHostname(rule.hostname)}`));
}

// ─── Migration table ─────────────────────────────────────────────────────────
// Add a function here when SETTINGS_VERSION bumps.
// Each fn takes the raw object from storage and returns the migrated object.
type MigrationFn = (raw: Record<string, unknown>) => Record<string, unknown>;
/** v11: letter and word spacing moved from px to em (px / 16, the default text size). */
function spacingToEm(typography: unknown): unknown {
  if (typeof typography !== "object" || typography === null) return typography;
  const next = { ...typography as Record<string, unknown> };
  const convert = (key: string, min: number, max: number) => {
    if (typeof next[key] === "number") next[key] = Math.min(max, Math.max(min, Math.round((next[key] as number) / 16 * 100) / 100));
  };
  convert("letterSpacing", -0.05, 0.5);
  convert("wordSpacing", -0.1, 1);
  return next;
}

const migrations: Record<number, MigrationFn> = {
  11: (raw) => {
    const global = typeof raw.global === "object" && raw.global !== null ? raw.global as Record<string, unknown> : undefined;
    const withTypography = (item: unknown) => typeof item === "object" && item !== null ? { ...item as Record<string, unknown>, typography: spacingToEm((item as Record<string, unknown>).typography) } : item;
    return {
      ...raw,
      ...(global ? { global: withTypography(global) } : {}),
      ...(Array.isArray(raw.profiles) ? { profiles: raw.profiles.map(withTypography) } : {}),
      ...(Array.isArray(raw.siteRules) ? { siteRules: raw.siteRules.map(withTypography) } : {}),
    };
  },
  10: (raw) => raw, // P10: review settings and text consent, added with defaults
  9: (raw) => {
    const ai = typeof raw.ai === "object" && raw.ai !== null ? raw.ai as Record<string, unknown> : {};
    // Streaming replies make the old 30 s local limit unnecessary; it cut off 7B models.
    return { ...raw, ai: { ...ai, localTimeoutMs: ai.localTimeoutMs === 30000 || ai.localTimeoutMs === undefined ? 120000 : ai.localTimeoutMs } };
  },
  8: (raw) => ({
    ...raw,
    ai: {
      ...(typeof raw.ai === "object" && raw.ai !== null ? raw.ai as Record<string, unknown> : {}),
      cloudTimeoutMs: 120000,
    },
  }),
  7: (raw) => raw,
  6: (raw) => raw, // AI settings fields added with defaults
  5: (raw) => raw,
  4: (raw) => raw,
  // Example (unused): 1: (raw) => ({ ...raw, newField: "default" }),
};

export function migrateSettings(raw: Record<string, unknown>): Settings {
  let data = { ...raw };
  const storedVersion = (data["version"] as number | undefined) ?? 0;

  for (let v = storedVersion; v < SETTINGS_VERSION; v++) {
    const migrate = migrations[v + 1];
    if (migrate) data = migrate(data);
  }

  data["version"] = SETTINGS_VERSION;
  const storedProfiles = Array.isArray(data["profiles"]) ? data["profiles"] as NamedProfile[] : [];
  const builtIns = BUILT_IN_PROFILES.map((preset) => {
    const stored = storedProfiles.find((profile) => profile.id === preset.id);
    return stored ? { ...preset, ...stored, builtIn: true, appearance: { ...preset.appearance, ...stored.appearance }, focus: { ...preset.focus, ...stored.focus }, motion: { ...preset.motion, ...stored.motion } } : preset;
  });
  data["profiles"] = [...builtIns, ...storedProfiles.filter((profile) => !BUILT_IN_PROFILES.some((preset) => preset.id === profile.id))];
  return SettingsSchema.parse(data);
}
