import { afterEach, describe, expect, it } from "vitest";
import { applyAppearance, revertAppearance } from "../content/applier";
import { registerAppearanceOps } from "../content/appearanceOps";
import { AppearancePrefsSchema } from "../shared/settings";
import type { StyleLayer } from "../shared/registry";

function makeLayer(): StyleLayer & { rules: Map<string, string>; writes: Map<string, number> } {
  const rules = new Map<string, string>();
  const writes = new Map<string, number>();
  return {
    rules,
    writes,
    set(id, css) {
      rules.set(id, css);
      writes.set(id, (writes.get(id) ?? 0) + 1);
    },
    get(id) { return rules.get(id); },
    remove(id) { rules.delete(id); },
    clear() { rules.clear(); },
  };
}

describe("appearance plan updates", () => {
  afterEach(() => revertAppearance());

  it("keeps an unchanged Smart theme mounted while sliders update independently", () => {
    registerAppearanceOps();
    const layer = makeLayer();
    const ctx = { styleLayer: layer, applyToWholePage: false };
    const base = AppearancePrefsSchema.parse({ theme: "light", engine: "smart" });
    applyAppearance(ctx, base);
    const themeRule = layer.get("theme");
    applyAppearance(ctx, base);

    const adjusted = AppearancePrefsSchema.parse({ ...base, contrast: 1.4 });
    applyAppearance(ctx, adjusted);

    expect(layer.writes.get("theme")).toBe(1);
    expect(layer.get("theme")).toBe(themeRule);
    expect(layer.get("appearanceFilter")).toContain("contrast(var(--awl-contrast, 1))");
    expect(layer.get("contrast")).toContain("--awl-contrast: 1.4 !important");
  });
});
