import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudProvider, extractJson, LocalOpenAICompatProvider, type ConnectionStatus, type LLMProvider, type StructuredRequest } from "../shared/llmProvider";
import { ProviderRouter } from "../shared/providerRouter";
import { ProviderError } from "../shared/plan";
import { planJsonSchema, schemaForDialect } from "../shared/jsonSchema";
import { defaultSettings, type AiSettings, type CloudConsent } from "../shared/settings";

class StubProvider implements LLMProvider {
  calls = 0;
  constructor(readonly kind: "local" | "cloud", private readonly result: unknown | ProviderError, readonly supportsVision = kind === "cloud") {}
  async generateStructured(): Promise<unknown> {
    this.calls++;
    if (this.result instanceof ProviderError) throw this.result;
    return this.result;
  }
  async testConnection(): Promise<ConnectionStatus> { return { ok: true }; }
}

const request: StructuredRequest = { systemPrompt: "s", userPrompt: "u", schema: planJsonSchema() };
const ai = (patch: Partial<AiSettings> = {}): AiSettings => ({ ...defaultSettings().ai, ...patch });

function router(mode: AiSettings["mode"], consent: CloudConsent, local: StubProvider, cloud: StubProvider) {
  return new ProviderRouter({ settings: ai({ mode }), consent, local, cloud });
}

afterEach(() => vi.unstubAllGlobals());

