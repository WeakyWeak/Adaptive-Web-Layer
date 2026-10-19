import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudProvider, type ConnectionStatus, type GenerateStructuredOpts, type GenerateTextOpts, type LLMProvider } from "../shared/llmProvider";
import { ProviderRouter } from "../shared/providerRouter";
import { defaultSettings } from "../shared/settings";
import { type Plan, ProviderError } from "../shared/plan";

const plan: Plan = { interpretedRequest: "test", operations: [], preserved: [], reasons: [], confidence: 1 };

class StubProvider implements LLMProvider {
  structuredCalls = 0;
  textCalls = 0;
  constructor(private readonly failure?: ProviderError) {}
  async generateStructured(_opts: GenerateStructuredOpts): Promise<Plan> { this.structuredCalls++; if (this.failure) throw this.failure; return plan; }
  async generateText(_opts: GenerateTextOpts): Promise<string> { this.textCalls++; if (this.failure) throw this.failure; return "ok"; }
  async testConnection(): Promise<ConnectionStatus> { return { ok: true, modelId: "stub" }; }
}

function settings(mode: "local" | "cloud" | "hybrid") {
  return { ...defaultSettings().ai, mode, cloudProxyUrl: "http://127.0.0.1:8787", cloudProxyToken: "test-token" };
}

describe("ProviderRouter policy matrix", () => {
  it("local mode produces zero proxy requests", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const local = new StubProvider();
    const router = new ProviderRouter({ settings: settings("local"), cloudAllowed: false, local });
    await expect(router.generateStructured({ systemPrompt: "s", userPrompt: "u" })).resolves.toEqual(plan);
    expect(local.structuredCalls).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("cloud mode requires consent before contacting the proxy", async () => {
    const cloud = new StubProvider();
    const router = new ProviderRouter({ settings: settings("cloud"), cloudAllowed: false, cloud });
    await expect(router.generateStructured({ systemPrompt: "s", userPrompt: "u" })).rejects.toMatchObject({ code: "consent-required" });
    expect(cloud.structuredCalls).toBe(0);
  });

  it("cloud mode uses the cloud provider after consent", async () => {
    const cloud = new StubProvider();
    const router = new ProviderRouter({ settings: settings("cloud"), cloudAllowed: true, local: new StubProvider(), cloud });
    await router.generateStructured({ systemPrompt: "s", userPrompt: "u" });
    expect(cloud.structuredCalls).toBe(1);
  });

  it("hybrid keeps text-only requests local when local succeeds", async () => {
    const local = new StubProvider();
    const cloud = new StubProvider();
    const router = new ProviderRouter({ settings: settings("hybrid"), cloudAllowed: false, local, cloud });
    await router.generateStructured({ systemPrompt: "s", userPrompt: "u" });
    expect(local.structuredCalls).toBe(1);
    expect(cloud.structuredCalls).toBe(0);
  });

  it("hybrid falls back to cloud only after local failure and consent", async () => {
    const local = new StubProvider(new ProviderError("server-not-running", "offline"));
    const cloud = new StubProvider();
    const router = new ProviderRouter({ settings: settings("hybrid"), cloudAllowed: true, local, cloud });
    await router.generateStructured({ systemPrompt: "s", userPrompt: "u" });
    expect(cloud.structuredCalls).toBe(1);
  });

  it("hybrid never falls back to cloud without consent", async () => {
    const cloud = new StubProvider();
    const router = new ProviderRouter({ settings: settings("hybrid"), cloudAllowed: false, local: new StubProvider(new ProviderError("server-not-running", "offline")), cloud });
    await expect(router.generateStructured({ systemPrompt: "s", userPrompt: "u" })).rejects.toMatchObject({ code: "server-not-running" });
    expect(cloud.structuredCalls).toBe(0);
  });
});

describe("CloudProvider normalized failures", () => {
  afterEach(() => vi.unstubAllGlobals());
  const provider = () => new CloudProvider({ proxyUrl: "http://127.0.0.1:8787", proxyToken: "test", modelId: "gemini-3.8-flash", timeoutMs: 5 });
  const options = { systemPrompt: "system", userPrompt: "user" };

  it.each([[401, "auth"], [429, "rate-limit"]] as const)("maps proxy HTTP %i to %s", async (status, code) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "nope" } }), { status, headers: { "Content-Type": "application/json" } })));
    await expect(provider().generateStructured(options)).rejects.toMatchObject({ code });
  });

  it("reports malformed proxy JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })));
    await expect(provider().generateStructured(options)).rejects.toMatchObject({ code: "invalid-json" });
  });

  it("reports an offline proxy", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(provider().generateStructured(options)).rejects.toMatchObject({ code: "proxy-down" });
  });

  it("reports a proxy timeout", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      await new Promise<void>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      return new Response();
    }));
    await expect(provider().generateStructured(options)).rejects.toMatchObject({ code: "timeout" });
  });
});
