import { describe, expect, it } from "vitest";
import { matchIntents } from "../shared/intents";
import { defaultSettings, isSiteEnabled, resolveAppearance, resolveFocus, resolveMotion, resolveTypography, SiteRuleSchema, type Settings } from "../shared/settings";
import { currentAiValues, exactSiteRule, pruneSiteSelectors, resetSiteRule, restoreSiteRule, savedSiteSelectors, withSiteElements, withSitePatch, withSiteRule, withSiteTypography } from "../shared/sitePatch";

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

describe("withSiteElements (element preview and apply share it)", () => {
  const none = { hide: [], dim: [], highlight: [] };

  it("adds selectors to the exact-host rule without touching other sites", () => {
    const patched = withSiteElements(base(), "example.com", { ...none, hide: ["#cookie"], highlight: [".toc"] });
    expect(resolveFocus(patched, "example.com")).toMatchObject({ hiddenSelectors: ["#cookie"], highlightSelectors: [".toc"], dimSelectors: [] });
    expect(resolveFocus(patched, "other.org").hiddenSelectors).toEqual([]);
  });

  it("merges with saved selectors (and a profile's) without duplicates, capped at 30", () => {
    const settings = { ...base(), activeProfileId: "p", profiles: [...base().profiles, { id: "p", name: "P", builtIn: false, typography: resolveTypography(base(), "x"), appearance: resolveAppearance(base(), "x"), focus: resolveFocus({ ...base(), siteRules: [] }, "x") }] };
    settings.profiles.at(-1)!.focus!.hiddenSelectors = ["#profile-ad"];
    const once = withSiteElements(settings, "example.com", { ...none, hide: ["#cookie"] });
    const twice = withSiteElements(once, "example.com", { ...none, hide: ["#cookie", ...Array.from({ length: 40 }, (_, i) => `#x${i}`)] });
    const hidden = resolveFocus(twice, "example.com").hiddenSelectors;
    expect(hidden.slice(0, 2)).toEqual(["#profile-ad", "#cookie"]);
    expect(hidden).toHaveLength(30);
  });

  it("is a no-op for an empty plan", () => {
    const settings = base();
    expect(withSiteElements(settings, "example.com", none)).toBe(settings);
  });

  it("prunes stale selectors from every list and keeps the rest", () => {
    const patched = withSiteElements(base(), "example.com", { hide: ["#gone", "#here"], dim: ["#gone"], highlight: [".toc"] });
    expect(savedSiteSelectors(patched, "example.com")).toEqual(["#gone", "#here", ".toc"]);
    const pruned = pruneSiteSelectors(patched, "example.com", ["#gone"]);
    expect(resolveFocus(pruned, "example.com")).toMatchObject({ hiddenSelectors: ["#here"], dimSelectors: [], highlightSelectors: [".toc"] });
  });
});

describe("resetSiteRule (Reset page)", () => {
  const defaults = defaultSettings();
  const untouched = (settings: Settings, host: string) => {
    expect(resolveTypography(settings, host)).toEqual(resolveTypography(defaults, host));
    expect(resolveAppearance(settings, host)).toEqual(resolveAppearance(defaults, host));
    expect(resolveFocus(settings, host)).toEqual(resolveFocus(defaults, host));
    expect(resolveMotion(settings, host)).toEqual(resolveMotion(defaults, host));
  };

  it("removes the site's changes but keeps the extension on for it", () => {
    const changed = withSiteElements(withSitePatch(base(), "example.com", { fontSize: 22, theme: "dark", pauseAutoplay: true }), "example.com", { hide: ["#ad"], dim: [], highlight: [] });
    const reset = resetSiteRule(changed, "example.com");
    expect(isSiteEnabled(reset, "example.com")).toBe(true);
    untouched(reset, "example.com");
  });

  it("also neutralises a global profile and global settings on this site only", () => {
    const settings = { ...base(), activeProfileId: "minimal", global: { ...base().global, typography: { ...base().global.typography, fontSize: 20 } } };
    const reset = resetSiteRule(settings, "example.com");
    untouched(reset, "example.com");
    expect(resolveTypography(reset, "other.org")).toEqual(resolveTypography(settings, "other.org"));
    expect(resolveMotion(reset, "other.org").pauseAutoplay).toBe(true);
  });

  it("turns a site back on that an old reset had turned off", () => {
    const off = { ...base(), siteRules: [SiteRuleSchema.parse({ hostname: "example.com", enabled: false, typography: { fontSize: 30 } })] };
    const reset = resetSiteRule(off, "example.com");
    expect(isSiteEnabled(reset, "example.com")).toBe(true);
    untouched(reset, "example.com");
  });

  it("lets the next change apply straight away", () => {
    const reset = resetSiteRule({ ...base(), activeProfileId: "study" }, "example.com");
    expect(resolveTypography(withSiteTypography(reset, "example.com", { fontSize: 24 }), "example.com").fontSize).toBe(24);
    expect(resolveMotion(withSitePatch(reset, "example.com", { reduceMotion: true }), "example.com").reduceMotion).toBe(true);
  });
});

describe("withSiteRule (popup panels)", () => {
  it("changes one group and keeps the rest of the latest rule", () => {
    const dark = withSiteRule(base(), "example.com", (rule) => ({ ...rule, appearance: { ...rule.appearance, theme: "dark", engine: "smart" } }));
    const focused = withSiteRule(dark, "example.com", (rule) => ({ ...rule, focus: { ...(rule.focus ?? {}), collapseSidebars: true } }));
    expect(resolveAppearance(focused, "example.com")).toMatchObject({ theme: "dark", engine: "smart" });
    expect(resolveFocus(focused, "example.com").collapseSidebars).toBe(true);
  });

  it("copies a subdomain-wide rule into an exact rule instead of editing it", () => {
    const settings = { ...base(), siteRules: [SiteRuleSchema.parse({ hostname: "example.com", includeSubdomains: true, appearance: { theme: "sepia" } })] };
    const next = withSiteRule(settings, "docs.example.com", (rule) => ({ ...rule, motion: { reduceMotion: true } }));
    expect(exactSiteRule(next, "example.com")?.motion).toBeUndefined();
    expect(exactSiteRule(next, "docs.example.com")).toMatchObject({ includeSubdomains: false, appearance: { theme: "sepia" }, motion: { reduceMotion: true } });
  });
});