describe("ProviderRouter policy matrix", () => {
  it("local mode never calls cloud, even when local fails and consent exists", async () => {
    const local = new StubProvider("local", new ProviderError("server-not-running", "down"));
    const cloud = new StubProvider("cloud", { from: "cloud" });
    await expect(router("local", "allow", local, cloud).generateStructured(request)).rejects.toMatchObject({ code: "server-not-running" });
    expect(cloud.calls).toBe(0);
  });

  it("local mode refuses screenshots for a text-only local model instead of using cloud", async () => {
    const cloud = new StubProvider("cloud", {});
    const routed = router("local", "allow", new StubProvider("local", {}), cloud);
    await expect(routed.generateStructured({ ...request, images: [{ mimeType: "image/png", data: "x" }] })).rejects.toMatchObject({ code: "unsupported" });
    expect(cloud.calls).toBe(0);
  });

  it("local mode makes zero network requests to the proxy (network spy)", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (String(url).includes("8787")) throw new Error("proxy must not be contacted");
      return new Response("", { status: 503 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const real = new ProviderRouter({ settings: ai({ mode: "local", localEndpoint: "http://127.0.0.1:8080", cloudProxyUrl: "http://127.0.0.1:8787" }), consent: "allow" });
    await expect(real.generateStructured(request)).rejects.toBeInstanceOf(ProviderError);
    expect(fetchSpy.mock.calls.every(([url]) => !String(url).includes("8787"))).toBe(true);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("cloud mode asks for consent first and calls nothing", async () => {
    const cloud = new StubProvider("cloud", {});
    await expect(router("cloud", "pending", new StubProvider("local", {}), cloud).generateStructured(request)).rejects.toMatchObject({ code: "consent-required" });
    expect(cloud.calls).toBe(0);
  });

  it("cloud mode reports a denied site distinctly (no consent loop)", async () => {
    await expect(router("cloud", "deny", new StubProvider("local", {}), new StubProvider("cloud", {})).generateStructured(request)).rejects.toMatchObject({ code: "consent-denied" });
  });

  it("cloud mode uses cloud after consent and records it", async () => {
    const routed = router("cloud", "allow", new StubProvider("local", {}), new StubProvider("cloud", { from: "cloud" }));
    await expect(routed.generateStructured(request)).resolves.toEqual({ from: "cloud" });
    expect(routed.usedProvider).toBe("cloud");
  });

  it("hybrid keeps text requests local when local succeeds", async () => {
    const cloud = new StubProvider("cloud", {});
    const routed = router("hybrid", "allow", new StubProvider("local", { from: "local" }), cloud);
    await expect(routed.generateStructured(request)).resolves.toEqual({ from: "local" });
    expect(cloud.calls).toBe(0);
    expect(routed.usedProvider).toBe("local");
  });

  it("hybrid falls back to cloud after a local failure when consent exists", async () => {
    const routed = router("hybrid", "allow", new StubProvider("local", new ProviderError("timeout", "slow")), new StubProvider("cloud", { from: "cloud" }));
    await expect(routed.generateStructured(request)).resolves.toEqual({ from: "cloud" });
    expect(routed.usedProvider).toBe("cloud");
  });

  it("hybrid asks for consent (mentioning the local failure) instead of hiding it", async () => {
    const cloud = new StubProvider("cloud", {});
    const routed = router("hybrid", "pending", new StubProvider("local", new ProviderError("server-not-running", "llama-server is down")), cloud);
    await expect(routed.generateStructured(request)).rejects.toMatchObject({ code: "consent-required", message: expect.stringContaining("llama-server is down") });
    expect(cloud.calls).toBe(0);
  });

  it("hybrid surfaces the local error when the site denies cloud", async () => {
    const routed = router("hybrid", "deny", new StubProvider("local", new ProviderError("server-not-running", "down")), new StubProvider("cloud", {}));
    await expect(routed.generateStructured(request)).rejects.toMatchObject({ code: "server-not-running" });
  });

  it("hybrid never falls back to cloud when the user cancelled", async () => {
    const cloud = new StubProvider("cloud", {});
    const routed = router("hybrid", "allow", new StubProvider("local", new ProviderError("cancelled", "stop")), cloud);
    await expect(routed.generateStructured(request)).rejects.toMatchObject({ code: "cancelled" });
    expect(cloud.calls).toBe(0);
  });

  it("hybrid sends screenshots straight to cloud when the local model has no vision", async () => {
    const local = new StubProvider("local", {});
    const routed = router("hybrid", "allow", local, new StubProvider("cloud", { from: "cloud" }));
    await expect(routed.generateStructured({ ...request, images: [{ mimeType: "image/png", data: "x" }] })).resolves.toEqual({ from: "cloud" });
    expect(local.calls).toBe(0);
  });
});

describe("schema dialects", () => {
  const schema = planJsonSchema() as { properties: { changes: { properties: Record<string, Record<string, unknown>> } } };

  it("keeps Zod bounds for llama.cpp", () => {
    expect(schema.properties.changes.properties.fontSize).toMatchObject({ type: "number", minimum: 10, maximum: 48 });
  });

  it("strips keywords Claude rejects but keeps additionalProperties:false", () => {
    const claude = JSON.stringify(schemaForDialect(planJsonSchema(), "anthropic"));
    expect(claude).not.toMatch(/"minimum"|"maximum"|"maxLength"|"maxItems"/);
    expect(claude).toContain('"additionalProperties":false');
  });

  it("removes additionalProperties for Gemini's OpenAPI schema but keeps field names", () => {
    const openapi = schemaForDialect(planJsonSchema(), "gemini-openapi") as typeof schema;
    expect(JSON.stringify(openapi)).not.toContain("additionalProperties");
    expect(Object.keys(openapi.properties.changes.properties)).toContain("maxContentWidth");
  });

  it("uses a non-empty token for the site-default font", () => {
    expect(schema.properties.changes.properties.fontFamily.enum).toContain("default");
    expect(schema.properties.changes.properties.fontFamily.enum).not.toContain("");
  });
});

// ─── Real HTTP streams ───────────────────────────────────────────────────────
let server: Server | null = null;
afterEach(() => new Promise<void>((resolve) => { if (server) server.close(() => resolve()); else resolve(); server = null; }));

function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`));
  });
}

describe("CloudProvider (NDJSON from the proxy)", () => {
  const options = (proxyUrl: string) => ({ proxyUrl, proxyToken: "t", backend: "anthropic" as const, modelId: "claude-opus-5-5", timeoutMs: 5000 });

  it("reads pings then the result, reporting progress", async () => {
    let body = "";
    const url = await serve((req, res) => {
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.write('{"type":"ping"}\n');
        setTimeout(() => res.end('{"type":"result","data":{"ok":true},"modelId":"m"}\n'), 20);
      });
    });
    const progress = vi.fn();
    await expect(new CloudProvider(options(url)).generateStructured({ ...request, onProgress: progress })).resolves.toEqual({ ok: true });
    expect(progress).toHaveBeenCalled();
    const sent = JSON.parse(body) as { backend: string; schema: unknown };
    expect(sent.backend).toBe("anthropic");
    expect(JSON.stringify(sent.schema)).not.toContain('"minimum"');
  });

  it("maps a streamed upstream error", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200);
      res.end('{"type":"ping"}\n{"type":"error","status":429,"code":"rate_limited","message":"slow down"}\n');
    });
    await expect(new CloudProvider(options(url)).generateStructured(request)).rejects.toMatchObject({ code: "rate-limit" });
  });

  it("maps HTTP auth and origin failures", async () => {
    const url = await serve((req, res) => {
      res.writeHead(req.headers.authorization === "Bearer t" ? 403 : 401, { "Content-Type": "application/json" });
      res.end('{"error":{"code":"origin_forbidden","message":"no"}}');
    });
    await expect(new CloudProvider(options(url)).generateStructured(request)).rejects.toMatchObject({ code: "proxy-origin" });
  });

  it("reports a proxy that is not running", async () => {
    await expect(new CloudProvider(options("http://127.0.0.1:9")).generateStructured(request)).rejects.toMatchObject({ code: "proxy-down" });
  });

  it("times out a silent proxy", async () => {
    const url = await serve(() => { /* never answers */ });
    await expect(new CloudProvider({ ...options(url), timeoutMs: 50 }).generateStructured(request)).rejects.toMatchObject({ code: "timeout" });
  });

  it("reports a missing backend key from /health", async () => {
    const url = await serve((_req, res) => { res.writeHead(200); res.end('{"ok":true,"backends":{"gemini":true,"anthropic":false}}'); });
    await expect(new CloudProvider(options(url)).testConnection()).resolves.toMatchObject({ ok: false, error: expect.stringContaining("ANTHROPIC_API_KEY") });
  });
});

describe("LocalOpenAICompatProvider (SSE from llama-server)", () => {
  const options = (endpoint: string) => ({ endpoint, modelId: "local", contextSize: 8192, timeoutMs: 5000 });
  const sse = (pieces: string[]) => pieces.map((piece) => `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`).join("") + "data: [DONE]\n\n";

  it("assembles streamed chunks and requests json_schema output", async () => {
    let body = "";
    const url = await serve((req, res) => {
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(sse(['{"interpreted', 'Request":"x","changes":{}}'])); });
    });
    await expect(new LocalOpenAICompatProvider(options(`${url}/v1`)).generateStructured(request)).resolves.toEqual({ interpretedRequest: "x", changes: {} });
    const sent = JSON.parse(body) as { stream: boolean; response_format: { type: string; json_schema: { schema: unknown } } };
    expect(sent.stream).toBe(true);
    expect(sent.response_format.type).toBe("json_schema");
  });

  it("falls back to json_object when the server rejects json_schema", async () => {
    const formats: string[] = [];
    const url = await serve((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const format = (JSON.parse(body) as { response_format: { type: string } }).response_format.type;
        formats.push(format);
        if (format === "json_schema") { res.writeHead(400); res.end("unsupported response_format"); return; }
        res.writeHead(200); res.end(sse(['{"a":1}']));
      });
    });
    await expect(new LocalOpenAICompatProvider(options(url)).generateStructured(request)).resolves.toEqual({ a: 1 });
    expect(formats).toEqual(["json_schema", "json_object"]);
  });

  it("maps server errors to typed errors", async () => {
    const url = await serve((_req, res) => { res.writeHead(503); res.end("Loading model"); });
    await expect(new LocalOpenAICompatProvider(options(url)).generateStructured(request)).rejects.toMatchObject({ code: "model-not-loaded" });
  });

  it("maps auth failures with an api-key hint", async () => {
    const url = await serve((_req, res) => { res.writeHead(401); res.end("unauthorized"); });
    await expect(new LocalOpenAICompatProvider(options(url)).generateStructured(request)).rejects.toMatchObject({ code: "auth", hint: expect.stringContaining("--api-key") });
  });

  it("reports a server that is not running", async () => {
    await expect(new LocalOpenAICompatProvider(options("http://127.0.0.1:9")).generateStructured(request)).rejects.toMatchObject({ code: "server-not-running" });
  });

  it("distinguishes cancel from timeout", async () => {
    const url = await serve(() => { /* never answers */ });
    const controller = new AbortController();
    const pending = new LocalOpenAICompatProvider(options(url)).generateStructured({ ...request, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await expect(new LocalOpenAICompatProvider({ ...options(url), timeoutMs: 50 }).generateStructured(request)).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("extractJson", () => {
  it("tolerates code fences and chatter", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! {"a":2} hope that helps')).toEqual({ a: 2 });
    expect(() => extractJson("no json here")).toThrow(ProviderError);
  });
});

describe("ProviderRouter.review (P10 cloud supervisor)", () => {
  const reviewRouter = (mode: AiSettings["mode"], consent: CloudConsent, reviewer: StubProvider, cloud = new StubProvider("cloud", { ok: "cloud" })) =>
    new ProviderRouter({ settings: ai({ mode }), consent, local: new StubProvider("local", {}), cloud, reviewer });

  it("is never reachable in local mode", async () => {
    const reviewer = new StubProvider("cloud", {});
    await expect(reviewRouter("local", "allow", reviewer).review(request)).rejects.toMatchObject({ code: "unsupported" });
    expect(reviewer.calls).toBe(0);
  });

  it("needs the site's cloud consent", async () => {
    const reviewer = new StubProvider("cloud", {});
    await expect(reviewRouter("hybrid", "pending", reviewer).review(request)).rejects.toMatchObject({ code: "consent-required" });
    await expect(reviewRouter("hybrid", "deny", reviewer).review(request)).rejects.toMatchObject({ code: "consent-denied" });
    expect(reviewer.calls).toBe(0);
  });

  it("uses the review model, and the regular cloud model when it is busy", async () => {
    const ok = reviewRouter("hybrid", "allow", new StubProvider("cloud", { ok: "review" }));
    expect(await ok.review(request)).toEqual({ ok: "review" });
    expect(ok.reviewedBy).toBe("gemini-3.5-flash");
    const busy = reviewRouter("hybrid", "allow", new StubProvider("cloud", new ProviderError("timeout", "Gemini did not answer in time")));
    expect(await busy.review(request)).toEqual({ ok: "cloud" });
    expect(busy.reviewedBy).toBe("gemini-3.5-flash-lite");
  });

  it("does not hide other review errors behind the fallback", async () => {
    const cloud = new StubProvider("cloud", { ok: "cloud" });
    await expect(reviewRouter("cloud", "allow", new StubProvider("cloud", new ProviderError("safety-block", "blocked")), cloud).review(request)).rejects.toMatchObject({ code: "safety-block" });
    expect(cloud.calls).toBe(0);
  });
});
