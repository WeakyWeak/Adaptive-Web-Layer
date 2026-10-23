import { describe, it, expect } from "vitest";
import {
  SettingsSchema,
  AppearancePrefsSchema,
  TypographyPrefsSchema,
  defaultSettings,
  resolveTypography,
  resolveAppearance,
  isSiteEnabled,
  migrateSettings,
  cloudTextAllowed,
  SETTINGS_VERSION,
} from "../shared/settings";

describe("SettingsSchema", () => {
  it("parses empty object to defaults", () => {
    const s = SettingsSchema.parse({});
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(s.global.typography.fontSize).toBe(16);
    expect(s.global.typography.lineHeight).toBe(1.5);
    expect(s.global.typography.fontFamily).toBe("");
    expect(s.profiles).toEqual([]);
    expect(s.siteRules).toEqual([]);
  });

  it("rejects fontSize out of range (too low)", () => {
    const result = TypographyPrefsSchema.safeParse({ fontSize: 5 });
    expect(result.success).toBe(false);
  });

  it("rejects fontSize out of range (too high)", () => {
    const result = TypographyPrefsSchema.safeParse({ fontSize: 100 });
    expect(result.success).toBe(false);
  });

  it("rejects lineHeight out of range", () => {
    const result = TypographyPrefsSchema.safeParse({ lineHeight: 10 });
    expect(result.success).toBe(false);
  });

  it("rejects letterSpacing out of range (too low)", () => {
    const result = TypographyPrefsSchema.safeParse({ letterSpacing: -5 });
    expect(result.success).toBe(false);
  });

  it("rejects wordSpacing out of range", () => {
    const result = TypographyPrefsSchema.safeParse({ wordSpacing: 50 });
    expect(result.success).toBe(false);
  });

  it("rejects paragraphSpacing out of range", () => {
    const result = TypographyPrefsSchema.safeParse({ paragraphSpacing: 10 });
    expect(result.success).toBe(false);
  });

  it("rejects maxContentWidth too low", () => {
    const result = TypographyPrefsSchema.safeParse({ maxContentWidth: 100 });
    expect(result.success).toBe(false);
  });

  it("rejects maxContentWidth too high", () => {
    const result = TypographyPrefsSchema.safeParse({ maxContentWidth: 5000 });
    expect(result.success).toBe(false);
  });

  it("accepts valid fontSize in range", () => {
    const result = TypographyPrefsSchema.safeParse({ fontSize: 20 });
    expect(result.success).toBe(true);
  });

  it("rejects unsupported font names", () => {
    expect(TypographyPrefsSchema.safeParse({ fontFamily: '"; color: red; /*' }).success).toBe(false);
  });

  it("accepts valid lineHeight at boundaries", () => {
    expect(TypographyPrefsSchema.safeParse({ lineHeight: 1 }).success).toBe(true);
    expect(TypographyPrefsSchema.safeParse({ lineHeight: 3 }).success).toBe(true);
  });
});

describe("defaultSettings", () => {
  it("returns a fully typed defaults object", () => {
    const s = defaultSettings();
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(s.global.applyToWholePage).toBe(false);
    expect(s.activeProfileId).toBeNull();
    expect(s.profiles.map((profile) => profile.name)).toEqual(["Study", "Night", "Minimal", "Research"]);
    expect(s.profiles.find((profile) => profile.id === "night")?.appearance.theme).toBe("dark");
    expect(s.profiles.find((profile) => profile.id === "study")?.appearance.theme).toBe("sepia");
    expect(s.enabled).toBe(true);
    expect(s.ai.mode).toBe("local");
    expect(s.privacy.cloudConsent).toBe(false);
  });

  it("rejects malformed settings imports", () => {
    expect(SettingsSchema.safeParse({ version: 2, global: { typography: { fontSize: 999 } } }).success).toBe(false);
  });
});

describe("AppearancePrefsSchema", () => {
  it("defaults to Fast and accepts the opt-in Smart engine", () => {
    expect(AppearancePrefsSchema.parse({}).engine).toBe("fast");
    expect(AppearancePrefsSchema.parse({ engine: "smart" }).engine).toBe("smart");
  });

  it("enforces bounded contrast, brightness, and saturation", () => {
    expect(AppearancePrefsSchema.safeParse({ contrast: 2.1 }).success).toBe(false);
    expect(AppearancePrefsSchema.safeParse({ brightness: 0.4 }).success).toBe(false);
    expect(AppearancePrefsSchema.safeParse({ saturation: 2.1 }).success).toBe(false);
  });
});

