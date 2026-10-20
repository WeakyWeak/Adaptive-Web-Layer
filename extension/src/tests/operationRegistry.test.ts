import { describe, expect, it } from "vitest";
import { registerPlanningOperations } from "../background/operationRegistry";
import { getOperation, listOperations } from "../shared/registry";

describe("background planning operation registry", () => {
  it("registers every operation needed to produce and validate AI plans", () => {
    registerPlanningOperations();

    expect(listOperations().length).toBeGreaterThan(0);
    expect(getOperation("fontSize")).toBeDefined();
    expect(getOperation("lineHeight")).toBeDefined();
    expect(getOperation("maxContentWidth")).toBeDefined();
    expect(getOperation("theme")).toBeDefined();
    expect(getOperation("reduceMotion")).toBeDefined();
  });

  it("is safe to call more than once in a worker lifetime", () => {
    registerPlanningOperations();
    const count = listOperations().length;
    registerPlanningOperations();
    expect(listOperations()).toHaveLength(count);
  });
});
