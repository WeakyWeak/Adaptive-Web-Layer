// ─── LLM providers (SPEC §3) ─────────────────────────────────────────────────
// Called ONLY from the service worker, and only through ProviderRouter.
// Providers return raw JSON; the planner validates it with Zod.

import { ProviderError } from "./plan";
import { schemaForDialect, type JsonSchema } from "./jsonSchema";

export interface ImageInput {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  /** Base64 data without a data: prefix. */
  data: string;
}

export interface StructuredRequest {
  systemPrompt: string;
  userPrompt: string;
  /** Canonical plan schema; each provider adapts it to its own dialect. */
  schema: JsonSchema;
  images?: ImageInput[];
  signal?: AbortSignal;
  maxTokens?: number;
  /** Called while a reply streams in (characters received so far). */
  onProgress?: (received: number) => void;
}

export interface ConnectionStatus {
  ok: boolean;
  latencyMs?: number;
  modelId?: string;
  error?: string;
}

export interface TranslateRequest {
  text: string;
  source: string;
  target: string;
  signal?: AbortSignal;
}

export interface LLMProvider {
  readonly kind: "local" | "cloud";
  readonly supportsVision: boolean;
  generateStructured(request: StructuredRequest): Promise<unknown>;
  /** Machine translation service (cloud only: Sarvam through the proxy). */
  translate?(request: TranslateRequest): Promise<string>;
  testConnection(): Promise<ConnectionStatus>;
}

// ─── Shared helpers ──────────────────────────────────────────────────────────
interface Deadline { signal: AbortSignal; timedOut: () => boolean; clear: () => void }

function withDeadline(timeoutMs: number, outer?: AbortSignal): Deadline {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  return {
    signal: outer ? AbortSignal.any([outer, controller.signal]) : controller.signal,
    timedOut: () => controller.signal.aborted,
    clear: () => clearTimeout(timer),
  };
}

function abortError(deadline: Deadline): ProviderError {
  return deadline.timedOut()
    ? new ProviderError("timeout", "The AI request timed out.")
    : new ProviderError("cancelled", "The AI request was cancelled.");
}

/** Read a streamed body line by line (SSE and NDJSON are both line based). */
async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield line;
      newline = buffer.indexOf("\n");
    }
  }
  const rest = (buffer + decoder.decode()).trim();
  if (rest) yield rest;
}

/** Parse a model's text reply as JSON, tolerating code fences and chatter. */
export function extractJson(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* fall through */ }
  }
  throw new ProviderError("invalid-json", `The model did not return JSON: ${content.slice(0, 160)}`);
}

// ─── Local OpenAI-compatible provider (llama-server, Ollama /v1) ─────────────
export interface LocalProviderOptions {
  endpoint: string;
  modelId: string;
  contextSize: number;
  timeoutMs: number;
  apiKey?: string;
  supportsVision?: boolean;
}

interface ChatChunk { choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }> }

export class LocalOpenAICompatProvider implements LLMProvider {
  readonly kind = "local" as const;
  readonly supportsVision: boolean;
  private readonly endpoint: string;