describe("resolveAppearance", () => {
  it("uses global, profile, then site appearance values", () => {
    const settings = defaultSettings();
    settings.global.appearance.theme = "sepia";
    settings.activeProfileId = "night";
    settings.siteRules = [{ hostname: "example.com", enabled: true, includeSubdomains: false, profileId: null, disabledOperations: [], typography: {}, appearance: { theme: "light", contrast: 1.4 } }];
    const resolved = resolveAppearance(settings, "example.com");
    expect(resolved.theme).toBe("light");
    expect(resolved.contrast).toBe(1.4);
    expect(resolveAppearance(settings, "other.com").theme).toBe("dark");
  });

  it("resolves a site-assigned profile and its force-dark option", () => {
    const settings = defaultSettings();
    settings.siteRules = [{ hostname: "example.com", enabled: true, includeSubdomains: false, profileId: "night", disabledOperations: [], typography: {}, appearance: { forceDark: true } }];
    const resolved = resolveAppearance(settings, "example.com");
    expect(resolved.theme).toBe("dark");
    expect(resolved.forceDark).toBe(true);
  });

  it("supports a site theme override independently of another site's theme", () => {
    const settings = defaultSettings();
    settings.siteRules = [{ hostname: "one.example", enabled: true, includeSubdomains: false, profileId: null, disabledOperations: [], typography: {}, appearance: { theme: "dark", engine: "smart" } }];
    expect(resolveAppearance(settings, "one.example").theme).toBe("dark");
    expect(resolveAppearance(settings, "one.example").engine).toBe("smart");
    expect(resolveAppearance(settings, "two.example").theme).toBe("light");
  });
});

describe("resolveTypography", () => {
  it("returns global prefs when no profile or site override", () => {
    const settings = defaultSettings();
    settings.global.typography.fontSize = 20;
    const resolved = resolveTypography(settings, "example.com");
    expect(resolved.fontSize).toBe(20);
  });

  it("active profile overrides global", () => {
    const settings = defaultSettings();
    settings.global.typography.fontSize = 16;
    settings.profiles = [{
      id: "study",
      name: "Study",
      builtIn: false,
      typography: { ...TypographyPrefsSchema.parse({}), fontSize: 18 },
      appearance: AppearancePrefsSchema.parse({}),
    }];
    settings.activeProfileId = "study";
    const resolved = resolveTypography(settings, "example.com");
    expect(resolved.fontSize).toBe(18);
  });

  it("site override wins over profile", () => {
    const settings = defaultSettings();
    settings.global.typography.fontSize = 16;
    settings.profiles = [{
      id: "study",
      name: "Study",
      builtIn: false,
      typography: { ...TypographyPrefsSchema.parse({}), fontSize: 18 },
      appearance: AppearancePrefsSchema.parse({}),
    }];
    settings.activeProfileId = "study";
    settings.siteRules = [{
      hostname: "example.com",
      enabled: true,
      includeSubdomains: false,
      profileId: null,
      disabledOperations: [],
      typography: { fontSize: 22 },
      appearance: {},
    }];
    const resolved = resolveTypography(settings, "example.com");
    expect(resolved.fontSize).toBe(22);
  });

  it("a site-assigned profile applies when there is no global active profile", () => {
    const settings = defaultSettings();
    settings.siteRules = [{ hostname: "example.com", enabled: true, includeSubdomains: false, profileId: "study", disabledOperations: [], typography: {}, appearance: {} }];
    const resolved = resolveTypography(settings, "example.com");
    expect(resolved.fontSize).toBe(18);
  });

  it("site override does not apply to other hostnames", () => {
    const settings = defaultSettings();
    settings.global.typography.fontSize = 16;
    settings.siteRules = [{
      hostname: "example.com",
      enabled: true,
      includeSubdomains: false,
      profileId: null,
      disabledOperations: [],
      typography: { fontSize: 22 },
      appearance: {},
    }];
    const resolved = resolveTypography(settings, "other.com");
    expect(resolved.fontSize).toBe(16);
  });

  it("normalizes hostnames and only includes subdomains when requested", () => {
    const settings = defaultSettings();
    settings.siteRules = [{ hostname: " Example.COM ", enabled: true, includeSubdomains: false, profileId: null, disabledOperations: [], typography: { fontSize: 24 }, appearance: {} }];
    expect(resolveTypography(settings, "example.com").fontSize).toBe(24);
    expect(resolveTypography(settings, "docs.example.com").fontSize).toBe(16);
    settings.siteRules[0].includeSubdomains = true;
    expect(resolveTypography(settings, "docs.example.com").fontSize).toBe(24);
  });

  it("a disabled site applies no custom typography", () => {
    const settings = defaultSettings();
    settings.global.typography.fontSize = 20;
    settings.siteRules = [{ hostname: "example.com", enabled: false, includeSubdomains: false, profileId: null, disabledOperations: [], typography: {}, appearance: {} }];
    expect(resolveTypography(settings, "example.com").fontSize).toBe(16);
    expect(resolveTypography(settings, "other.com").fontSize).toBe(20);
  });

  it("resolution order: defaults < global < profile < site", () => {
    const settings = defaultSettings();
    // letterSpacing default = 0
    settings.global.typography.letterSpacing = 1;
    settings.profiles = [{
      id: "p1",
      name: "P1",
      builtIn: false,
      typography: { ...TypographyPrefsSchema.parse({}), letterSpacing: 2 },
      appearance: AppearancePrefsSchema.parse({}),
    }];
    settings.activeProfileId = "p1";
    settings.siteRules = [{
      hostname: "foo.com",
      enabled: true,
      includeSubdomains: false,
      profileId: null,
      disabledOperations: [],
      typography: { letterSpacing: 3 },
      appearance: {},
    }];
    const resolved = resolveTypography(settings, "foo.com");
    expect(resolved.letterSpacing).toBe(3);

    const resolvedOther = resolveTypography(settings, "bar.com");
    expect(resolvedOther.letterSpacing).toBe(2); // profile wins
  });
});

