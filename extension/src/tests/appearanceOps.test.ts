import { beforeAll, describe, expect, it } from "vitest";
import { applyPlan, getOperation } from "../shared/registry";
import { appearancePlanSteps, registerAppearanceOps } from "../content/appearanceOps";
import { AppearancePrefsSchema } from "../shared/settings";
import { mapSmartColors } from "../content/smartPalette";
import type { StyleLayer } from "../shared/registry";

function makeLayer(): StyleLayer & { rules: Map<string, string> } {
  const rules = new Map<string, string>();
  return {
    rules,
    set(id, css) { rules.set(id, css); },
    get(id) { return rules.get(id); },
    remove(id) { rules.delete(id); },
    clear() { rules.clear(); },
  };
}

describe("appearance operations", () => {
  beforeAll(() => registerAppearanceOps());

  it("registers bounded appearance operations through the registry", () => {
    expect(getOperation("theme")).toBeDefined();
    expect(getOperation("contrast")?.paramsSchema.safeParse({ value: 3 }).success).toBe(false);
    expect(getOperation("brightness")?.paramsSchema.safeParse({ value: 0.4 }).success).toBe(false);
    expect(getOperation("saturation")?.paramsSchema.safeParse({ value: 2.1 }).success).toBe(false);
  });

  it("composes root filters and reinverts protected media and code", () => {
    const layer = makeLayer();
    const result = applyPlan({ styleLayer: layer, applyToWholePage: false }, [
      { opId: "theme", params: { value: "dark", contrast: 1.2, brightness: 0.9, saturation: 0 } },
      { opId: "contrast", params: { value: 1.2 } },
      { opId: "brightness", params: { value: 0.9 } },
      { opId: "saturation", params: { value: 0 } },
      { opId: "appearanceFilter", params: { theme: "dark", engine: "fast", skip: false, contrast: 1.2, brightness: 0.9, saturation: 0 } },
    ]);
    expect(result.errors).toEqual([]);
    expect(layer.rules.get("theme")).toContain("img, video, canvas, svg, iframe, pre, code:not(pre code)");
    expect(layer.rules.get("theme")).toContain("input, textarea, select, button");
    expect(layer.rules.get("appearanceFilter")).toContain("filter: invert(1) hue-rotate(180deg) contrast(var(--awl-contrast, 1))");
    expect(layer.rules.get("appearanceFilter")).toContain("brightness(var(--awl-brightness, 1))");
    expect(layer.rules.get("appearanceFilter")).toContain("saturate(var(--awl-saturation, 1))");
    expect(layer.rules.get("contrast")).toContain("--awl-contrast: 1.2 !important");
    expect(layer.rules.get("brightness")).toContain("--awl-brightness: 0.9 !important");
    expect(layer.rules.get("saturation")).toContain("--awl-saturation: 0 !important");
    result.revert();
    expect(layer.rules.size).toBe(0);
  });

  it.each(["light", "sepia"] as const)("keeps adjustments active in %s mode", (theme) => {
    const layer = makeLayer();
    const result = applyPlan({ styleLayer: layer, applyToWholePage: false }, [
      { opId: "theme", params: { value: theme, contrast: 1.8, brightness: 0.6, saturation: 0 } },
      { opId: "contrast", params: { value: 1.8 } },
      { opId: "brightness", params: { value: 0.6 } },
      { opId: "saturation", params: { value: 0 } },
        { opId: "appearanceFilter", params: { theme, engine: "fast", skip: false, contrast: 1.8, brightness: 0.6, saturation: 0 } },
    ]);
    expect(result.errors).toEqual([]);
    expect(layer.rules.get("theme")).not.toContain("--awl-theme-filter");
    expect(layer.rules.get("appearanceFilter")).toContain("filter: contrast(var(--awl-contrast, 1)) brightness(var(--awl-brightness, 1)) saturate(var(--awl-saturation, 1))");
    expect(layer.rules.get("appearanceFilter")).not.toContain("none contrast");
    expect(layer.rules.get("contrast")).toContain("--awl-contrast: 1.8 !important");
    expect(layer.rules.get("brightness")).toContain("--awl-brightness: 0.6 !important");
    expect(layer.rules.get("saturation")).toContain("--awl-saturation: 0 !important");
    result.revert();
    expect(layer.rules.size).toBe(0);
  });

  it("uses Smart palette recoloring without root inversion", () => {
    const layer = makeLayer();
    const result = applyPlan({ styleLayer: layer, applyToWholePage: false }, [
      { opId: "theme", params: { value: "light", engine: "smart" } },
    ]);
    expect(result.errors).toEqual([]);
    expect(layer.rules.get("theme")).toContain("color-scheme: light !important");
    expect(layer.rules.get("theme")).not.toContain("invert(1)");
    expect(layer.rules.get("theme")).not.toContain("contrast(var(--awl-contrast");
    expect(mapSmartColors("rgb(23, 25, 31)", "rgb(230, 232, 237)", "light")).toEqual({ backgroundColor: "#ffffff", color: "#202124" });
    expect(mapSmartColors("rgb(255, 255, 255)", "rgb(26, 26, 26)", "dark")).toEqual({ backgroundColor: "#202124", color: "#e8eaed" });
    result.revert();
    expect(layer.rules.size).toBe(0);
  });

  it("rebuilds the Smart palette once the document body becomes available", () => {
    const prefs = AppearancePrefsSchema.parse({ theme: "light", engine: "smart" });
    const beforeBody = appearancePlanSteps(prefs, prefs.theme, false, false)[0];
    const afterBody = appearancePlanSteps(prefs, prefs.theme, false, true)[0];
    expect(beforeBody).toEqual({ opId: "theme", params: { value: "light", engine: "smart", skip: false, bodyReady: false } });
    expect(afterBody).toEqual({ opId: "theme", params: { value: "light", engine: "smart", skip: false, bodyReady: true } });
  });

  it("restores the prior operation rule exactly", () => {
    const layer = makeLayer();
    layer.set("theme", "existing-rule");
    const result = applyPlan({ styleLayer: layer, applyToWholePage: false }, [{ opId: "theme", params: { value: "dark" } }]);
    result.revert();
    expect(layer.get("theme")).toBe("existing-rule");
  });
});
