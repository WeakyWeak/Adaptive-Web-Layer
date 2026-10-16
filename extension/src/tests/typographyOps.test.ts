import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerTypographyOps } from "../content/typographyOps";
import { getOperation, listOperations, type ApplyContext, type StyleLayer } from "../shared/registry";
import { PROTECTED_ELEMENTS } from "../content/domUtils";

function makeLayer(): StyleLayer & { rules: Map<string, string> } {
  const rules = new Map<string, string>();
  return {
    rules,
    set: (id, css) => { rules.set(id, css); },
    get: (id) => rules.get(id),
    remove: (id) => { rules.delete(id); },
    clear: () => { rules.clear(); },
  };
}

describe("typography operations", () => {
  beforeAll(() => registerTypographyOps());

  it("registers each operation with its target and protected set", () => {
    const operations = listOperations().filter((op) => [
      "fontFamily", "fontSize", "lineHeight", "letterSpacing", "wordSpacing",
      "paragraphSpacing", "maxContentWidth",
    ].includes(op.id));

    expect(operations).toHaveLength(7);
    expect(operations.find((op) => op.id === "maxContentWidth")?.target).toBe("content-region");
    for (const op of operations) expect(op.protectedElements).toEqual(PROTECTED_ELEMENTS);
  });

  it("uses a safe font allowlist and excludes protected descendants", () => {
    vi.stubGlobal("document", { querySelector: vi.fn(() => ({})), querySelectorAll: vi.fn(() => []) });
    const layer = makeLayer();
    const context: ApplyContext = { styleLayer: layer, applyToWholePage: false };
    const fontFamily = getOperation("fontFamily");
    expect(fontFamily).toBeDefined();
    if (!fontFamily) return;

    const rejected = fontFamily.paramsSchema.safeParse({ value: '"; color:red;/*' });
    expect(rejected.success).toBe(false);
    const accepted = fontFamily.apply(context, { value: "Lexend" });
    expect(accepted.ok).toBe(true);
    const css = layer.rules.get("fontFamily");
    expect(css).toContain(":not(pre *)");
    expect(css).toContain(":not([data-awl-preserve] *)");
  });

  it("neutral defaults remove overrides and can be reverted", () => {
    const layer = makeLayer();
    const context: ApplyContext = { styleLayer: layer, applyToWholePage: false };
    layer.set("fontSize", "main p { font-size: 22px !important; }");
    const fontSize = getOperation("fontSize");
    expect(fontSize).toBeDefined();
    if (!fontSize) return;

    const result = fontSize.apply(context, { value: 16 });
    expect(layer.get("fontSize")).toBeUndefined();
    if (result.ok) result.revert();
    expect(layer.get("fontSize")).toContain("22px");
  });
});
