import { z } from "zod";

// ─── Schema version ──────────────────────────────────────────────────────────
// Bump this when you add a migration below.
export const SETTINGS_VERSION = 2;

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

// ─── Global preferences ──────────────────────────────────────────────────────
export const GlobalPrefsSchema = z.object({
  typography: TypographyPrefsSchema.default({}),
  applyToWholePage: z.boolean().default(false),
});
export type GlobalPrefs = z.infer<typeof GlobalPrefsSchema>;

// ─── Named profile ───────────────────────────────────────────────────────────
export const NamedProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  typography: TypographyPrefsSchema.default({}),
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
});
export type SiteRule = z.infer<typeof SiteRuleSchema>;

// ─── AI settings (placeholder; real values added in P05/P06) ─────────────────
export const AiSettingsSchema = z.object({
  mode: z.enum(["local", "cloud", "hybrid"]).default("local"),
  localEndpoint: z.string().default("http://localhost:11434"),
  localModel: z.string().default("qwen2.5-coder:7b"),
  localContextSize: z.number().min(512).max(131072).default(8192),
  cloudModel: z.string().default(""),
  cloudEnabled: z.boolean().default(false),
});
export type AiSettings = z.infer<typeof AiSettingsSchema>;

// ─── Privacy settings ────────────────────────────────────────────────────────
export const PrivacySettingsSchema = z.object({
  cloudConsent: z.boolean().default(false),
  cloudConsentTimestamp: z.number().optional(),
});
export type PrivacySettings = z.infer<typeof PrivacySettingsSchema>;

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
  { id: "study", name: "Study", builtIn: true, typography: TypographyPrefsSchema.parse({ fontFamily: "Atkinson Hyperlegible", fontSize: 18, lineHeight: 1.8, maxContentWidth: 900 }) },
  { id: "night", name: "Night", builtIn: true, typography: TypographyPrefsSchema.parse({ fontFamily: "Lexend", fontSize: 17, lineHeight: 1.7, maxContentWidth: 1000 }) },
  { id: "minimal", name: "Minimal", builtIn: true, typography: TypographyPrefsSchema.parse({ fontSize: 16, lineHeight: 1.5, maxContentWidth: 800 }) },
  { id: "research", name: "Research", builtIn: true, typography: TypographyPrefsSchema.parse({ fontFamily: "Georgia", fontSize: 17, lineHeight: 1.75, maxContentWidth: 1100 }) },
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
  if (!Array.isArray(data["profiles"]) || data["profiles"].length === 0) data["profiles"] = BUILT_IN_PROFILES;
  return SettingsSchema.parse(data);
}
