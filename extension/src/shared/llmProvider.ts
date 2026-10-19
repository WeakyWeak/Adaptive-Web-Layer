// ─── LLM Provider abstraction (SPEC §3) ──────────────────────────────────────
// All AI calls go through this interface. Called ONLY from the service worker.
// Never called directly from content script or popup.

import { PlanSchema, ProviderError, type Plan } from "./plan";

// ─── Provider interface ────────────────────────────────────────────────────────
export interface LLMProvider {
  /** Generate a structured Plan from a prompt. */
  generateStructured(opts: GenerateStructuredOpts): Promise<Plan>;
  /** Generate free-form text. */
  generateText(opts: GenerateTextOpts): Promise<string>;
  /** Test that the provider is reachable and a model is loaded. */
  testConnection(): Promise<ConnectionStatus>;
  /** Optional visual analysis. Only the cloud provider supports this in P06. */
  analyzeImage?(opts: AnalyzeImageOpts): Promise<unknown>;
}

export interface GenerateStructuredOpts {
  systemPrompt: string;
  userPrompt: string;
  /** AbortSignal to cancel the request. */
  signal?: AbortSignal;
  /** Max tokens in the response. */
  maxTokens?: number;
}

export interface GenerateTextOpts {
  systemPrompt: string;
  userPrompt: string;
  signal?: AbortSignal;
  maxTokens?: number;
}

export interface ConnectionStatus {
  ok: boolean;
  latencyMs?: number;
  modelId?: string;
  error?: string;
}

export interface AnalyzeImageOpts extends GenerateStructuredOpts {
  images: Array<{ mimeType: "image/png" | "image/jpeg" | "image/webp"; data: string }>;
}

// ─── OpenAI-compatible chat completion response shape ────────────────────────
interface ChatCompletionChoice {
  message: { role: string; content: string };
  finish_reason: string;
}
interface ChatCompletionResponse {
  choices: ChatCompletionChoice[];
}

// ─── JSON schema for the Plan (for response_format) ──────────────────────────
export const PLAN_JSON_SCHEMA = {
  type: "object",
  required: ["interpretedRequest", "operations", "preserved", "reasons", "confidence"],
  properties: {
    interpretedRequest: { type: "string" },
    operations: {
      type: "array",
      items: {
        type: "object",
        required: ["opId", "params"],
        properties: {
          opId: { type: "string" },
          params: { type: "object" },
          targetRef: { type: "string" },
        },
      },
    },
    preserved: { type: "array", items: { type: "string" } },
    reasons: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
  },
};

interface ProxyErrorBody { error?: { code?: string; message?: string } }
interface ProxyAnalyzeResponse { data?: unknown; text?: string; modelId?: string }

/**
 * Talks only to the user's localhost proxy. Provider keys never enter this
 * extension; the configurable token merely unlocks the local proxy.
 */
export class CloudProvider implements LLMProvider {
  constructor(private readonly opts: {
    proxyUrl: string;
    proxyToken: string;
    modelId: string;
    timeoutMs?: number;
  }) {}

  private async request(body: Record<string, unknown>, signal?: AbortSignal): Promise<ProxyAnalyzeResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), this.opts.timeoutMs ?? 30000);
    const mergedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      let response: Response;
      try {
        response = await fetch(`${this.opts.proxyUrl.replace(/\/$/, "")}/v1/analyze`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.opts.proxyToken}`,
          },
          body: JSON.stringify({ model: this.opts.modelId, ...body }),
          signal: mergedSignal,
        });
      } catch (error) {
        if (controller.signal.aborted) throw new ProviderError("timeout", "Cloud proxy request timed out.");
        throw new ProviderError("proxy-down", "Cannot reach the local cloud proxy.", "Start the server in server/ and check its URL in Settings.");
      }
      let parsed: ProxyAnalyzeResponse | ProxyErrorBody = {};
      try { parsed = await response.json() as ProxyAnalyzeResponse | ProxyErrorBody; } catch {
        throw new ProviderError("invalid-json", "Cloud proxy returned malformed JSON.");
      }
      if (!response.ok) {
        const err = parsed as ProxyErrorBody;
        const message = err.error?.message ?? `Cloud proxy returned HTTP ${response.status}.`;
        if (response.status === 401) throw new ProviderError("auth", message);
        if (response.status === 429) throw new ProviderError("rate-limit", message, "Wait a minute before trying cloud AI again.");
        if (response.status === 408 || response.status === 504) throw new ProviderError("timeout", message);
        if (err.error?.code === "safety_block") throw new ProviderError("safety-block", message);
        throw new ProviderError("unknown", message);
      }
      return parsed as ProxyAnalyzeResponse;
    } finally {
      clearTimeout(timer);
    }
  }

  async generateStructured(opts: GenerateStructuredOpts): Promise<Plan> {
    const response = await this.request({
      systemPrompt: opts.systemPrompt,
      userPrompt: opts.userPrompt,
      responseSchema: PLAN_JSON_SCHEMA,
      maxTokens: opts.maxTokens,
    }, opts.signal);
    const parsed = PlanSchema.safeParse(response.data);
    if (!parsed.success) throw new ProviderError("invalid-json", "Cloud model returned a plan with schema errors.");
    return parsed.data;
  }

  async generateText(opts: GenerateTextOpts): Promise<string> {
    const response = await this.request({ systemPrompt: opts.systemPrompt, userPrompt: opts.userPrompt, maxTokens: opts.maxTokens }, opts.signal);
    if (typeof response.text !== "string") throw new ProviderError("invalid-json", "Cloud model returned an invalid text response.");
    return response.text;
  }

  async analyzeImage(opts: AnalyzeImageOpts): Promise<unknown> {
    const response = await this.request({
      systemPrompt: opts.systemPrompt,
      userPrompt: opts.userPrompt,
      responseSchema: PLAN_JSON_SCHEMA,
      images: opts.images,
      maxTokens: opts.maxTokens,
    }, opts.signal);
    if (response.data === undefined) throw new ProviderError("invalid-json", "Cloud model returned no visual analysis.");
    return response.data;
  }

  async testConnection(): Promise<ConnectionStatus> {
    const start = Date.now();
    try {
      const response = await fetch(`${this.opts.proxyUrl.replace(/\/$/, "")}/health`, {
        headers: { Authorization: `Bearer ${this.opts.proxyToken}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
      return { ok: true, latencyMs: Date.now() - start, modelId: this.opts.modelId };
    } catch (error) {
      return { ok: false, error: (error as Error).message || "Cloud proxy unavailable" };
    }
  }
}

