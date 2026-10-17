import { beforeAll, describe, expect, it } from "vitest";
import { applyPlan, getOperation, type StyleLayer } from "../shared/registry";
import { focusPlanSteps, isSafeHeuristicCandidate, registerFocusOps } from "../content/focusOps";
import { FocusPrefsSchema, MotionPrefsSchema } from "../shared/settings";

function layer(): StyleLayer & { rules: Map<string, string> } { const rules = new Map<string, string>(); return { rules, set: (id, value) => rules.set(id, value), get: (id) => rules.get(id), remove: (id) => rules.delete(id), clear: () => rules.clear() }; }
describe("focus and motion operations", () => { beforeAll(registerFocusOps);
  it("registers all bounded focus operations", () => { expect(getOperation("hideElements")).toBeDefined(); expect(getOperation("hideElements")?.paramsSchema.safeParse({ selectors: Array(31).fill(".ad") }).success).toBe(false); });
  it("collapses sidebars without selecting navigation or forms", () => { const current = layer(); const result = applyPlan({ styleLayer: current, applyToWholePage: false }, [{ opId: "collapseSidebars", params: { enabled: true } }]); expect(getOperation("collapseSidebars")?.protectedElements).toContain("nav"); expect(current.rules.get("collapseSidebars")).toBeUndefined(); result.revert(); expect(current.rules.size).toBe(0); });
  it("generates reversible hidden-element and motion rules", () => { const current = layer(); const result = applyPlan({ styleLayer: current, applyToWholePage: false }, focusPlanSteps(FocusPrefsSchema.parse({ hiddenSelectors: ["#ad"] }), MotionPrefsSchema.parse({ reduceMotion: true, pauseAutoplay: true }))); expect(current.rules.get("hideElements")).toContain("#ad"); expect(current.rules.get("reduceMotion")).toContain(":focus-visible"); result.revert(); expect(current.rules.size).toBe(0); });
  it("excludes protected heuristic targets", () => { const unsafe = { matches: (selector: string) => selector.includes("form"), querySelector: () => null } as unknown as Element; expect(isSafeHeuristicCandidate(unsafe)).toBe(false); });
});
