import { beforeAll, describe, expect, it } from "vitest";
import { applyPlan, getOperation } from "../shared/registry";
import { registerAppearanceOps } from "../content/appearanceOps";
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
      { opId: "theme", params: { value: "dark" } },
      { opId: "contrast", params: { value: 1.2 } },
      { opId: "brightness", params: { value: 0.9 } },
      { opId: "saturation", params: { value: 0 } },
    ]);
    expect(result.errors).toEqual([]);
    expect(layer.rules.get("theme")).toContain("img, video, canvas, svg, iframe, pre, code:not(pre code)");
    expect(layer.rules.get("theme")).toContain("input, textarea, select, button");
    expect(layer.rules.get("contrast")).toContain("contrast(var(--awl-contrast, 1))");
    expect(layer.rules.get("brightness")).toContain("brightness(var(--awl-brightness, 1))");
    expect(layer.rules.get("saturation")).toContain("saturate(var(--awl-saturation, 1))");
    result.revert();
    expect(layer.rules.size).toBe(0);
  });

  it("restores the prior operation rule exactly", () => {
    const layer = makeLayer();
    layer.set("theme", "existing-rule");
    const result = applyPlan({ styleLayer: layer, applyToWholePage: false }, [{ opId: "theme", params: { value: "dark" } }]);
    result.revert();
    expect(layer.get("theme")).toBe("existing-rule");
  });
});
