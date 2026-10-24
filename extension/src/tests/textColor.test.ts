// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { contrastRatio, parseCssColor } from "../lib/color";
import { appearancePlanSteps, registerAppearanceOps } from "../content/appearanceOps";
import { forgetContentRegion } from "../content/domUtils";
import { TEXT_SHADES, textShadeFor } from "../content/readabilityOps";
import { matchIntents } from "../shared/intents";
import { applyPlan, type StyleLayer } from "../shared/registry";
import { AppearancePrefsSchema, defaultSettings, TEXT_COLOR_OPTIONS } from "../shared/settings";
import { currentAiValues } from "../shared/sitePatch";
import { PlanChangesSchema } from "../shared/aiFields";
import { dropUnrequestedColour, dropUnrequestedSwitches } from "../background/planner";
import { requestedFields } from "../shared/review";

const WHITE = parseCssColor("#ffffff")!;
const DARK = parseCssColor("#121212")!;

function layer(): StyleLayer & { rules: Map<string, string> } {
  const rules = new Map<string, string>();
  return { rules, set: (id, css) => rules.set(id, css), get: (id) => rules.get(id), remove: (id) => rules.delete(id), clear: () => rules.clear() };
}

describe("text colour shades", () => {
  it("every named colour has a shade that reads on white and one that reads on a dark page", () => {
    for (const [name, shades] of Object.entries(TEXT_SHADES)) {
      expect(contrastRatio(parseCssColor(shades.onLight)!, WHITE), `${name} on white`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(parseCssColor(shades.onDark)!, DARK), `${name} on dark`).toBeGreaterThanOrEqual(4.5);
    }
    expect(Object.keys(TEXT_SHADES).sort()).toEqual(TEXT_COLOR_OPTIONS.filter(Boolean).sort());
  });
  it("picks the shade for what is behind the text, and none on a mid-tone band", () => {
    expect(textShadeFor("red", WHITE)).toBe("onLight");
    expect(textShadeFor("red", DARK)).toBe("onDark");
    expect(textShadeFor("grey", parseCssColor("#8a8a8a")!)).toBeNull();
  });
});

describe("text colour requests", () => {
  it("is a bounded setting the model can pick, and the keyword fallback finds it", () => {
    expect(PlanChangesSchema.safeParse({ textColor: "red" }).success).toBe(true);
    expect(PlanChangesSchema.safeParse({ textColor: "#ff0000" }).success).toBe(false);
    const current = currentAiValues(defaultSettings(), "example.com");
    expect(matchIntents("Make the text color to red.", current)?.changes).toEqual({ textColor: "red" });
    expect(matchIntents("blue text please", current)?.changes).toEqual({ textColor: "blue" });
  });

  it("links have their own colour, and \"make the links red and underline them\" is understood", () => {
    expect(PlanChangesSchema.safeParse({ linkColor: "red" }).success).toBe(true);
    const current = currentAiValues(defaultSettings(), "example.com");
    expect(matchIntents("make the links red and underline them", current)?.changes).toEqual({ linkColor: "red", underlineLinks: true });
    expect(matchIntents("make the text black and the links blue", current)?.changes).toEqual({ textColor: "black", linkColor: "blue" });
    // A named colour is a colour request: the planner keeps it (it used to drop "red" as unasked-for colour).
    expect(dropUnrequestedColour("make the links red and underline it", { linkColor: "red", underlineLinks: true }).changes).toEqual({ linkColor: "red", underlineLinks: true });
    expect(dropUnrequestedSwitches("make the links red and underline it", { linkColor: "red", underlineLinks: true }).changes).toEqual({ linkColor: "red", underlineLinks: true });
    expect(requestedFields("make the links red and underline it")).toEqual(new Set(["linkColor", "underlineLinks"]));
  });
});

describe("text colour operation", () => {
  beforeAll(() => {
    registerAppearanceOps();
    if (!globalThis.CSS?.escape) Object.assign(globalThis, { CSS: { escape: (value: string) => value } });
  });
  beforeEach(() => {
    forgetContentRegion();
    document.body.innerHTML = `<main><h1>Title</h1><p>${"Some article text to read. ".repeat(20)}<a href="#">a link</a></p><pre>code stays</pre></main>`;
  });
  afterEach(() => { document.body.innerHTML = ""; });

  it("colours the article text in a readable shade, leaves links and code alone, and undoes cleanly", () => {
    const styles = layer();
    const prefs = AppearancePrefsSchema.parse({ textColor: "red" });
    const result = applyPlan({ styleLayer: styles, applyToWholePage: false }, appearancePlanSteps(prefs));
    const css = styles.rules.get("textColor") ?? "";
    expect(css).toContain(TEXT_SHADES.red.onLight);
    const marked = (selector: string) => document.querySelector(selector)!.hasAttribute("data-awl-text-color");
    expect(marked("h1")).toBe(true);
    expect(marked("p")).toBe(true);
    expect(marked("a")).toBe(false);
    expect(marked("pre")).toBe(false);
    result.revert();
    expect(styles.rules.has("textColor")).toBe(false);
    expect(marked("p")).toBe(false);
  });

  it("colours every link (and the text inside it) only, in a readable shade, and undoes cleanly", () => {
    document.body.innerHTML = `<nav><a id="menu" href="#">Menu link</a></nav><main><p>${"Some article text to read. ".repeat(20)}<a id="plain" href="#">a link</a> and <a id="nested" href="#"><span id="inner">a nested link</span></a></p><pre><a href="#" id="code">code link</a></pre></main>`;
    const styles = layer();
    const result = applyPlan({ styleLayer: styles, applyToWholePage: false }, appearancePlanSteps(AppearancePrefsSchema.parse({ linkColor: "red", underlineLinks: true })));
    expect(styles.rules.get("linkColor")).toContain(TEXT_SHADES.red.onLight);
    expect(styles.rules.get("underlineLinks")).toContain("underline");
    const marked = (id: string) => document.getElementById(id)?.hasAttribute("data-awl-link-color") ?? false;
    expect(marked("plain")).toBe(true);
    expect(marked("menu")).toBe(true);
    expect(marked("inner")).toBe(true);
    expect(marked("code")).toBe(false);
    expect(document.querySelector("p")!.hasAttribute("data-awl-link-color")).toBe(false);
    result.revert();
    expect(styles.rules.has("linkColor")).toBe(false);
    expect(document.querySelector("[data-awl-link-color]")).toBeNull();
  });

  it("does nothing with the site's colours", () => {
    const styles = layer();
    applyPlan({ styleLayer: styles, applyToWholePage: false }, appearancePlanSteps(AppearancePrefsSchema.parse({})));
    expect(styles.rules.has("textColor")).toBe(false);
    expect(document.querySelector("[data-awl-text-color]")).toBeNull();
  });
});
