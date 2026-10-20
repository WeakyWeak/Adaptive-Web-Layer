import { z } from "zod";

// ─── Schema version ──────────────────────────────────────────────────────────
// Bump this when you add a migration below.
export const SETTINGS_VERSION = 8;

// ─── Typography preferences ──────────────────────────────────────────────────
export const FONT_FAMILY_OPTIONS = [
  "",
  "Lexend",
  "Atkinson Hyperlegible",
  "Georgia",
  "Verdana",
  "system-ui",
] as const;

export const TypographyPrefsSchema = z.object({
  fontFamily: z.enum(FONT_FAMILY_OPTIONS).default(""), // "" = site default
  fontSize: z.number().min(10).max(48).default(16),
  lineHeight: z.number().min(1).max(3).default(1.5),
  letterSpacing: z.number().min(-2).max(10).default(0),
  wordSpacing: z.number().min(-4).max(20).default(0),
  paragraphSpacing: z.number().min(0).max(5).default(0),
  maxContentWidth: z.number().min(400).max(2000).default(800),
});
export type TypographyPrefs = z.infer<typeof TypographyPrefsSchema>;

export const AppearancePrefsSchema = z.object({
  theme: z.enum(["light", "dark", "sepia"]).default("light"),
  engine: z.enum(["fast", "smart"]).default("fast"),
  contrast: z.number().min(0.5).max(2).default(1),
  brightness: z.number().min(0.5).max(1.5).default(1),
  saturation: z.number().min(0).max(2).default(1),
  forceDark: z.boolean().default(false),
});
export type AppearancePrefs = z.infer<typeof AppearancePrefsSchema>;

export const FocusPrefsSchema = z.object({
  collapseSidebars: z.boolean().default(false),
  dimNonMain: z.boolean().default(false),
  staticifyStickyHeaders: z.boolean().default(false),
  hiddenSelectors: z.array(z.string().min(1).max(512)).max(30).default([]),
  preservedSelectors: z.array(z.string().min(1).max(512)).max(30).default([]),
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

// ─── Named profile ───────────────────────────────────────────────────────────
export const NamedProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  typography: TypographyPrefsSchema.default({}),
  appearance: AppearancePrefsSchema.default({}),
  focus: FocusPrefsSchema.optional(),
  motion: MotionPrefsSchema.optional(),
  builtIn: z.boolean().default(false),
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
export const AiSettingsSchema = z.object({
  mode: z.enum(["local", "cloud", "hybrid"]).default("local"),
  // llama-server default port is 8080; Ollama uses 11434 with /v1 endpoint
  localEndpoint: z.string().default("http://127.0.0.1:8080"),
  localModel: z.string().default("qwen2.5-coder:7b"),
  localContextSize: z.number().min(512).max(131072).default(8192),
  localApiKey: z.string().default(""),
  localTimeoutMs: z.number().min(1000).max(120000).default(30000),
  // The proxy is local; this token authorizes only that proxy, never Gemini.
  cloudModel: z.string().min(1).max(128).default("gemini-3.8-flash"),
  cloudProxyUrl: z.string().url().default("http://127.0.0.1:8787"),
  cloudProxyToken: z.string().max(512).default(""),
  cloudTimeoutMs: z.number().min(1000).max(120000).default(120000),
  cloudEnabled: z.boolean().default(false),
  demoMode: z.boolean().default(false),
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
});
export type PrivacySettings = z.infer<typeof PrivacySettingsSchema>;

export type CloudConsent = "allow" | "deny" | "pending";

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

export const BUILT_IN_PROFILES: NamedProfile[] = [
  { id: "study", name: "Study", builtIn: true, typography: TypographyPrefsSchema.parse({ fontFamily: "Atkinson Hyperlegible", fontSize: 18, lineHeight: 1.8, maxContentWidth: 900 }), appearance: AppearancePrefsSchema.parse({ theme: "sepia" }), focus: FocusPrefsSchema.parse({ collapseSidebars: true, dimNonMain: true }), motion: MotionPrefsSchema.parse({ reduceMotion: true }) },
  { id: "night", name: "Night", builtIn: true, typography: TypographyPrefsSchema.parse({ fontFamily: "Lexend", fontSize: 17, lineHeight: 1.7, maxContentWidth: 1000 }), appearance: AppearancePrefsSchema.parse({ theme: "dark" }), focus: FocusPrefsSchema.parse({}), motion: MotionPrefsSchema.parse({ reduceMotion: true }) },
  { id: "minimal", name: "Minimal", builtIn: true, typography: TypographyPrefsSchema.parse({ fontSize: 16, lineHeight: 1.5, maxContentWidth: 800 }), appearance: AppearancePrefsSchema.parse({}), focus: FocusPrefsSchema.parse({ collapseSidebars: true, dimNonMain: true, staticifyStickyHeaders: true }), motion: MotionPrefsSchema.parse({ reduceMotion: true, reduceParallax: true, pauseAutoplay: true }) },
  { id: "research", name: "Research", builtIn: true, typography: TypographyPrefsSchema.parse({ fontFamily: "Georgia", fontSize: 17, lineHeight: 1.75, maxContentWidth: 1100 }), appearance: AppearancePrefsSchema.parse({}), focus: FocusPrefsSchema.parse({}), motion: MotionPrefsSchema.parse({}) },
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
    if (siteRule?.disabledOperations.includes("fontFamily")) resolved.fontFamily = "";
    if (siteRule?.disabledOperations.includes("fontSize")) resolved.fontSize = base.fontSize;
    if (siteRule?.disabledOperations.includes("lineHeight")) resolved.lineHeight = base.lineHeight;
    if (siteRule?.disabledOperations.includes("letterSpacing")) resolved.letterSpacing = base.letterSpacing;
    if (siteRule?.disabledOperations.includes("wordSpacing")) resolved.wordSpacing = base.wordSpacing;
    if (siteRule?.disabledOperations.includes("paragraphSpacing")) resolved.paragraphSpacing = base.paragraphSpacing;
    if (siteRule?.disabledOperations.includes("maxContentWidth")) resolved.maxContentWidth = base.maxContentWidth;
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
const migrations: Record<number, MigrationFn> = {
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
