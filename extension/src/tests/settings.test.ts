import { describe, it, expect } from "vitest";
import {
  SettingsSchema,
  TypographyPrefsSchema,
  defaultSettings,
  resolveTypography,
  isSiteEnabled,
  migrateSettings,
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
    expect(s.enabled).toBe(true);
    expect(s.ai.mode).toBe("local");
    expect(s.privacy.cloudConsent).toBe(false);
  });

  it("rejects malformed settings imports", () => {
    expect(SettingsSchema.safeParse({ version: 2, global: { typography: { fontSize: 999 } } }).success).toBe(false);
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
    }];
    settings.activeProfileId = "study";
    settings.siteRules = [{
      hostname: "example.com",
      enabled: true,
      includeSubdomains: false,
      profileId: null,
      disabledOperations: [],
      typography: { fontSize: 22 },
    }];
    const resolved = resolveTypography(settings, "example.com");
    expect(resolved.fontSize).toBe(22);
  });

  it("a site-assigned profile applies when there is no global active profile", () => {
    const settings = defaultSettings();
    settings.siteRules = [{ hostname: "example.com", enabled: true, includeSubdomains: false, profileId: "study", disabledOperations: [], typography: {} }];
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
    }];
    const resolved = resolveTypography(settings, "other.com");
    expect(resolved.fontSize).toBe(16);
  });

  it("normalizes hostnames and only includes subdomains when requested", () => {
    const settings = defaultSettings();
    settings.siteRules = [{ hostname: " Example.COM ", enabled: true, includeSubdomains: false, profileId: null, disabledOperations: [], typography: { fontSize: 24 } }];
    expect(resolveTypography(settings, "example.com").fontSize).toBe(24);
    expect(resolveTypography(settings, "docs.example.com").fontSize).toBe(16);
    settings.siteRules[0].includeSubdomains = true;
    expect(resolveTypography(settings, "docs.example.com").fontSize).toBe(24);
  });

  it("a disabled site applies no custom typography", () => {
    const settings = defaultSettings();
    settings.global.typography.fontSize = 20;
    settings.siteRules = [{ hostname: "example.com", enabled: false, includeSubdomains: false, profileId: null, disabledOperations: [], typography: {} }];
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
    }];
    settings.activeProfileId = "p1";
    settings.siteRules = [{
      hostname: "foo.com",
      enabled: true,
      includeSubdomains: false,
      profileId: null,
      disabledOperations: [],
      typography: { letterSpacing: 3 },
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
    settings.siteRules = [{ hostname: "example.com", enabled: false, includeSubdomains: false, profileId: null, disabledOperations: [], typography: {} }];
    expect(isSiteEnabled(settings, "example.com")).toBe(false);
  });

  it("returns true when rule has enabled: true", () => {
    const settings = defaultSettings();
    settings.siteRules = [{ hostname: "example.com", enabled: true, includeSubdomains: false, profileId: null, disabledOperations: [], typography: {} }];
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

  it("resets invalid fields to defaults during migration", () => {
    // fontSize out of range would be coerced/rejected; Zod will apply default
    // Since we use .parse() which throws, and migrateSettings catches → returns defaults
    const migrated = migrateSettings({ fontSize: 999 }); // top-level wrong field
    // Zod ignores unknown fields in partial mode, so fontSize at top level is fine
    expect(migrated.global.typography.fontSize).toBe(16); // default
  });
});