  constructor(private readonly opts: LocalProviderOptions) {
    this.endpoint = opts.endpoint.replace(/\/$/, "").replace(/\/v1$/, "");
    this.supportsVision = opts.supportsVision ?? false;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.opts.apiKey) headers.Authorization = `Bearer ${this.opts.apiKey}`;
    return headers;
  }

  private userContent(request: StructuredRequest): unknown {
    if (!request.images?.length) return request.userPrompt;
    return [
      { type: "text", text: request.userPrompt },
      ...request.images.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } })),
    ];
  }

  private body(request: StructuredRequest, responseFormat: unknown): string {
    const promptTokens = Math.ceil((request.systemPrompt.length + request.userPrompt.length) / 4);
    const maxTokens = Math.max(256, Math.min(request.maxTokens ?? 768, this.opts.contextSize - promptTokens - 128));
    return JSON.stringify({
      model: this.opts.modelId,
      messages: [
        { role: "system", content: request.systemPrompt },
        { role: "user", content: this.userContent(request) },
      ],
      max_tokens: maxTokens,
      temperature: 0,
      stream: true,
      response_format: responseFormat,
    });
  }

  private async post(request: StructuredRequest, responseFormat: unknown, deadline: Deadline): Promise<Response> {
    try {
      return await fetch(`${this.endpoint}/v1/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: this.body(request, responseFormat),
        signal: deadline.signal,
      });
    } catch {
      if (deadline.signal.aborted) throw abortError(deadline);
      throw new ProviderError("server-not-running", `Cannot reach the local AI server at ${this.endpoint}.`);
    }
  }

  private async failure(response: Response): Promise<ProviderError> {
    const text = (await response.text().catch(() => "")).slice(0, 300);
    if (response.status === 401 || response.status === 403) {
      return new ProviderError("auth", `The local AI server refused the request (HTTP ${response.status}).`, "Set the API key in Settings → AI to match llama-server --api-key. For Ollama, set OLLAMA_ORIGINS.");
    }
    if (response.status === 503 || /loading model/i.test(text)) return new ProviderError("model-not-loaded", "The local model is still loading.");
    if (/context|too many tokens|exceed/i.test(text)) return new ProviderError("context-overflow", `The prompt is too long for the local model: ${text}`);
    if (response.status === 404 && /model/i.test(text)) return new ProviderError("model-not-loaded", `The local server does not have model "${this.opts.modelId}".`);
    return new ProviderError("unknown", `Local AI server error (HTTP ${response.status}): ${text}`);
  }

  async generateStructured(request: StructuredRequest): Promise<unknown> {
    const deadline = withDeadline(this.opts.timeoutMs, request.signal);
    try {
      const schema = schemaForDialect(request.schema, "llamacpp");
      let response = await this.post(request, { type: "json_schema", json_schema: { name: "plan", strict: true, schema } }, deadline);
      // Older servers lack json_schema; JSON mode plus Zod validation still works.
      if (response.status === 400) {
        const text = await response.clone().text().catch(() => "");
        if (/response_format|json_schema/i.test(text)) response = await this.post(request, { type: "json_object" }, deadline);
      }
      if (!response.ok) throw await this.failure(response);
      if (!response.body) throw new ProviderError("invalid-json", "The local AI server returned an empty response.");

      let content = "";
      for await (const line of readLines(response.body)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") break;
        try {
          const chunk = JSON.parse(data) as ChatChunk;
          content += chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content ?? "";
          request.onProgress?.(content.length);
        } catch { /* ignore keep-alive or partial lines */ }
      }
      if (!content) throw new ProviderError("invalid-json", "The local model returned an empty reply.");
      return extractJson(content);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (deadline.signal.aborted) throw abortError(deadline);
      throw new ProviderError("network", `Lost the connection to the local AI server: ${String(error)}`);
    } finally {
      deadline.clear();
    }
  }

  async testConnection(): Promise<ConnectionStatus> {
    const start = Date.now();
    try {
      const response = await fetch(`${this.endpoint}/v1/models`, { headers: this.headers(), signal: AbortSignal.timeout(5000) });
      if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
      const data = await response.json() as { data?: Array<{ id: string }> };
      return { ok: true, latencyMs: Date.now() - start, modelId: data.data?.[0]?.id ?? this.opts.modelId };
    } catch (error) {
      return { ok: false, error: `Local AI server unreachable at ${this.endpoint} (${(error as Error).message})` };
    }
  }
}

// ─── Cloud provider: the user's localhost proxy (Gemini or Claude) ──────────
export type CloudBackend = "gemini" | "anthropic";

export interface CloudProviderOptions {
  proxyUrl: string;
  proxyToken: string;
  backend: CloudBackend;
  modelId: string;
  timeoutMs: number;
}

interface ProxyLine {
  type: "ping" | "result" | "error";
  data?: unknown;
  modelId?: string;
  status?: number;
  code?: string;
  message?: string;
}

const CLOUD_MAX_OUTPUT_TOKENS = 4096;

/** Maps a proxy error (HTTP status + code) to a typed provider error. */
export function proxyError(status: number, code: string | undefined, message: string): ProviderError {
  if (status === 401) return new ProviderError("auth", message, "Copy PROXY_TOKEN from server/.env into Settings → AI → Proxy token.");
  if (status === 403 || code === "origin_forbidden") return new ProviderError("proxy-origin", message);
  if (status === 429) return new ProviderError("rate-limit", message);
  if (status === 408 || status === 504) return new ProviderError("timeout", message);
  if (code === "not_configured") return new ProviderError("not-configured", message);
  if (code === "translate_failed") return new ProviderError("unknown", message, "Sarvam could not translate this text. Try a shorter selection.");
  if (code === "safety_block" || code === "refusal") return new ProviderError("safety-block", message);
  if (code === "malformed_upstream_json") return new ProviderError("invalid-json", message);
  return new ProviderError("unknown", message);
}

/**
 * Talks only to the user's localhost proxy, which holds the provider keys.
 * The proxy streams NDJSON (pings, then one result or error line) so the
 * service worker receives bytes well within Chrome's 30-second fetch limit.
 */
export class CloudProvider implements LLMProvider {
  readonly kind = "cloud" as const;
  readonly supportsVision = true;

  constructor(private readonly opts: CloudProviderOptions) {}

  private url(path: string): string {
    return `${this.opts.proxyUrl.replace(/\/$/, "")}${path}`;
  }

  private schemas(schema: JsonSchema): { schema: JsonSchema; schemaFallback?: JsonSchema } {
    if (this.opts.backend === "anthropic") return { schema: schemaForDialect(schema, "anthropic") };
    return { schema: schemaForDialect(schema, "gemini"), schemaFallback: schemaForDialect(schema, "gemini-openapi") };
  }

  async generateStructured(request: StructuredRequest): Promise<unknown> {
    const deadline = withDeadline(this.opts.timeoutMs, request.signal);
    try {
      let response: Response;
      try {
        response = await fetch(this.url("/v1/analyze"), {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.opts.proxyToken}` },
          body: JSON.stringify({
            backend: this.opts.backend,
            model: this.opts.modelId,
            systemPrompt: request.systemPrompt,
            userPrompt: request.userPrompt,
            images: request.images,
            maxTokens: Math.min(request.maxTokens ?? CLOUD_MAX_OUTPUT_TOKENS, CLOUD_MAX_OUTPUT_TOKENS),
            ...this.schemas(request.schema),
          }),
          signal: deadline.signal,
        });
      } catch {
        if (deadline.signal.aborted) throw abortError(deadline);
        throw new ProviderError("proxy-down", `Cannot reach the local cloud proxy at ${this.opts.proxyUrl}.`);
      }

      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
        throw proxyError(response.status, body?.error?.code, body?.error?.message ?? `Cloud proxy returned HTTP ${response.status}.`);
      }

      let received = 0;
      for await (const line of readLines(response.body)) {
        received += line.length;
        request.onProgress?.(received);
        let parsed: ProxyLine;
        try { parsed = JSON.parse(line) as ProxyLine; } catch { throw new ProviderError("invalid-json", "The cloud proxy sent a malformed line."); }
        if (parsed.type === "result") {
          if (parsed.data === undefined) throw new ProviderError("invalid-json", "The cloud model returned no structured data.");
          return parsed.data;
        }
        if (parsed.type === "error") throw proxyError(parsed.status ?? 502, parsed.code, parsed.message ?? "Cloud request failed.");
      }
      throw new ProviderError("network", "The cloud proxy closed the connection before replying.");
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (deadline.signal.aborted) throw abortError(deadline);
      throw new ProviderError("network", `Lost the connection to the cloud proxy: ${String(error)}`);
    } finally {
      deadline.clear();
    }
  }

  /** One chunk (≤ 2000 characters) through the proxy's Sarvam backend. */
  async translate(request: TranslateRequest): Promise<string> {
    const deadline = withDeadline(this.opts.timeoutMs, request.signal);
    try {
      let response: Response;
      try {
        response = await fetch(this.url("/v1/translate"), {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.opts.proxyToken}` },
          body: JSON.stringify({ text: request.text, source: request.source, target: request.target }),
          signal: deadline.signal,
        });
      } catch {
        if (deadline.signal.aborted) throw abortError(deadline);
        throw new ProviderError("proxy-down", `Cannot reach the local cloud proxy at ${this.opts.proxyUrl}.`);
      }
      const body = await response.json().catch(() => null) as { text?: unknown; error?: { code?: string; message?: string } } | null;
      if (!response.ok) throw proxyError(response.status, body?.error?.code, body?.error?.message ?? `Translation failed (HTTP ${response.status}).`);
      if (typeof body?.text !== "string" || !body.text) throw new ProviderError("invalid-json", "The translation service returned no text.");
      return body.text;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (deadline.signal.aborted) throw abortError(deadline);
      throw new ProviderError("network", `Lost the connection to the cloud proxy: ${String(error)}`);
    } finally {
      deadline.clear();
    }
  }

  async testConnection(): Promise<ConnectionStatus> {
    const start = Date.now();
    try {
      const response = await fetch(this.url("/health"), {
        headers: { Authorization: `Bearer ${this.opts.proxyToken}` },
        signal: AbortSignal.timeout(5000),
      });
      const body = await response.json().catch(() => ({})) as { backends?: Record<string, boolean>; error?: { message?: string } };
      if (!response.ok) return { ok: false, error: body.error?.message ?? `HTTP ${response.status}` };
      if (body.backends && !body.backends[this.opts.backend]) {
        return { ok: false, error: `The proxy has no ${this.opts.backend === "anthropic" ? "ANTHROPIC_API_KEY" : "GEMINI_API_KEY"} configured.` };
      }
      return { ok: true, latencyMs: Date.now() - start, modelId: `${this.opts.backend}:${this.opts.modelId}` };
    } catch (error) {
      return { ok: false, error: `Cloud proxy unreachable at ${this.opts.proxyUrl} (${(error as Error).message})` };
    }
  }
}
