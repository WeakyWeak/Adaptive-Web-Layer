import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BODY_BYTES = 1_000_000;
const MAX_REQUESTS_PER_MINUTE = 30;
const CLOUD_MAX_OUTPUT_TOKENS = 4096;
const GEMINI_TIMEOUT_MS = 120_000;
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
// Resolve from this file so workspace scripts and direct Node starts load the
// same server/.env, independent of the caller's working directory.
const ENV_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../.env");

interface Config {
  geminiApiKey: string;
  proxyToken: string;
  port: number;
  allowedOrigin: string;
}

interface ImageInput { mimeType: string; data: string }
interface AnalyzeRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  responseSchema?: Record<string, unknown>;
  images?: ImageInput[];
  maxTokens?: number;
}

function loadEnv(): Record<string, string> {
  const values: Record<string, string> = {};
  try {
    for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match && !match[1].startsWith("#")) values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  } catch { /* A missing .env is reported safely by /health and requests. */ }
  return values;
}

function config(): Config {
  const env = { ...loadEnv(), ...process.env };
  return {
    geminiApiKey: env.GEMINI_API_KEY ?? "",
    proxyToken: env.PROXY_TOKEN ?? "",
    port: Number(env.PORT ?? 8787),
    allowedOrigin: env.ALLOWED_ORIGIN ?? "",
  };
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

function error(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

function authorized(req: IncomingMessage, cfg: Config): boolean {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  return Boolean(cfg.proxyToken) && token === cfg.proxyToken;
}

function corsAllowed(req: IncomingMessage, cfg: Config): boolean {
  const origin = req.headers.origin;
  return !origin || Boolean(cfg.allowedOrigin) && origin === cfg.allowedOrigin;
}

function applyCors(req: IncomingMessage, res: ServerResponse, cfg: Config): boolean {
  if (!corsAllowed(req, cfg)) { error(res, 403, "origin_forbidden", "This origin is not allowed to use the local proxy."); return false; }
  if (req.headers.origin && cfg.allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", cfg.allowedOrigin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  return true;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = Buffer.from(chunk);
    size += part.length;
    if (size > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(part);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("malformed_json"); }
}

function parseAnalyzeRequest(value: unknown): AnalyzeRequest | null {
  if (!value || typeof value !== "object") return null;
  const request = value as Partial<AnalyzeRequest>;
  if (typeof request.model !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(request.model)) return null;
  if (typeof request.systemPrompt !== "string" || request.systemPrompt.length > 100_000) return null;
  if (typeof request.userPrompt !== "string" || request.userPrompt.length > 100_000) return null;
  if (request.images && (!Array.isArray(request.images) || request.images.length > 4 || request.images.some((image) => !image || typeof image.mimeType !== "string" || typeof image.data !== "string" || image.data.length > 750_000))) return null;
  return request as AnalyzeRequest;
}

const requestTimes = new Map<string, number[]>();
function rateLimited(req: IncomingMessage): boolean {
  const key = req.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const kept = (requestTimes.get(key) ?? []).filter((at) => at > now - 60_000);
  if (kept.length >= MAX_REQUESTS_PER_MINUTE) { requestTimes.set(key, kept); return true; }
  kept.push(now); requestTimes.set(key, kept); return false;
}

function geminiBody(input: AnalyzeRequest): Record<string, unknown> {
  const parts: Array<Record<string, unknown>> = [{ text: input.userPrompt }];
  for (const image of input.images ?? []) parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
  const generationConfig: Record<string, unknown> = {
    temperature: 0,
    maxOutputTokens: Math.min(Math.max(input.maxTokens ?? CLOUD_MAX_OUTPUT_TOKENS, 1), CLOUD_MAX_OUTPUT_TOKENS),
  };
  // Gemini 3.8 structured output uses responseFormat.text, not the earlier
  // responseMimeType/responseSchema fields. This makes the JSON constraint
  // effective at the Gemini API boundary.
  if (input.responseSchema) {
    generationConfig.responseFormat = {
      text: {
        mimeType: "APPLICATION_JSON",
        schema: input.responseSchema,
      },
    };
  }
  return {
    systemInstruction: { parts: [{ text: input.systemPrompt }] },
    contents: [{ role: "user", parts }],
    generationConfig,
  };
}

async function callGemini(input: AnalyzeRequest, cfg: Config): Promise<{ status: number; payload: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  try {
    const response = await fetch(`${GEMINI_ENDPOINT}/${encodeURIComponent(input.model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": cfg.geminiApiKey },
      body: JSON.stringify(geminiBody(input)),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, payload };
  } catch (caught) {
    return { status: controller.signal.aborted ? 504 : 503, payload: { error: { message: "Cloud provider unavailable" } } };
  } finally { clearTimeout(timeout); }
}

function responseText(payload: unknown): string | null {
  const data = payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("");
  return text || null;
}

const server = createServer(async (req, res) => {
  const cfg = config();
  if (!applyCors(req, res, cfg)) return;
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (!authorized(req, cfg)) { error(res, 401, "unauthorized", "A valid local proxy token is required."); return; }
  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { ok: true, geminiConfigured: Boolean(cfg.geminiApiKey) }); return;
  }
  if (req.method !== "POST" || req.url !== "/v1/analyze") { error(res, 404, "not_found", "Endpoint not found."); return; }
  if (rateLimited(req)) { error(res, 429, "rate_limited", "Too many requests; try again in a minute."); return; }
  let body: unknown;
  try { body = await readJson(req); } catch (caught) {
    error(res, (caught as Error).message === "body_too_large" ? 413 : 400, (caught as Error).message, "Request body must be valid JSON within the size limit."); return;
  }
  const input = parseAnalyzeRequest(body);
  if (!input) { error(res, 400, "invalid_request", "Request fields are invalid or exceed limits."); return; }
  if (!cfg.geminiApiKey) { error(res, 503, "not_configured", "Gemini is not configured on the local proxy."); return; }
  const upstream = await callGemini(input, cfg);
  if (upstream.status !== 200) {
    const upstreamError = upstream.payload as { error?: { message?: string } };
    error(res, upstream.status === 429 ? 429 : upstream.status >= 500 ? 503 : upstream.status, "upstream_error", upstreamError.error?.message ?? "Cloud provider request failed."); return;
  }
  const text = responseText(upstream.payload);
  if (!text) { error(res, 422, "safety_block", "The cloud provider returned no usable content."); return; }
  if (!input.responseSchema) { sendJson(res, 200, { text, modelId: input.model }); return; }
  try { sendJson(res, 200, { data: JSON.parse(text), modelId: input.model }); } catch { error(res, 502, "malformed_upstream_json", "The cloud provider did not return valid structured JSON."); }
});

const cfg = config();
server.listen(cfg.port, "127.0.0.1", () => {
  // Safe operational event only: never include keys, tokens, or request bodies.
  console.log(`Adaptive Web Layer proxy listening on http://127.0.0.1:${cfg.port}`);
});
