// Gemini generateContent with structured JSON output.
// Uses `responseMimeType` + `responseJsonSchema`; if this API version rejects
// that field, retries once with the OpenAPI-style `responseSchema`.
// `npm run smoke --workspace=server` shows which one the live API accepted.

import { MAX_OUTPUT_TOKENS, parseJsonReply, UpstreamError, type AnalyzeRequest, type AnalyzeResult } from "./types.ts";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
// Three attempts (+ backoff) must finish before the extension's 120 s limit,
// so the user gets "Gemini is busy" rather than a bare timeout.
const ATTEMPT_TIMEOUT_MS = 35_000;

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
  error?: { message?: string; details?: Array<{ fieldViolations?: Array<{ field?: string; description?: string }> }> };
}

/** Gemini's own error text plus the first field it objected to ("Request contains an invalid argument" alone says little). */
export function geminiErrorMessage(payload: GeminiReply | null, status: number): string {
  const message = payload?.error?.message ?? `Gemini returned HTTP ${status}.`;
  const violation = payload?.error?.details?.flatMap((detail) => detail.fieldViolations ?? [])[0];
  if (!violation) return message;
  return `${message} (${[violation.field, violation.description].filter(Boolean).join(": ")})`.slice(0, 400);
}

async function call(input: AnalyzeRequest, apiKey: string, field: SchemaField): Promise<{ status: number; payload: GeminiReply | null }> {
  try {
    const response = await fetch(`${ENDPOINT}/${encodeURIComponent(input.model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body(input, field)),
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
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

const RETRY_DELAYS_MS = [1500, 4000];

/** Gemini answers 503 "high demand" during load spikes; those usually clear within seconds. */
async function callWithRetry(input: AnalyzeRequest, apiKey: string, field: SchemaField): Promise<{ status: number; payload: GeminiReply | null }> {
  let result = await call(input, apiKey, field).catch((error: unknown) => {
    if (error instanceof UpstreamError && error.status === 504) return { status: 504, payload: null };
    throw error;
  });
  for (const delay of RETRY_DELAYS_MS) {
    if (result.status !== 503 && result.status !== 504) break;
    await new Promise((resolve) => setTimeout(resolve, delay));
    result = await call(input, apiKey, field).catch((error: unknown) => {
      if (error instanceof UpstreamError && error.status === 504) return { status: 504, payload: null };
      throw error;
    });
  }
  if (result.status === 504) throw new UpstreamError(504, "timeout", "Gemini did not answer in time (it may be overloaded). Try again or pick a lighter model.");
  return result;
}

export async function analyzeWithGemini(input: AnalyzeRequest, apiKey: string): Promise<AnalyzeResult> {
  if (!apiKey) throw new UpstreamError(503, "not_configured", "GEMINI_API_KEY is not set in server/.env.");
  let { status, payload } = await callWithRetry(input, apiKey, acceptedField);
  if (status === 400 && input.schema && acceptedField === "responseJsonSchema" && /responseJsonSchema|response_json_schema|Unknown name/i.test(payload?.error?.message ?? "")) {
    acceptedField = "responseSchema";
    ({ status, payload } = await callWithRetry(input, apiKey, acceptedField));
  }
  if (status !== 200) {
    const message = status === 503
      ? `Gemini (${input.model}) is overloaded right now. Try again shortly, or pick a lighter model such as gemini-3.5-flash-lite.`
      : geminiErrorMessage(payload, status);
    // Logged without the request body, so a refused request can be diagnosed later.
    if (status === 400) console.warn(`[proxy] Gemini ${input.model} refused a request (${input.images?.length ?? 0} image(s), schema ${JSON.stringify(input.schema ?? {}).length} chars): ${message}`);
    throw new UpstreamError(status === 429 ? 429 : status >= 500 ? 503 : status, status === 429 ? "rate_limited" : "upstream_error", message);
  }
  if (payload?.promptFeedback?.blockReason) throw new UpstreamError(422, "safety_block", `Gemini blocked the request (${payload.promptFeedback.blockReason}).`);
  const candidate = payload?.candidates?.[0];
  const text = candidate?.content?.parts?.filter((part) => !part.thought).map((part) => part.text ?? "").join("") ?? "";
  if (!text) throw new UpstreamError(422, "safety_block", `Gemini returned no usable content${candidate?.finishReason ? ` (${candidate.finishReason})` : ""}.`);
  if (candidate?.finishReason === "MAX_TOKENS") throw new UpstreamError(502, "malformed_upstream_json", "Gemini ran out of output tokens before finishing.");
  return input.schema ? { data: parseJsonReply(text), modelId: input.model } : { text, modelId: input.model };
}
