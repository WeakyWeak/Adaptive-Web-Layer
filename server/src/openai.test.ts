// Run: npm test --workspace=server (node --test, no network: fetch is faked).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAnalyzeRequest } from "./index.ts";
import { analyzeWithOpenAiCompat } from "./providers/openai.ts";
import { UpstreamError, type AnalyzeRequest } from "./providers/types.ts";

const cfg = { baseUrl: "https://example.test/v1", apiKey: "k", model: "env-model" };
const input: AnalyzeRequest = { backend: "openai", model: "gpt-compatible", systemPrompt: "s", userPrompt: "u", schema: { type: "object" }, maxTokens: 100, images: [{ mimeType: "image/png", data: "AAAA" }] };

function fake(...replies: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const next = replies.shift()!;
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("OpenAI-compatible backend", () => {
  it("sends a JSON schema and images, and uses the .env model for the placeholder id", async () => {
    const { impl, calls } = fake({ status: 200, body: { choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }] } });
    const result = await analyzeWithOpenAiCompat(input, cfg, impl);
    assert.deepEqual(result, { data: { ok: true }, modelId: "env-model" });
    assert.equal(calls[0].url, "https://example.test/v1/chat/completions");
    assert.equal((calls[0].body.response_format as { type: string }).type, "json_schema");
    const user = (calls[0].body.messages as Array<{ content: unknown }>)[1].content as Array<{ type: string }>;
    assert.deepEqual(user.map((part) => part.type), ["text", "image_url"]);
  });

  it("falls back to plain JSON mode once when the schema is refused", async () => {
    const { impl, calls } = fake({ status: 400, body: { error: { message: "response_format not supported" } } }, { status: 200, body: { choices: [{ message: { content: "{\"ok\":1}" } }] } });
    await analyzeWithOpenAiCompat({ ...input, model: "org/model:free" }, cfg, impl);
    assert.equal((calls[1].body.response_format as { type: string }).type, "json_object");
    assert.equal(calls[1].body.model, "org/model:free");
  });

  it("reports missing configuration, auth failures and truncated replies", async () => {
    await assert.rejects(analyzeWithOpenAiCompat(input, { ...cfg, apiKey: "" }), (error: UpstreamError) => error.code === "not_configured");
    await assert.rejects(analyzeWithOpenAiCompat(input, cfg, fake({ status: 401, body: {} }).impl), (error: UpstreamError) => error.code === "upstream_auth");
    await assert.rejects(analyzeWithOpenAiCompat(input, cfg, fake({ status: 200, body: { choices: [{ message: { content: "{" }, finish_reason: "length" }] } }).impl), (error: UpstreamError) => error.code === "malformed_upstream_json");
  });

  it("accepts the openai backend and vendor-prefixed model ids in requests", () => {
    assert.equal(parseAnalyzeRequest({ backend: "openai", model: "org/model:free", systemPrompt: "s", userPrompt: "u" })?.backend, "openai");
    assert.equal(parseAnalyzeRequest({ backend: "openai", model: "bad model", systemPrompt: "s", userPrompt: "u" }), null);
  });
});