describe("isSiteEnabled", () => {
  it("returns true when no rule for hostname", () => {
    const settings = defaultSettings();
    expect(isSiteEnabled(settings, "example.com")).toBe(true);
  });

  it("returns false when rule has enabled: false", () => {
    const settings = defaultSettings();
    settings.siteRules = [{ hostname: "example.com", enabled: false, includeSubdomains: false, profileId: null, disabledOperations: [], typography: {}, appearance: {} }];
    expect(isSiteEnabled(settings, "example.com")).toBe(false);
  });

  it("returns true when rule has enabled: true", () => {
    const settings = defaultSettings();
    settings.siteRules = [{ hostname: "example.com", enabled: true, includeSubdomains: false, profileId: null, disabledOperations: [], typography: {}, appearance: {} }];
    expect(isSiteEnabled(settings, "example.com")).toBe(true);
  });
});

describe("migrateSettings", () => {
  it("handles missing version by parsing from defaults", () => {
    const migrated = migrateSettings({});
    expect(migrated.version).toBe(SETTINGS_VERSION);
  });

  it("preserves valid fields across migration", () => {
    const migrated = migrateSettings({ version: 0, global: { typography: { fontSize: 22 } } });
    expect(migrated.global.typography.fontSize).toBe(22);
  });

  it("extends previously saved cloud requests to two minutes", () => {
    const migrated = migrateSettings({ version: 7, ai: { cloudTimeoutMs: 30000 } });
    expect(migrated.ai.cloudTimeoutMs).toBe(120000);
  });

  it("resets invalid fields to defaults during migration", () => {
    // fontSize out of range would be coerced/rejected; Zod will apply default
    // Since we use .parse() which throws, and migrateSettings catches → returns defaults
    const migrated = migrateSettings({ fontSize: 999 }); // top-level wrong field
    // Zod ignores unknown fields in partial mode, so fontSize at top level is fine
    expect(migrated.global.typography.fontSize).toBe(16); // default
  });

  it("adds the P10 review settings and keeps page text off for the reviewer", () => {
    const migrated = migrateSettings({ version: 9, ai: { mode: "hybrid", cloudBackend: "gemini" }, privacy: { cloudSiteConsents: { "example.com": "allow" } } });
    expect(migrated.version).toBe(10);
    expect(migrated.ai).toMatchObject({ mode: "hybrid", reviewPolicy: "always", reviewModel: "gemini-3.5-flash" });
    expect(migrated.privacy.cloudTextSites).toEqual({});
    expect(cloudTextAllowed(migrated.privacy, "example.com")).toBe(false);
    expect(cloudTextAllowed({ ...migrated.privacy, cloudTextSites: { "example.com": true } }, "example.com")).toBe(true);
    // Text consent never applies without cloud consent.
    expect(cloudTextAllowed({ ...migrated.privacy, cloudSiteConsents: {}, cloudTextSites: { "example.com": true } }, "example.com")).toBe(false);
  });

  it("adds the P03 built-in appearance presets to older stored profiles", () => {
    const migrated = migrateSettings({ version: 2, profiles: [{ id: "night", name: "Night", typography: {} }] });
    expect(migrated.profiles.find((profile) => profile.id === "night")?.appearance.theme).toBe("dark");
    expect(migrated.profiles.find((profile) => profile.id === "study")?.appearance.theme).toBe("sepia");
  });
});