// ─── Local OpenAI-compatible provider ────────────────────────────────────────
export class LocalOpenAICompatProvider implements LLMProvider {
  private endpoint: string;
  private modelId: string;
  private contextSize: number;
  private timeoutMs: number;
  private apiKey?: string;

  constructor(opts: {
    endpoint?: string;
    modelId?: string;
    contextSize?: number;
    timeoutMs?: number;
    apiKey?: string;
  } = {}) {
    this.endpoint = (opts.endpoint ?? "http://127.0.0.1:8080").replace(/\/$/, "");
    this.modelId = opts.modelId ?? "qwen2.5-coder:7b";
    this.contextSize = opts.contextSize ?? 8192;
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.apiKey = opts.apiKey;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  async generateStructured(opts: GenerateStructuredOpts): Promise<Plan> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), this.timeoutMs);
    const signal = opts.signal
      ? AbortSignal.any([controller.signal, opts.signal])
      : controller.signal;

    try {
      // Build token budget (rough: 1 token ≈ 4 chars)
      const promptTokens = Math.ceil((opts.systemPrompt.length + opts.userPrompt.length) / 4);
      const maxTokens = Math.min(opts.maxTokens ?? 1024, this.contextSize - promptTokens - 128);

      const body: Record<string, unknown> = {
        model: this.modelId,
        messages: [
          { role: "system", content: opts.systemPrompt },
          { role: "user", content: opts.userPrompt },
        ],
        max_tokens: Math.max(maxTokens, 256),
        temperature: 0,
        // Request structured JSON output (llama-server supports this)
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "Plan",
            strict: true,
            schema: PLAN_JSON_SCHEMA,
          },
        },
      };

      let response: Response;
      try {
        response = await fetch(`${this.endpoint}/v1/chat/completions`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        if ((err as Error)?.message?.includes("abort") || (err as DOMException)?.name === "AbortError") {
          const reason = controller.signal.aborted ? "timeout" : "cancelled";
          throw new ProviderError(reason === "timeout" ? "timeout" : "network",
            reason === "timeout" ? "Request timed out" : "Request cancelled");
        }
        throw new ProviderError("server-not-running",
          `Cannot reach local AI server at ${this.endpoint}/v1/chat/completions. Is llama-server running?`);
      }

      if (response.status === 401 || response.status === 403) {
        throw new ProviderError("auth",
          `Authentication failed (HTTP ${response.status}).`);
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        if (text.includes("context") || text.includes("token")) {
          throw new ProviderError("context-overflow", `Context overflow: ${text.slice(0, 200)}`);
        }
        if (text.includes("model") || text.includes("not loaded")) {
          throw new ProviderError("model-not-loaded", `Model not loaded: ${text.slice(0, 200)}`);
        }
        throw new ProviderError("unknown", `HTTP ${response.status}: ${text.slice(0, 200)}`);
      }

      let data: ChatCompletionResponse;
      try {
        data = await response.json() as ChatCompletionResponse;
      } catch {
        throw new ProviderError("invalid-json", "Server returned non-JSON response.");
      }

      const content = data.choices?.[0]?.message?.content ?? "";
      if (!content) {
        throw new ProviderError("invalid-json", "Empty response from model.");
      }

      // Parse the JSON content
      let rawPlan: unknown;
      try {
        rawPlan = JSON.parse(content);
      } catch {
        // Model didn't return valid JSON even with response_format — try to extract
        const match = content.match(/\{[\s\S]*\}/);
        if (!match) {
          throw new ProviderError("invalid-json",
            `Model returned invalid JSON. Raw: ${content.slice(0, 200)}`);
        }
        try {
          rawPlan = JSON.parse(match[0]);
        } catch {
          throw new ProviderError("invalid-json",
            `Model returned invalid JSON. Raw: ${content.slice(0, 200)}`);
        }
      }

      const parsed = PlanSchema.safeParse(rawPlan);
      if (!parsed.success) {
        throw new ProviderError("invalid-json",
          `Model returned a plan with schema errors: ${parsed.error.message}`);
      }
      return parsed.data;
    } finally {
      clearTimeout(timer);
    }
  }

  async generateText(opts: GenerateTextOpts): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), this.timeoutMs);
    const signal = opts.signal
      ? AbortSignal.any([controller.signal, opts.signal])
      : controller.signal;

    try {
      const body = {
        model: this.modelId,
        messages: [
          { role: "system", content: opts.systemPrompt },
          { role: "user", content: opts.userPrompt },
        ],
        max_tokens: opts.maxTokens ?? 512,
        temperature: 0,
      };

      let response: Response;
      try {
        response = await fetch(`${this.endpoint}/v1/chat/completions`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        if ((err as Error)?.message?.includes("abort") || (err as DOMException)?.name === "AbortError") {
          throw new ProviderError("timeout", "Request timed out or cancelled");
        }
        throw new ProviderError("server-not-running",
          `Cannot reach local AI server at ${this.endpoint}`);
      }

      if (!response.ok) {
        throw new ProviderError("unknown", `HTTP ${response.status}`);
      }

      const data = await response.json() as ChatCompletionResponse;
      return data.choices?.[0]?.message?.content ?? "";
    } finally {
      clearTimeout(timer);
    }
  }

  async testConnection(): Promise<ConnectionStatus> {
    const start = Date.now();
    try {
      const response = await fetch(`${this.endpoint}/v1/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        return {
          ok: false,
          error: `HTTP ${response.status}`,
        };
      }
      const data = await response.json() as { data?: Array<{ id: string }> };
      const modelId = data.data?.[0]?.id ?? this.modelId;
      return {
        ok: true,
        latencyMs: Date.now() - start,
        modelId,
      };
    } catch (err) {
      return {
        ok: false,
        error: (err as Error)?.message ?? "Unknown error",
      };
    }
  }
}

// ─── Mock provider (tests + labeled demo mode) ────────────────────────────────
export const DEMO_MODE_LABEL = "⚠ Demo mode — no AI server connected";

export interface MockProviderOpts {
  /** If set, throw this error instead of returning a plan. */
  errorToThrow?: ProviderError;
  /** Fixed plan to return. */
  plan?: Plan;
  /** If true, return an invalid plan (for retry testing). */
  returnInvalidPlan?: boolean;
  /** Number of calls before switching from invalid→valid (for retry testing). */
  invalidCallsBeforeValid?: number;
}

export class MockProvider implements LLMProvider {
  private callCount = 0;

  constructor(private opts: MockProviderOpts = {}) {}

  async generateStructured(_opts: GenerateStructuredOpts): Promise<Plan> {
    this.callCount++;

    if (this.opts.errorToThrow) throw this.opts.errorToThrow;

    // Simulate invalid JSON on first N calls (retry testing)
    if (this.opts.returnInvalidPlan) {
      const invalidCallsAllowed = this.opts.invalidCallsBeforeValid ?? 1;
      if (this.callCount <= invalidCallsAllowed) {
        throw new ProviderError("invalid-json", "Simulated invalid plan for retry testing");
      }
    }

    if (this.opts.plan) return this.opts.plan;

    // Default demo plan
    return {
      interpretedRequest: "Make article text larger and easier to read",
      operations: [
        { opId: "fontSize", params: { value: 20 } },
        { opId: "lineHeight", params: { value: 1.8 } },
        { opId: "maxContentWidth", params: { value: 750 } },
      ],
      preserved: ["pre", "code"],
      reasons: ["Larger font size improves readability", "Increased line height reduces eye strain"],
      confidence: 0.9,
    };
  }

  async generateText(_opts: GenerateTextOpts): Promise<string> {
    return "This is a mock response.";
  }

  async testConnection(): Promise<ConnectionStatus> {
    return { ok: true, latencyMs: 1, modelId: "mock-model" };
  }
}
