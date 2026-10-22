// Claude via the official Anthropic SDK, with structured JSON output
// (`output_config.format`). The schema arrives already stripped of keywords
// Claude rejects (minimum/maximum, lengths); the extension re-validates bounds.

import Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "../config.ts";
import { MAX_OUTPUT_TOKENS, parseJsonReply, UpstreamError, UPSTREAM_TIMEOUT_MS, type AnalyzeRequest, type AnalyzeResult } from "./types.ts";

// Models that accept the server-side refusal fallback ("default" routing).
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

let client: Anthropic | null = null;
let clientKey = "";

function clientFor(apiKey: string): Anthropic {
  if (!client || clientKey !== apiKey) {
    client = new Anthropic({ apiKey, timeout: UPSTREAM_TIMEOUT_MS, maxRetries: 1 });
    clientKey = apiKey;
  }
  return client;
}

function userContent(input: AnalyzeRequest): Anthropic.ContentBlockParam[] {
  const images: Anthropic.ContentBlockParam[] = (input.images ?? []).map((image) => ({
    type: "image",
    source: { type: "base64", media_type: image.mimeType as ImageMediaType, data: image.data },
  }));
  return [...images, { type: "text", text: input.userPrompt }];
}

function translate(error: unknown): UpstreamError {
  if (error instanceof UpstreamError) return error;
  if (error instanceof Anthropic.AuthenticationError) return new UpstreamError(502, "upstream_auth", "Anthropic rejected ANTHROPIC_API_KEY.");
  if (error instanceof Anthropic.RateLimitError) return new UpstreamError(429, "rate_limited", "Anthropic rate limit reached; try again shortly.");
  if (error instanceof Anthropic.NotFoundError) return new UpstreamError(400, "upstream_error", "Anthropic does not know that model id.");
  if (error instanceof Anthropic.BadRequestError) return new UpstreamError(400, "upstream_error", `Anthropic rejected the request: ${error.message}`);
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new UpstreamError(504, "timeout", "Claude did not answer in time.");
  if (error instanceof Anthropic.APIConnectionError) return new UpstreamError(503, "upstream_unreachable", "Anthropic is unreachable from the proxy.");
  if (error instanceof Anthropic.APIError) return new UpstreamError(503, "upstream_error", `Anthropic error ${String(error.status)}.`);
  return new UpstreamError(500, "upstream_error", "Claude request failed.");
}

interface ReplyLike { content: Array<{ type: string; text?: string }>; stop_reason: string | null }

function readReply(reply: ReplyLike, input: AnalyzeRequest): AnalyzeResult {
  // Always check stop_reason before trusting content.
  if (reply.stop_reason === "refusal") throw new UpstreamError(422, "refusal", "Claude declined this request.");
  if (reply.stop_reason === "max_tokens") throw new UpstreamError(502, "malformed_upstream_json", "Claude ran out of output tokens before finishing.");
  const text = reply.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
  if (!text) throw new UpstreamError(422, "safety_block", "Claude returned no usable content.");
  return input.schema ? { data: parseJsonReply(text), modelId: input.model } : { text, modelId: input.model };
}

export async function analyzeWithAnthropic(input: AnalyzeRequest, apiKey: string, effort: Effort): Promise<AnalyzeResult> {
  if (!apiKey) throw new UpstreamError(503, "not_configured", "ANTHROPIC_API_KEY is not set in server/.env.");
  const anthropic = clientFor(apiKey);
  const outputConfig = {
    effort,
    ...(input.schema ? { format: { type: "json_schema" as const, schema: input.schema } } : {}),
  };
  const common = {
    model: input.model,
    max_tokens: Math.min(Math.max(input.maxTokens, 256), MAX_OUTPUT_TOKENS),
    system: input.systemPrompt,
    messages: [{ role: "user" as const, content: userContent(input) }],
    output_config: outputConfig,
  };
  try {
    if (FALLBACK_MODELS.has(input.model)) {
      const reply = await anthropic.beta.messages.create({ ...common, betas: [FALLBACK_BETA], fallbacks: "default" });
      return readReply(reply, input);
    }
    return readReply(await anthropic.messages.create(common), input);
  } catch (error) {
    throw translate(error);
  }
}
