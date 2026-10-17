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

// ─── OpenAI-compatible chat completion response shape ────────────────────────
interface ChatCompletionChoice {
  message: { role: string; content: string };
  finish_reason: string;
}
interface ChatCompletionResponse {
  choices: ChatCompletionChoice[];
}

// ─── JSON schema for the Plan (for response_format) ──────────────────────────
const PLAN_JSON_SCHEMA = {
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
