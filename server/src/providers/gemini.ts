// Gemini generateContent with structured JSON output.
// Uses `responseMimeType` + `responseJsonSchema`; if this API version rejects
// that field, retries once with the OpenAPI-style `responseSchema`.
// `npm run smoke --workspace=server` shows which one the live API accepted.

import { MAX_OUTPUT_TOKENS, parseJsonReply, UpstreamError, UPSTREAM_TIMEOUT_MS, type AnalyzeRequest, type AnalyzeResult } from "./types.ts";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

type SchemaField = "responseJsonSchema" | "responseSchema";

function body(input: AnalyzeRequest, field: SchemaField): Record<string, unknown> {
  const parts: Array<Record<string, unknown>> = [{ text: input.userPrompt }];
  for (const image of input.images ?? []) parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
  const generationConfig: Record<string, unknown> = {
    temperature: 0,
    maxOutputTokens: Math.min(Math.max(input.maxTokens, 1), MAX_OUTPUT_TOKENS),
  };
  const schema = field === "responseJsonSchema" ? input.schema : input.schemaFallback ?? input.schema;
  if (schema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig[field] = schema;
  }
  return {
    systemInstruction: { parts: [{ text: input.systemPrompt }] },
    contents: [{ role: "user", parts }],
    generationConfig,
  };
}

interface GeminiReply {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
}

async function call(input: AnalyzeRequest, apiKey: string, field: SchemaField): Promise<{ status: number; payload: GeminiReply | null }> {
  try {
    const response = await fetch(`${ENDPOINT}/${encodeURIComponent(input.model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body(input, field)),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    return { status: response.status, payload: await response.json().catch(() => null) as GeminiReply | null };
  } catch (caught) {
    const timedOut = (caught as Error).name === "TimeoutError";
    throw new UpstreamError(timedOut ? 504 : 503, timedOut ? "timeout" : "upstream_unreachable", timedOut ? "Gemini did not answer in time." : "Gemini is unreachable from the proxy.");
  }
}

/** Last field the live API accepted; remembered so later calls skip the failing one. */
let acceptedField: SchemaField = "responseJsonSchema";

export function geminiSchemaField(): SchemaField {
  return acceptedField;
}

export async function analyzeWithGemini(input: AnalyzeRequest, apiKey: string): Promise<AnalyzeResult> {
  if (!apiKey) throw new UpstreamError(503, "not_configured", "GEMINI_API_KEY is not set in server/.env.");
  let { status, payload } = await call(input, apiKey, acceptedField);
  if (status === 400 && input.schema && acceptedField === "responseJsonSchema" && /responseJsonSchema|response_json_schema|Unknown name/i.test(payload?.error?.message ?? "")) {
    acceptedField = "responseSchema";
    ({ status, payload } = await call(input, apiKey, acceptedField));
  }
  if (status !== 200) {
    const message = payload?.error?.message ?? `Gemini returned HTTP ${status}.`;
    throw new UpstreamError(status === 429 ? 429 : status >= 500 ? 503 : status, status === 429 ? "rate_limited" : "upstream_error", message);
  }
  if (payload?.promptFeedback?.blockReason) throw new UpstreamError(422, "safety_block", `Gemini blocked the request (${payload.promptFeedback.blockReason}).`);
  const candidate = payload?.candidates?.[0];
  const text = candidate?.content?.parts?.filter((part) => !part.thought).map((part) => part.text ?? "").join("") ?? "";
  if (!text) throw new UpstreamError(422, "safety_block", `Gemini returned no usable content${candidate?.finishReason ? ` (${candidate.finishReason})` : ""}.`);
  if (candidate?.finishReason === "MAX_TOKENS") throw new UpstreamError(502, "malformed_upstream_json", "Gemini ran out of output tokens before finishing.");
  return input.schema ? { data: parseJsonReply(text), modelId: input.model } : { text, modelId: input.model };
}
