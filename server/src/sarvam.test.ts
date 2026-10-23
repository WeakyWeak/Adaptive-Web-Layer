// Run: npm test --workspace=server (node --test, no network: fetch is faked).
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { describe, it } from "node:test";
import type { Config } from "./config.ts";
import { handleTranslate } from "./index.ts";
import { parseTranslateRequest, translateWithSarvam } from "./providers/sarvam.ts";
import { UpstreamError } from "./providers/types.ts";

const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const config = (sarvamApiKey: string): Config => ({ geminiApiKey: "", anthropicApiKey: "", anthropicEffort: "low", sarvamApiKey, proxyToken: "t", port: 0, allowedOrigins: [] });

function fakeResponse(): ServerResponse & { status?: number; body?: unknown } {
  const res = {
    writeHead(status: number) { res.status = status; return res; },
    end(body: string) { res.body = JSON.parse(body); return res; },
  } as unknown as ServerResponse & { status?: number; body?: unknown };
  return res;
}

describe("parseTranslateRequest", () => {
  it("accepts 1–2000 characters for a supported language pair only", () => {
    assert.deepEqual(parseTranslateRequest({ text: "Hello", target: "hi-IN" }), { text: "Hello", source: "en-IN", target: "hi-IN" });
    assert.equal(parseTranslateRequest({ text: "x".repeat(2001), target: "hi-IN" }), null);
    assert.equal(parseTranslateRequest({ text: "  ", target: "hi-IN" }), null);
    assert.equal(parseTranslateRequest({ text: "Hello", target: "fr-FR" }), null);
    assert.equal(parseTranslateRequest({ text: "Hello", source: "hi-IN", target: "hi-IN" }), null);
  });
});

describe("translateWithSarvam", () => {
  it("sends the documented request shape and returns the translation", async () => {
    let sent: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => { sent = { url, init }; return new Response(JSON.stringify({ request_id: "r", translated_text: "नमस्ते", source_language_code: "en-IN" }), { status: 200 }); }) as unknown as typeof fetch;
    const result = await translateWithSarvam({ text: "Hello", source: "en-IN", target: "hi-IN" }, "key-123", fetchImpl);
    assert.deepEqual(result, { text: "नमस्ते", modelId: "sarvam-translate:v1" });
    assert.equal(sent?.url, "https://api.sarvam.ai/translate");
    assert.equal((sent?.init.headers as Record<string, string>)["api-subscription-key"], "key-123");
    assert.deepEqual(JSON.parse(String(sent?.init.body)), { input: "Hello", source_language_code: "en-IN", target_language_code: "hi-IN", model: "sarvam-translate:v1" });
  });

  it("maps Sarvam failures without leaking the key", async () => {
    const input = { text: "Hello", source: "en-IN", target: "hi-IN" };
    await assert.rejects(translateWithSarvam(input, "secret-key", reply(403, { error: { message: "Invalid API key" } })), (error: UpstreamError) => error.code === "upstream_auth" && !error.message.includes("secret-key"));
    await assert.rejects(translateWithSarvam(input, "k", reply(429, { error: { message: "quota" } })), (error: UpstreamError) => error.status === 429 && error.code === "rate_limited");
    await assert.rejects(translateWithSarvam(input, "k", reply(200, { translated_text: "" })), (error: UpstreamError) => error.code === "translate_failed");
    await assert.rejects(translateWithSarvam(input, "k", (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch), (error: UpstreamError) => error.code === "upstream_unreachable");
  });
});

describe("POST /v1/translate handler", () => {
  it("rejects bad input, reports a missing key, and returns the translation", async () => {
    let res = fakeResponse();
    await handleTranslate(res, { text: "", target: "hi-IN" }, config("k"));
    assert.equal(res.status, 400);
    res = fakeResponse();
    await handleTranslate(res, { text: "Hello", target: "hi-IN" }, config(""));
    assert.deepEqual([res.status, (res.body as { error: { code: string } }).error.code], [503, "not_configured"]);
    res = fakeResponse();
    await handleTranslate(res, { text: "Hello", target: "hi-IN" }, config("k"), reply(200, { translated_text: "नमस्ते" }));
    assert.deepEqual([res.status, res.body], [200, { text: "नमस्ते", modelId: "sarvam-translate:v1" }]);
  });
});
