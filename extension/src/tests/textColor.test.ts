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

  it("does nothing with the site's colours", () => {
    const styles = layer();
    applyPlan({ styleLayer: styles, applyToWholePage: false }, appearancePlanSteps(AppearancePrefsSchema.parse({})));
    expect(styles.rules.has("textColor")).toBe(false);
    expect(document.querySelector("[data-awl-text-color]")).toBeNull();
  });
});
