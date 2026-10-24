// @vitest-environment jsdom
// P11 operations: noItalics, unjustify and noAllCaps mark only text the page
// styles that way (never code or controls) and revert exactly; the background
// tint keeps text at 7:1 or better, and stays out of dark mode. Also the
// v11 migration (spacing px → em), the built-in profile and its intent.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { contrastRatio, parseCssColor } from "../lib/color";
import { readableTextOn } from "../content/contrast";
import { forgetContentRegion } from "../content/domUtils";
import { textShapeOperations, tintable, tintOperations, TINT_COLOURS, tintTextColour } from "../content/dyslexiaOps";
import { matchIntents } from "../shared/intents";
import { applyPlan, registerOperation, type StyleLayer } from "../shared/registry";
import { BACKGROUND_TINTS, BUILT_IN_PROFILES, defaultSettings, DYSLEXIA_START_ID, lensActive, migrateSettings, SETTINGS_VERSION } from "../shared/settings";
import { currentAiValues } from "../shared/sitePatch";

function layer(): StyleLayer & { rules: Map<string, string> } {
  const rules = new Map<string, string>();
  return { rules, set: (id, css) => rules.set(id, css), get: (id) => rules.get(id), remove: (id) => rules.delete(id), clear: () => rules.clear() };
}

const ctx = (styleLayer: StyleLayer) => ({ styleLayer, applyToWholePage: false });
const marked = (attribute: string) => Array.from(document.querySelectorAll(`[${attribute}]`)).map((element) => `${element.id}:${element.getAttribute(attribute)!.split("-").pop()}`);

beforeAll(() => { [...textShapeOperations, ...tintOperations].forEach(registerOperation); });
afterEach(() => { document.body.innerHTML = ""; forgetContentRegion(); });

const PAGE = `
  <main>
    <p id="lede" style="font-style: italic; text-align: justify">A slanted, justified opening paragraph about the city water works and its long repair plan.</p>
    <p id="body">Normal text with <em id="emph" style="font-style: italic; display: inline">real emphasis</em> inside it, and more words after that.</p>
    <p id="caps" style="text-transform: uppercase">Styled in capitals by the site's own stylesheet rules.</p>
    <pre id="code" style="font-style: italic; text-transform: uppercase; text-align: justify"><code id="inner" style="font-style: italic">const status = "excavation";</code></pre>
    <button id="button" style="font-style: italic; text-transform: uppercase">Subscribe now</button>
  </main>`;

describe("text-shape operations", () => {
  it("restyle only italic, justified and capitalised text, keep emphasis semi-bold, and revert exactly", () => {
    document.body.innerHTML = PAGE;
    const styles = layer();
    const result = applyPlan(ctx(styles), [
      { opId: "noItalics", params: { enabled: true } },
      { opId: "unjustify", params: { enabled: true } },
      { opId: "noAllCaps", params: { enabled: true } },
    ]);
    expect(result.errors).toEqual([]);
    // Inline italics inside upright text are emphasis; a whole italic paragraph just turns upright.
    expect(marked("data-awl-noitalics").sort()).toEqual(["emph:emph", "lede:plain"]);
    expect(marked("data-awl-unjustify")).toEqual(["lede:x"]);
    expect(marked("data-awl-noallcaps")).toEqual(["caps:x"]);
    expect(styles.rules.get("noItalics")).toMatch(/font-style: normal !important; font-weight: 600/);
    expect(styles.rules.get("unjustify")).toMatch(/text-align: start/);
    expect(styles.rules.get("noAllCaps")).toMatch(/text-transform: none/);

    result.revert();
    expect(styles.rules.size).toBe(0);
    expect(document.querySelectorAll("[data-awl-noitalics], [data-awl-unjustify], [data-awl-noallcaps]")).toHaveLength(0);
  });

  it("never touches code, preformatted text or controls", () => {
    document.body.innerHTML = PAGE;
    applyPlan(ctx(layer()), ["noItalics", "unjustify", "noAllCaps"].map((opId) => ({ opId, params: { enabled: true } })));
    for (const id of ["code", "inner", "button"]) {
      const element = document.getElementById(id)!;
      expect(element.getAttributeNames().filter((name) => name.startsWith("data-awl-")), id).toEqual([]);
    }
  });

  it("does nothing when off, and an earlier entry is restored on revert", () => {
    document.body.innerHTML = PAGE;
    const styles = layer();
    styles.set("noItalics", "/* earlier */");
    const result = applyPlan(ctx(styles), [{ opId: "noItalics", params: { enabled: false } }]);
    expect(styles.rules.has("noItalics")).toBe(false);
    expect(document.querySelectorAll("[data-awl-noitalics]")).toHaveLength(0);
    result.revert();
    expect(styles.rules.get("noItalics")).toBe("/* earlier */");
  });
});

