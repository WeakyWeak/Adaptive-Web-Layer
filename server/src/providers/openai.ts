// Any OpenAI-compatible chat-completions API (OpenRouter, Groq, a hosted
// llama.cpp, …) as a cloud backend. Base URL, key and model come from
// server/.env (OPENAI_COMPAT_*); the extension may name a different model.
// Structured output uses `response_format: json_schema`; servers that refuse
// it get plain JSON mode once, and the extension validates the reply anyway.

import { MAX_OUTPUT_TOKENS, parseJsonReply, UpstreamError, UPSTREAM_TIMEOUT_MS, type AnalyzeRequest, type AnalyzeResult } from "./types.ts";

export interface OpenAiCompatConfig { baseUrl: string; apiKey: string; model: string }

interface ChatReply {
  choices?: Array<{ message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }>;
  error?: { message?: string };
}

function body(input: AnalyzeRequest, model: string, format: "json_schema" | "json_object"): Record<string, unknown> {
  const content = input.images?.length
    ? [{ type: "text", text: input.userPrompt }, ...input.images.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } }))]
    : input.userPrompt;
  return {
    model,
    temperature: 0,
    max_tokens: Math.min(Math.max(input.maxTokens, 1), MAX_OUTPUT_TOKENS),
    messages: [{ role: "system", content: input.systemPrompt }, { role: "user", content }],
    ...(input.schema
      ? { response_format: format === "json_schema" ? { type: "json_schema", json_schema: { name: "reply", strict: false, schema: input.schema } } : { type: "json_object" } }
      : {}),
  };
}

async function call(input: AnalyzeRequest, cfg: OpenAiCompatConfig, model: string, format: "json_schema" | "json_object", fetchImpl: typeof fetch): Promise<{ status: number; payload: ChatReply | null }> {
  try {
    const response = await fetchImpl(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body(input, model, format)),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    return { status: response.status, payload: await response.json().catch(() => null) as ChatReply | null };
  } catch (caught) {
    const timedOut = (caught as Error).name === "TimeoutError";
    throw new UpstreamError(timedOut ? 504 : 503, timedOut ? "timeout" : "upstream_unreachable", timedOut ? "The OpenAI-compatible provider did not answer in time." : "The OpenAI-compatible provider is unreachable from the proxy.");
  }
}

export async function analyzeWithOpenAiCompat(input: AnalyzeRequest, cfg: OpenAiCompatConfig, fetchImpl: typeof fetch = fetch): Promise<AnalyzeResult> {
  if (!cfg.baseUrl || !cfg.apiKey) throw new UpstreamError(503, "not_configured", "OPENAI_COMPAT_BASE_URL and OPENAI_COMPAT_API_KEY are not set in server/.env.");
  // The extension's default model id is a placeholder; the .env model wins then.
  const model = input.model && input.model !== "gpt-compatible" ? input.model : cfg.model;
  if (!model) throw new UpstreamError(503, "not_configured", "Set OPENAI_COMPAT_MODEL in server/.env (or a model in Settings → AI).");
  let { status, payload } = await call(input, cfg, model, "json_schema", fetchImpl);
  if (status === 400 && input.schema) ({ status, payload } = await call(input, cfg, model, "json_object", fetchImpl));
  if (status === 401 || status === 403) throw new UpstreamError(502, "upstream_auth", "The OpenAI-compatible provider rejected OPENAI_COMPAT_API_KEY.");
  if (status !== 200) throw new UpstreamError(status === 429 ? 429 : status >= 500 ? 503 : status, status === 429 ? "rate_limited" : "upstream_error", payload?.error?.message ?? `The OpenAI-compatible provider returned HTTP ${status}.`);
  const choice = payload?.choices?.[0];
  if (choice?.message?.refusal) throw new UpstreamError(422, "refusal", "The model declined this request.");
  if (choice?.finish_reason === "length") throw new UpstreamError(502, "malformed_upstream_json", "The model ran out of output tokens before finishing.");
  const text = choice?.message?.content ?? "";
  if (!text) throw new UpstreamError(422, "safety_block", "The model returned no usable content.");
  return input.schema ? { data: parseJsonReply(text), modelId: model } : { text, modelId: model };
}
