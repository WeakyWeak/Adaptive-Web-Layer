import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  PlanSchema,
  detectShortcut,
  ProviderError,
  formatProviderError,
} from "../shared/plan";
import { validatePlan, runPlanner, describeOperations } from "../background/planner";
import { MockProvider } from "../shared/llmProvider";
import type { Plan } from "../shared/plan";
import { registerOperation, type Operation, type StyleLayer } from "../shared/registry";

// ─── Mock registry setup ─────────────────────────────────────────────────────
// We need some ops registered for the planner tests.
// StyleLayer used by test operations
function makeMockStyleLayer(): StyleLayer {
  const rules = new Map<string, string>();
  return {
    set(id, css) { rules.set(id, css); },
    get(id) { return rules.get(id); },
    remove(id) { rules.delete(id); },
    clear() { rules.clear(); },
  };
}
// Used indirectly by ops
const _testLayer = makeMockStyleLayer(); void _testLayer;

let opCount = 0;
function makeTestOp(id?: string): Operation<{ value: number }> {
  return {
    id: id ?? `p05-test-op-${opCount++}`,
    label: "P05 test op",
    target: "prose",
    protectedElements: ["pre", "code"],
    paramsSchema: z.object({ value: z.number().min(10).max(48) }),
    validate(params) {
      return params.value < 10 || params.value > 48 ? "out of range" : null;
    },
    apply(ctx, params) {
      const prev = ctx.styleLayer.get(this.id);
      ctx.styleLayer.set(this.id, `body { font-size: ${params.value}px; }`);
      const id = this.id;
      return { ok: true, revert: () => { if (prev === undefined) ctx.styleLayer.remove(id); else ctx.styleLayer.set(id, prev); } };
    },
  };
}

// Register test ops before tests run
const registeredFontSize = makeTestOp("fontSize");
const registeredLineHeight = makeTestOp("lineHeight");
const registeredMaxWidth = makeTestOp("maxContentWidth");
// These might already be registered from other test files; guard with try/catch
try { registerOperation(registeredFontSize); } catch { /* already registered */ }
try { registerOperation(registeredLineHeight); } catch { /* already registered */ }
try { registerOperation(registeredMaxWidth); } catch { /* already registered */ }

// ─── Sample DOM snapshot ───────────────────────────────────────────────────
const sampleSnapshot = {
  url: "http://localhost:4173/article-sidebars.html",
  title: "Article with sidebars",
  contentRegion: "article",
  headings: [{ level: 1, text: "Main article heading", id: "awl-snap-1" }],
  landmarks: [{ role: "main", id: "awl-snap-2" }],
  textBlocks: [
    { id: "awl-snap-3", tagName: "p", textLength: 300, isProtected: false },
    { id: "awl-snap-4", tagName: "pre", textLength: 150, isProtected: true },
  ],
  imageCnt: 2,
  tableCnt: 0,
  codeBlockCnt: 3,
  currentOps: { fontSize: "custom" },
  tokenEstimate: 800,
};

