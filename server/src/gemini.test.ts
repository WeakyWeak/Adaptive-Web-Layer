// Run: npm test --workspace=server (node --test, no network).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { geminiErrorMessage } from "./providers/gemini.ts";

describe("Gemini error messages", () => {
  it("adds the field Gemini objected to, so a refused request can be diagnosed", () => {
    const payload = { error: { message: "Request contains an invalid argument.", details: [{ fieldViolations: [{ field: "generation_config.response_json_schema", description: "enum too large" }] }] } };
    assert.equal(geminiErrorMessage(payload, 400), "Request contains an invalid argument. (generation_config.response_json_schema: enum too large)");
  });
  it("falls back to the plain message or the status", () => {
    assert.equal(geminiErrorMessage({ error: { message: "Bad" } }, 400), "Bad");
    assert.equal(geminiErrorMessage(null, 500), "Gemini returned HTTP 500.");
  });
});