describe("background tint", () => {
  it("every tint keeps text at 7:1 or better", () => {
    for (const tint of BACKGROUND_TINTS.filter((value) => value !== "none")) {
      const ratio = contrastRatio(parseCssColor(tintTextColour(tint))!, parseCssColor(TINT_COLOURS[tint])!);
      expect(ratio, tint).toBeGreaterThanOrEqual(7);
    }
    // The picker darkens a too-light preference until it passes.
    const picked = readableTextOn(parseCssColor("#fde5d0")!, 7, parseCssColor("#888888")!);
    expect(contrastRatio(picked, parseCssColor("#fde5d0")!)).toBeGreaterThanOrEqual(7);
  });

  it("repaints white surfaces, darkens faint text on them, and leaves coloured panels alone", () => {
    document.body.innerHTML = `<main id="main" style="background-color: #ffffff"><p id="faint" style="color: #8a8a8a">Faint grey text on white paper, hard to read.</p><p id="ok" style="color: #111111">Dark text that already passes.</p><div id="callout" style="background-color: #dbeafe"><p id="blue">A blue callout keeps its colour.</p></div></main>`;
    const styles = layer();
    const result = applyPlan(ctx(styles), [{ opId: "backgroundTint", params: { value: "cream", theme: "light", bodyReady: true } }]);
    expect(result.errors).toEqual([]);
    const marks = marked("data-awl-tint");
    expect(marks).toContain("main:bg");
    expect(marks).toContain("faint:text");
    expect(marks.some((mark) => mark.startsWith("ok:") || mark.startsWith("callout:") || mark.startsWith("blue:"))).toBe(false);
    expect(styles.rules.get("backgroundTint")).toContain(TINT_COLOURS.cream);
    result.revert();
    expect(document.querySelectorAll("[data-awl-tint]")).toHaveLength(0);
    expect(styles.rules.size).toBe(0);
  });

  it("applies only to the light and sepia themes", () => {
    document.body.innerHTML = `<main style="background-color: #ffffff"><p>Some text on white.</p></main>`;
    const styles = layer();
    applyPlan(ctx(styles), [{ opId: "backgroundTint", params: { value: "peach", theme: "dark", bodyReady: true } }]);
    expect(styles.rules.has("backgroundTint")).toBe(false);
    expect(tintable(parseCssColor("#fff8e8")!, "sepia")).toBe(true);
    expect(tintable(parseCssColor("#fff8e8")!, "light")).toBe(false);
    expect(tintable(parseCssColor("#ffffff")!, "light")).toBe(true);
  });
});

describe("settings v11 and the dyslexia start", () => {
  it("moves letter and word spacing from px to em everywhere", () => {
    const migrated = migrateSettings({
      version: 10,
      global: { typography: { letterSpacing: 2, wordSpacing: 4 } },
      profiles: [{ id: "custom", name: "Mine", typography: { letterSpacing: 1 } }],
      siteRules: [{ hostname: "example.com", typography: { wordSpacing: 20 } }],
    });
    expect(migrated.version).toBe(SETTINGS_VERSION);
    expect(migrated.global.typography).toMatchObject({ letterSpacing: 0.13, wordSpacing: 0.25 });
    expect(migrated.profiles.find((profile) => profile.id === "custom")?.typography.letterSpacing).toBe(0.06);
    // 20px / 16 = 1.25em, clamped to the 1em maximum.
    expect(migrated.siteRules[0].typography.wordSpacing).toBe(1);
  });

  it("ships a labelled starting point with the lens on, and 'dyslexia' maps to it", () => {
    const profile = BUILT_IN_PROFILES.find((item) => item.id === DYSLEXIA_START_ID)!;
    expect(profile.typography).toMatchObject({ fontFamily: "Atkinson Hyperlegible", fontSize: 18, letterSpacing: 0.12, wordSpacing: 0.16, lineHeight: 1.6, unjustify: true, noItalics: true });
    expect(profile.appearance.backgroundTint).toBe("cream");
    expect(profile.dyslexiaLens).toBe(true);
    expect(profile.note).toMatch(/starting point/i);
    const settings = defaultSettings();
    expect(lensActive(settings, "example.com")).toBe(false);
    expect(lensActive({ ...settings, activeProfileId: DYSLEXIA_START_ID }, "example.com")).toBe(true);
    const plan = matchIntents("make this dyslexia friendly", currentAiValues(settings, "example.com"))!;
    expect(plan.changes).toEqual({ fontFamily: "Atkinson Hyperlegible", fontSize: 18, letterSpacing: 0.12, wordSpacing: 0.16, lineHeight: 1.6, unjustify: true, noItalics: true, backgroundTint: "cream" });
  });

  it("finds the new switches by keyword", () => {
    const current = currentAiValues(defaultSettings(), "example.com");
    expect(matchIntents("no italics please", current)?.changes).toEqual({ noItalics: true });
    expect(matchIntents("stop justifying the text", current)?.changes).toEqual({ unjustify: true });
    expect(matchIntents("I can't read all caps", current)?.changes).toEqual({ noAllCaps: true });
    expect(matchIntents("use a peach tint", current)?.changes).toEqual({ backgroundTint: "peach" });
  });
});