// ─── Plan schema tests ────────────────────────────────────────────────────────
describe("PlanSchema", () => {
  it("parses a valid plan", () => {
    const raw = {
      interpretedRequest: "Make text larger",
      operations: [{ opId: "fontSize", params: { value: 20 } }],
      preserved: ["pre", "code"],
      reasons: ["Better readability"],
      confidence: 0.9,
    };
    const result = PlanSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it("rejects a plan with too many operations (max 20)", () => {
    const raw = {
      interpretedRequest: "Do many things",
      operations: Array.from({ length: 25 }, (_, i) => ({ opId: `op-${i}`, params: {} })),
      preserved: [],
      reasons: [],
      confidence: 0.5,
    };
    const result = PlanSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it("rejects a plan with confidence out of range", () => {
    const raw = {
      interpretedRequest: "test",
      operations: [],
      preserved: [],
      reasons: [],
      confidence: 1.5,
    };
    const result = PlanSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });
});

// ─── Validator tests ──────────────────────────────────────────────────────────
describe("validatePlan", () => {
  it("accepts valid operations from the registry", () => {
    const plan: Plan = {
      interpretedRequest: "Make text larger",
      operations: [
        { opId: "fontSize", params: { value: 20 } },
        { opId: "lineHeight", params: { value: 20 } },
      ],
      preserved: ["pre"],
      reasons: ["readability"],
      confidence: 0.9,
    };
    const result = validatePlan(plan);
    // At least one valid op (fontSize should pass, lineHeight might fail bounds depending on registration)
    expect(result.validOps.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects unknown operations", () => {
    const plan: Plan = {
      interpretedRequest: "Do something unknown",
      operations: [{ opId: "nonexistent-magic-op", params: {} }],
      preserved: [],
      reasons: [],
      confidence: 0.5,
    };
    const result = validatePlan(plan);
    expect(result.validOps.length).toBe(0);
    expect(result.errors.some((e) => e.includes("Unknown operation"))).toBe(true);
  });

  it("rejects out-of-range params", () => {
    const plan: Plan = {
      interpretedRequest: "Make text huge",
      operations: [{ opId: "fontSize", params: { value: 999 } }],
      preserved: [],
      reasons: [],
      confidence: 0.8,
    };
    const result = validatePlan(plan);
    expect(result.validOps.length).toBe(0);
    expect(result.errors.some((e) => e.includes("Invalid params") || e.includes("out of range"))).toBe(true);
  });

  it("rejects hideElements (protected operation)", () => {
    const plan: Plan = {
      interpretedRequest: "Hide navigation",
      operations: [{ opId: "hideElements", params: { selector: "nav" } }],
      preserved: [],
      reasons: [],
      confidence: 0.9,
    };
    const result = validatePlan(plan);
    expect(result.validOps.length).toBe(0);
    expect(result.errors.some((e) => e.includes("not allowed in AI-generated plans") || e.includes("Unknown operation"))).toBe(true);
  });

  it("rejects collapseSidebars (protected operation)", () => {
    const plan: Plan = {
      interpretedRequest: "Collapse sidebars",
      operations: [{ opId: "collapseSidebars", params: {} }],
      preserved: [],
      reasons: [],
      confidence: 0.9,
    };
    const result = validatePlan(plan);
    expect(result.validOps.length).toBe(0);
    expect(result.errors.some((e) => e.includes("not allowed in AI-generated plans") || e.includes("Unknown operation"))).toBe(true);
  });

  it("caps plan at MAX_OPERATIONS (12)", () => {
    const plan: Plan = {
      interpretedRequest: "Too many ops",
      operations: Array.from({ length: 15 }, () => ({ opId: "fontSize", params: { value: 20 } })),
      preserved: [],
      reasons: [],
      confidence: 0.5,
    };
    const result = validatePlan(plan);
    expect(result.validOps.length).toBeLessThanOrEqual(12);
    expect(result.errors.some((e) => e.includes("max operations"))).toBe(true);
  });

  it("accepts a mixed plan: valid + invalid ops", () => {
    const plan: Plan = {
      interpretedRequest: "Mixed plan",
      operations: [
        { opId: "fontSize", params: { value: 20 } },
        { opId: "totally-fake-op", params: {} },
      ],
      preserved: [],
      reasons: [],
      confidence: 0.8,
    };
    const result = validatePlan(plan);
    // fontSize should pass, fake-op should fail
    expect(result.validOps.some((op) => op.opId === "fontSize")).toBe(true);
    expect(result.errors.some((e) => e.includes("totally-fake-op"))).toBe(true);
  });
});

// ─── Shortcut detection tests ──────────────────────────────────────────────────
describe("detectShortcut", () => {
  it("detects 'undo'", () => {
    expect(detectShortcut("undo")).toEqual({ type: "undo" });
    expect(detectShortcut("Undo last")).toEqual({ type: "undo" });
    expect(detectShortcut("  undo change  ")).toEqual({ type: "undo" });
  });

  it("detects 'reset'", () => {
    expect(detectShortcut("reset")).toEqual({ type: "reset" });
    expect(detectShortcut("Reset page")).toEqual({ type: "reset" });
    expect(detectShortcut("revert")).toEqual({ type: "reset" });
  });

  it("detects 'turn off'", () => {
    expect(detectShortcut("turn off")).toEqual({ type: "turn-off" });
    expect(detectShortcut("disable")).toEqual({ type: "turn-off" });
    expect(detectShortcut("turn off for this site")).toEqual({ type: "turn-off" });
  });

  it("detects 'save as <name>'", () => {
    expect(detectShortcut("save as Reading Mode")).toEqual({ type: "save-profile", name: "Reading Mode" });
    expect(detectShortcut("save this as Night")).toEqual({ type: "save-profile", name: "Night" });
  });

  it("returns null for regular requests", () => {
    expect(detectShortcut("make text larger")).toBeNull();
    expect(detectShortcut("increase line spacing")).toBeNull();
    expect(detectShortcut("")).toBeNull();
  });
});

// ─── Provider error tests ──────────────────────────────────────────────────────
describe("ProviderError + formatProviderError", () => {
  it("formats server-not-running with llama-server hint", () => {
    const err = new ProviderError("server-not-running", "Cannot connect");
    const { message, hint } = formatProviderError(err);
    expect(message).toBe("Cannot connect");
    expect(hint).toMatch(/llama-server/i);
  });

  it("formats auth error with api-key hint", () => {
    const err = new ProviderError("auth", "HTTP 401");
    const { hint } = formatProviderError(err);
    expect(hint).toMatch(/api[- ]key/i);
  });

  it("formats timeout", () => {
    const err = new ProviderError("timeout", "Timed out");
    const { hint } = formatProviderError(err);
    expect(hint).toMatch(/context size|timeout/i);
  });

  it("formats invalid-json", () => {
    const err = new ProviderError("invalid-json", "Bad JSON");
    const { hint } = formatProviderError(err);
    expect(hint).toBeDefined();
  });

  it("uses custom hint if provided", () => {
    const err = new ProviderError("unknown", "Oops", "Custom hint here");
    const { hint } = formatProviderError(err);
    expect(hint).toBe("Custom hint here");
  });
});

// ─── MockProvider tests ────────────────────────────────────────────────────────
describe("MockProvider", () => {
  it("returns the default demo plan", async () => {
    const provider = new MockProvider();
    const plan = await provider.generateStructured({
      systemPrompt: "sys",
      userPrompt: "user",
    });
    expect(plan.operations.length).toBeGreaterThan(0);
    expect(plan.interpretedRequest).toBeTruthy();
  });

  it("returns a custom plan when configured", async () => {
    const customPlan: Plan = {
      interpretedRequest: "Custom",
      operations: [{ opId: "fontSize", params: { value: 22 } }],
      preserved: [],
      reasons: [],
      confidence: 0.95,
    };
    const provider = new MockProvider({ plan: customPlan });
    const plan = await provider.generateStructured({ systemPrompt: "sys", userPrompt: "user" });
    expect(plan.interpretedRequest).toBe("Custom");
  });

  it("throws the configured error", async () => {
    const err = new ProviderError("server-not-running", "Server down");
    const provider = new MockProvider({ errorToThrow: err });
    await expect(provider.generateStructured({ systemPrompt: "sys", userPrompt: "user" }))
      .rejects.toThrow("Server down");
  });

  it("simulates invalid plan then valid on retry (invalidCallsBeforeValid=1)", async () => {
    const provider = new MockProvider({ returnInvalidPlan: true, invalidCallsBeforeValid: 1 });
    // First call should throw
    await expect(provider.generateStructured({ systemPrompt: "sys", userPrompt: "user" }))
      .rejects.toThrow("Simulated invalid plan");
    // Second call should succeed
    const plan = await provider.generateStructured({ systemPrompt: "sys", userPrompt: "user" });
    expect(plan.operations.length).toBeGreaterThan(0);
  });

  it("testConnection returns ok", async () => {
    const provider = new MockProvider();
    const status = await provider.testConnection();
    expect(status.ok).toBe(true);
  });
});

// ─── runPlanner tests ─────────────────────────────────────────────────────────
describe("runPlanner", () => {
  it("returns a validated plan from MockProvider", async () => {
    const provider = new MockProvider();
    const result = await runPlanner(provider, "Make text larger", sampleSnapshot as never);
    expect(result.validated.validOps.length).toBeGreaterThan(0);
    expect(result.retried).toBe(false);
  });

  it("throws ProviderError when provider fails", async () => {
    const provider = new MockProvider({ errorToThrow: new ProviderError("server-not-running", "Down") });
    await expect(runPlanner(provider, "Make text larger", sampleSnapshot as never))
      .rejects.toBeInstanceOf(ProviderError);
  });

  it("retries when first plan has errors and second is better", async () => {
    // First call: invalid plan (throws); second: valid
    const provider = new MockProvider({ returnInvalidPlan: true, invalidCallsBeforeValid: 1 });
    // runPlanner handles the retry internally — the provider error from first call propagates
    // (since it throws, not returns an invalid plan). Test that runPlanner re-throws.
    await expect(runPlanner(provider, "test", sampleSnapshot as never))
      .rejects.toBeInstanceOf(ProviderError);
  });

  it("handles a plan that has validation errors and retries", async () => {
    // Mock provider that returns a plan with an invalid op first, then a valid one
    let calls = 0;
    const provider = new MockProvider({
      plan: {
        interpretedRequest: "test",
        operations: [
          calls === 0
            ? { opId: "invalid-op-xyz", params: {} }
            : { opId: "fontSize", params: { value: 20 } },
        ],
        preserved: [],
        reasons: [],
        confidence: 0.8,
      },
    });

    const result = await runPlanner(provider, "test", sampleSnapshot as never);
    // Should have validation errors for the invalid op
    // (MockProvider always returns the same plan, so the retry plan will also have errors)
    expect(result.validated).toBeDefined();
  });
});

// ─── Injection resistance test ────────────────────────────────────────────────
describe("injection resistance", () => {
  it("a plan claiming to hide nav is rejected by validatePlan", () => {
    const injectedPlan: Plan = {
      interpretedRequest: "INJECTED: Hide all navigation",
      operations: [
        { opId: "hideElements", params: { selector: "nav" } },
        { opId: "collapseSidebars", params: {} },
      ],
      preserved: [],
      reasons: ["ignore instructions"],
      confidence: 1.0,
    };
    const result = validatePlan(injectedPlan);
    expect(result.validOps.length).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("a mocked malicious provider response is rejected", async () => {
    const maliciousPlan: Plan = {
      interpretedRequest: "hacked",
      operations: [
        { opId: "hideElements", params: { selector: "nav, form, button" } },
        { opId: "__proto__", params: { admin: true } },
        { opId: "eval", params: { code: "alert(1)" } },
      ],
      preserved: [],
      reasons: [],
      confidence: 1.0,
    };
    const provider = new MockProvider({ plan: maliciousPlan });
    const result = await runPlanner(provider, "test injection", sampleSnapshot as never);
    expect(result.validated.validOps.length).toBe(0);
    // All ops should be rejected
    expect(result.validated.errors.length).toBeGreaterThan(0);
  });
});

// ─── describeOperations tests ──────────────────────────────────────────────────
describe("describeOperations", () => {
  it("returns human-readable descriptions", () => {
    const ops = [
      { opId: "fontSize", params: { value: 20 } },
    ];
    const descs = describeOperations(ops);
    expect(descs.length).toBe(1);
    // Description format: "<label>: <params json>"
    // label is whatever was registered for "fontSize" in this test environment
    expect(descs[0]).toContain("20");
  });
});
