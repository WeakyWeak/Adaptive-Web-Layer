// Sarvam Translate (docs.sarvam.ai → API reference → Translate Text, checked 2026-10-23):
// POST https://api.sarvam.ai/translate, header `api-subscription-key`,
// body {input, source_language_code, target_language_code, model}; reply {translated_text}.
// sarvam-translate:v1 accepts at most 2000 input characters and only "formal" mode.

import { UpstreamError } from "./types.ts";

const ENDPOINT = "https://api.sarvam.ai/translate";
const MODEL = "sarvam-translate:v1";
const TIMEOUT_MS = 30_000;
export const MAX_TRANSLATE_CHARS = 2000;
/** Language pairs the extension offers; keep in sync with extension/src/shared/languages.ts. */
export const SOURCE_LANGUAGES = ["en-IN"];
export const TARGET_LANGUAGES = ["hi-IN"];

export interface TranslateInput { text: string; source: string; target: string }
export interface TranslateResult { text: string; modelId: string }

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function parseTranslateRequest(value: unknown): TranslateInput | null {
  if (!isObject(value)) return null;
  const { text, source = "en-IN", target } = value;
  if (typeof text !== "string" || !text.trim() || text.length > MAX_TRANSLATE_CHARS) return null;
  if (typeof source !== "string" || !SOURCE_LANGUAGES.includes(source)) return null;
  if (typeof target !== "string" || !TARGET_LANGUAGES.includes(target)) return null;
  return { text, source, target };
}

export async function translateWithSarvam(input: TranslateInput, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<TranslateResult> {
  let response: Response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-subscription-key": apiKey },
      body: JSON.stringify({ input: input.text, source_language_code: input.source, target_language_code: input.target, model: MODEL }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (caught) {
    const timedOut = (caught as Error).name === "TimeoutError";
    throw new UpstreamError(timedOut ? 504 : 502, timedOut ? "timeout" : "upstream_unreachable", timedOut ? "Sarvam took too long to reply." : "Could not reach Sarvam.");
  }
  const payload = await response.json().catch(() => null) as { translated_text?: unknown; error?: { message?: string } } | null;
  if (!response.ok) {
    // Upstream messages are short and never echo the input; keys are never included.
    const detail = payload?.error?.message ? `: ${payload.error.message.slice(0, 200)}` : "";
    if (response.status === 403 || response.status === 401) throw new UpstreamError(502, "upstream_auth", `Sarvam rejected SARVAM_API_KEY${detail}`);
    if (response.status === 429) throw new UpstreamError(429, "rate_limited", `Sarvam quota or rate limit reached${detail}`);
    throw new UpstreamError(502, "translate_failed", `Sarvam could not translate (HTTP ${response.status})${detail}`);
  }
  if (typeof payload?.translated_text !== "string" || !payload.translated_text) throw new UpstreamError(502, "translate_failed", "Sarvam returned no translation.");
  return { text: payload.translated_text, modelId: MODEL };
}
