export type Backend = "gemini" | "anthropic";

export interface ImageInput { mimeType: string; data: string }

export interface AnalyzeRequest {
  backend: Backend;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  /** JSON schema already adapted to the backend's dialect by the extension. */
  schema?: Record<string, unknown>;
  /** Gemini only: OpenAPI-style schema used if the JSON-Schema field is rejected. */
  schemaFallback?: Record<string, unknown>;
  images?: ImageInput[];
  maxTokens: number;
}

/** A failure the proxy reports to the extension (never includes request bodies). */
// Node runs this file with type stripping only, so no parameter properties.
export class UpstreamError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface AnalyzeResult { data?: unknown; text?: string; modelId: string }

export const MAX_OUTPUT_TOKENS = 4096;
export const UPSTREAM_TIMEOUT_MS = 120_000;

export function parseJsonReply(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(trimmed); } catch {
    throw new UpstreamError(502, "malformed_upstream_json", "The cloud provider did not return valid structured JSON.");
  }
}
