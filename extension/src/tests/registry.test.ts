import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  registerOperation,
  getOperation,
  applyStep,
  applyPlan,
  type Operation,
  type ApplyContext,
  type StyleLayer,
} from "../shared/registry";

// ─── Mock StyleLayer ──────────────────────────────────────────────────────────
function makeMockStyleLayer(): StyleLayer & { rules: Map<string, string> } {
  const rules = new Map<string, string>();
  return {
    rules,
    set(opId: string, css: string) { rules.set(opId, css); },
    get(opId: string) { return rules.get(opId); },
    remove(opId: string) { rules.delete(opId); },
    clear() { rules.clear(); },
  };
}

function makeMockCtx(layer: StyleLayer): ApplyContext {
  return { styleLayer: layer, applyToWholePage: false };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Create a test-unique op to avoid duplicate registration errors
let opCounter = 0;
function makeTestOp(id?: string): Operation<{ value: number }> {
  return {
    id: id ?? `test-op-${opCounter++}`,
    label: "Test op",
    target: "prose",
    protectedElements: ["pre", "code"],
    paramsSchema: z.object({ value: z.number().min(0).max(100) }),
    validate(params) {
      return params.value > 100 ? "value too high" : null;
    },
    apply(ctx, params) {
      const previous = ctx.styleLayer.get(this.id);
      ctx.styleLayer.set(this.id, `body { opacity: ${params.value / 100}; }`);
      const opId = this.id;
      return {
        ok: true,
        revert: () => {
          if (previous === undefined) ctx.styleLayer.remove(opId);
          else ctx.styleLayer.set(opId, previous);
        },
      };
    },
  };
}

describe("Operation registry", () => {
  it("registers and retrieves an operation", () => {
    const op = makeTestOp();
    registerOperation(op);
    expect(getOperation(op.id)).toBe(op);
  });

  it("does not overwrite on duplicate registration", () => {
    const id = `dedup-op-${opCounter++}`;
    const op1 = { ...makeTestOp(id) };
    const op2 = { ...makeTestOp(id), label: "Op 2" };
    registerOperation(op1);
    registerOperation(op2); // should warn, not overwrite
    expect(getOperation(id)?.label).toBe(op1.label);
  });
});

describe("applyStep", () => {
  it("applies valid step and injects CSS", () => {
    const op = makeTestOp();
    registerOperation(op);
    const layer = makeMockStyleLayer();
    const ctx = makeMockCtx(layer);
    const result = applyStep(ctx, { opId: op.id, params: { value: 50 } });
    expect(result.ok).toBe(true);
    expect(layer.rules.has(op.id)).toBe(true);
  });

  it("revert removes the CSS rule", () => {
    const op = makeTestOp();
    registerOperation(op);
    const layer = makeMockStyleLayer();
    const ctx = makeMockCtx(layer);
    const result = applyStep(ctx, { opId: op.id, params: { value: 50 } });
    expect(result.ok).toBe(true);
    if (result.ok) result.revert();
    expect(layer.rules.has(op.id)).toBe(false);
  });

  it("returns error for unknown operation", () => {
    const layer = makeMockStyleLayer();
    const ctx = makeMockCtx(layer);
    const result = applyStep(ctx, { opId: "nonexistent-op", params: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Unknown operation/);
  });

  it("returns error for out-of-range params (Zod bounds)", () => {
    const op = makeTestOp();
    registerOperation(op);
    const layer = makeMockStyleLayer();
    const ctx = makeMockCtx(layer);
    // value: 200 exceeds z.number().max(100)
    const result = applyStep(ctx, { opId: op.id, params: { value: 200 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Invalid params/);
  });

  it("is idempotent: applying twice overwrites, not duplicates", () => {
    const op = makeTestOp();
    registerOperation(op);
    const layer = makeMockStyleLayer();
    const ctx = makeMockCtx(layer);
    applyStep(ctx, { opId: op.id, params: { value: 30 } });
    applyStep(ctx, { opId: op.id, params: { value: 70 } });
    // Should still be just one entry
    expect(layer.rules.size).toBe(1);
    expect(layer.rules.get(op.id)).toContain("0.7");
  });

  it("revert restores the previous rule when an operation is replaced", () => {
    const op = makeTestOp();
    registerOperation(op);
    const layer = makeMockStyleLayer();
    const ctx = makeMockCtx(layer);
    const first = applyStep(ctx, { opId: op.id, params: { value: 30 } });
    const second = applyStep(ctx, { opId: op.id, params: { value: 70 } });

    if (second.ok) second.revert();
    expect(layer.rules.get(op.id)).toContain("0.3");
    if (first.ok) first.revert();
    expect(layer.rules.has(op.id)).toBe(false);
  });

  it("converts an operation exception to a typed apply error", () => {
    const op = {
      ...makeTestOp(),
      apply() { throw new Error("style layer unavailable"); },
    } satisfies Operation<{ value: number }>;
    registerOperation(op);
    const result = applyStep(makeMockCtx(makeMockStyleLayer()), {
      opId: op.id,
      params: { value: 1 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Apply failed");
  });
});

describe("applyPlan", () => {
  it("applies multiple steps and combined revert undoes all", () => {
    const op1 = makeTestOp();
    const op2 = makeTestOp();
    registerOperation(op1);
    registerOperation(op2);
    const layer = makeMockStyleLayer();
    const ctx = makeMockCtx(layer);

    const result = applyPlan(ctx, [
      { opId: op1.id, params: { value: 10 } },
      { opId: op2.id, params: { value: 20 } },
    ]);
    expect(result.ok).toBe(true);
    expect(layer.rules.size).toBe(2);

    result.revert();
    expect(layer.rules.size).toBe(0);
  });

  it("continues applying when one step fails (partial plan)", () => {
    const goodOp = makeTestOp();
    registerOperation(goodOp);
    const layer = makeMockStyleLayer();
    const ctx = makeMockCtx(layer);

    const result = applyPlan(ctx, [
      { opId: "totally-nonexistent", params: {} },
      { opId: goodOp.id, params: { value: 42 } },
    ]);
    // Should still be ok=true (partial success)
    expect(result.ok).toBe(true);
    expect(result.errors.length).toBe(1);
    expect(layer.rules.has(goodOp.id)).toBe(true);
  });

  it("revert is applied in reverse order", () => {
    const order: string[] = [];
    const opA = {
      ...makeTestOp(),
      apply(ctx: ApplyContext, _params: { value: number }) {
        ctx.styleLayer.set("opA", "a{}");
        return {
          ok: true as const,
          revert: () => {
            order.push("revertA");
            ctx.styleLayer.remove("opA");
          },
        };
      },
    };
    const opB = {
      ...makeTestOp(),
      apply(ctx: ApplyContext, _params: { value: number }) {
        ctx.styleLayer.set("opB", "b{}");
        return {
          ok: true as const,
          revert: () => {
            order.push("revertB");
            ctx.styleLayer.remove("opB");
          },
        };
      },
    };
    registerOperation(opA);
    registerOperation(opB);

    const layer = makeMockStyleLayer();
    const ctx = makeMockCtx(layer);
    const result = applyPlan(ctx, [
      { opId: opA.id, params: { value: 1 } },
      { opId: opB.id, params: { value: 2 } },
    ]);
    result.revert();
    expect(order).toEqual(["revertB", "revertA"]);
  });
});
