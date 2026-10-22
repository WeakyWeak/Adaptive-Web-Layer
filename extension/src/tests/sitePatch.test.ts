import { describe, expect, it } from "vitest";
import { matchIntents } from "../shared/intents";
import { defaultSettings, resolveAppearance, resolveMotion, resolveTypography, SiteRuleSchema, type Settings } from "../shared/settings";
import { currentAiValues, exactSiteRule, restoreSiteRule, withSitePatch } from "../shared/sitePatch";

const base = (): Settings => defaultSettings();

describe("withSitePatch (preview and apply share it)", () => {
  it("routes each change into the right settings group", () => {
    const patched = withSitePatch(base(), "example.com", { fontSize: 22, theme: "dark", reduceMotion: true });
    expect(resolveTypography(patched, "example.com").fontSize).toBe(22);
    expect(resolveAppearance(patched, "example.com").theme).toBe("dark");
    expect(resolveMotion(patched, "example.com").reduceMotion).toBe(true);
  });

  it("only affects the patched site", () => {
    const patched = withSitePatch(base(), "example.com", { fontSize: 22 });
    expect(resolveTypography(patched, "other.org").fontSize).toBe(16);
  });

  it("wins over the active profile (site override precedence)", () => {
    const settings = { ...base(), activeProfileId: "study" };
    expect(resolveTypography(settings, "example.com").fontSize).toBe(18);
    expect(resolveTypography(withSitePatch(settings, "example.com", { fontSize: 24 }), "example.com").fontSize).toBe(24);
  });

  it("merges into an existing exact rule without losing its fields", () => {
    const settings = { ...base(), siteRules: [SiteRuleSchema.parse({ hostname: "example.com", profileId: "night", typography: { lineHeight: 2 } })] };
    const rule = exactSiteRule(withSitePatch(settings, "example.com", { fontSize: 20 }), "example.com");
    expect(rule).toMatchObject({ profileId: "night", typography: { lineHeight: 2, fontSize: 20 } });
  });

  it("does not modify a subdomain-wide rule; creates an exact-host rule instead", () => {
    const wide = SiteRuleSchema.parse({ hostname: "example.com", includeSubdomains: true, typography: { lineHeight: 2 } });
    const settings = { ...base(), siteRules: [wide] };
    const patched = withSitePatch(settings, "docs.example.com", { fontSize: 20 });
    expect(patched.siteRules.find((rule) => rule.hostname === "example.com")).toEqual(wide);
    expect(resolveTypography(patched, "docs.example.com")).toMatchObject({ fontSize: 20, lineHeight: 2 });
  });
});

describe("restoreSiteRule (undo)", () => {
  it("restores the previous rule exactly", () => {
    const previous = SiteRuleSchema.parse({ hostname: "example.com", typography: { fontSize: 18 } });
    const settings = { ...base(), siteRules: [previous] };
    const applied = withSitePatch(settings, "example.com", { fontSize: 30 });
    expect(restoreSiteRule(applied, "example.com", previous).siteRules).toEqual([previous]);
  });

  it("removes the rule when there was none before", () => {
    const applied = withSitePatch(base(), "example.com", { fontSize: 30 });
    expect(restoreSiteRule(applied, "example.com", undefined).siteRules).toEqual([]);
  });
});

describe("currentAiValues", () => {
  it("returns the resolved value of every AI field", () => {
    const values = currentAiValues(withSitePatch(base(), "example.com", { fontSize: 21 }), "example.com");
    expect(values).toMatchObject({ fontSize: 21, theme: "light", reduceMotion: false });
  });
});

describe("matchIntents (no-AI fallback and demo mode)", () => {
  const current = currentAiValues(base(), "example.com");

  it("maps common requests to bounded changes relative to current values", () => {
    expect(matchIntents("make the text bigger", current)?.changes).toEqual({ fontSize: 20 });
    expect(matchIntents("dark mode please and stop animations", current)?.changes).toMatchObject({ theme: "dark", reduceMotion: true });
  });

  it("clamps to the Zod bounds", () => {
    expect(matchIntents("bigger text", { ...current, fontSize: 47 })?.changes.fontSize).toBe(48);
  });

  it("returns null when nothing matches", () => {
    expect(matchIntents("tell me a joke", current)).toBeNull();
  });
});
