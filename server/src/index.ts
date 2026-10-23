import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { loadConfig, type Config } from "./config.ts";
import { analyzeWithAnthropic } from "./providers/anthropic.ts";
import { analyzeWithGemini } from "./providers/gemini.ts";
import { parseTranslateRequest, translateWithSarvam } from "./providers/sarvam.ts";
import { UpstreamError, MAX_OUTPUT_TOKENS, type AnalyzeRequest, type AnalyzeResult } from "./providers/types.ts";

const MAX_BODY_BYTES = 1_000_000;
const MAX_REQUESTS_PER_MINUTE = 30;
// The extension's service worker must receive bytes regularly while a model
// thinks; a ping line every few seconds keeps its fetch and lifetime alive.
const PING_MS = 5_000;

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

/**
 * Web pages can never send a chrome-extension:// Origin, so allowing extension
 * origins blocks every website; ALLOWED_ORIGIN can pin one extension id.
 * Requests without an Origin (curl, the smoke test) rely on the bearer token.
 */
export function originAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) return true;
  if (allowedOrigins.length > 0) return allowedOrigins.includes(origin);
  return origin.startsWith("chrome-extension://");
}

function applyCors(req: IncomingMessage, res: ServerResponse, cfg: Config): boolean {
  const origin = req.headers.origin;
  if (!originAllowed(origin, cfg.allowedOrigins)) { error(res, 403, "origin_forbidden", "This origin is not allowed to use the local proxy."); return false; }
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
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

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function parseAnalyzeRequest(value: unknown): AnalyzeRequest | null {
  if (!isObject(value)) return null;
  const backend = value.backend ?? "gemini";
  if (backend !== "gemini" && backend !== "anthropic") return null;
  if (typeof value.model !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value.model)) return null;
  if (typeof value.systemPrompt !== "string" || value.systemPrompt.length > 100_000) return null;
  if (typeof value.userPrompt !== "string" || value.userPrompt.length > 100_000) return null;
  if (value.schema !== undefined && !isObject(value.schema)) return null;
  if (value.schemaFallback !== undefined && !isObject(value.schemaFallback)) return null;
  const images = value.images;
  if (images !== undefined && (!Array.isArray(images) || images.length > 4 || images.some((image) => !isObject(image) || !/^image\/(png|jpeg|webp)$/.test(String(image.mimeType)) || typeof image.data !== "string" || image.data.length > 750_000))) return null;
  return {
    backend,
    model: value.model,
    systemPrompt: value.systemPrompt,
    userPrompt: value.userPrompt,
    schema: value.schema as Record<string, unknown> | undefined,
    schemaFallback: value.schemaFallback as Record<string, unknown> | undefined,
    images: images as AnalyzeRequest["images"],
    maxTokens: typeof value.maxTokens === "number" ? value.maxTokens : MAX_OUTPUT_TOKENS,
  };
}

const requestTimes = new Map<string, number[]>();
function rateLimited(req: IncomingMessage): boolean {
  const key = req.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const kept = (requestTimes.get(key) ?? []).filter((at) => at > now - 60_000);
  if (kept.length >= MAX_REQUESTS_PER_MINUTE) { requestTimes.set(key, kept); return true; }
  kept.push(now); requestTimes.set(key, kept); return false;
}

export function analyze(input: AnalyzeRequest, cfg: Config): Promise<AnalyzeResult> {
  return input.backend === "anthropic"
    ? analyzeWithAnthropic(input, cfg.anthropicApiKey, cfg.anthropicEffort)
    : analyzeWithGemini(input, cfg.geminiApiKey);
}

/** Streams NDJSON: ping lines while waiting, then exactly one result or error line. */
async function streamAnalysis(res: ServerResponse, input: AnalyzeRequest, cfg: Config): Promise<void> {
  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
  const write = (line: unknown) => { if (!res.writableEnded) res.write(`${JSON.stringify(line)}\n`); };
  write({ type: "ping" });
  const ping = setInterval(() => write({ type: "ping" }), PING_MS);
  try {
    const result = await analyze(input, cfg);
    write({ type: "result", ...result });
  } catch (caught) {
    const failure = caught instanceof UpstreamError ? caught : new UpstreamError(500, "upstream_error", "Cloud provider request failed.");
    write({ type: "error", status: failure.status, code: failure.code, message: failure.message });
  } finally {
    clearInterval(ping);
    res.end();
  }
}

/** Short calls (one ≤ 2000-character chunk), so a plain JSON reply is enough. */
export async function handleTranslate(res: ServerResponse, body: unknown, cfg: Config, fetchImpl: typeof fetch = fetch): Promise<void> {
  const input = parseTranslateRequest(body);
  if (!input) { error(res, 400, "invalid_request", "Translation needs text (1–2000 characters) and a supported language pair."); return; }
  if (!cfg.sarvamApiKey) { error(res, 503, "not_configured", "SARVAM_API_KEY is not set in server/.env."); return; }
  try {
    sendJson(res, 200, await translateWithSarvam(input, cfg.sarvamApiKey, fetchImpl));
  } catch (caught) {
    const failure = caught instanceof UpstreamError ? caught : new UpstreamError(502, "translate_failed", "Translation failed.");
    error(res, failure.status, failure.code, failure.message);
  }
}

const server = createServer(async (req, res) => {
  const cfg = loadConfig();
  if (!applyCors(req, res, cfg)) return;
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (!authorized(req, cfg)) {
    error(res, 401, "unauthorized", cfg.proxyToken ? "A valid local proxy token is required." : "Set PROXY_TOKEN in server/.env first.");
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { ok: true, backends: { gemini: Boolean(cfg.geminiApiKey), anthropic: Boolean(cfg.anthropicApiKey), sarvam: Boolean(cfg.sarvamApiKey) } });
    return;
  }
  if (req.method !== "POST" || (req.url !== "/v1/analyze" && req.url !== "/v1/translate")) { error(res, 404, "not_found", "Endpoint not found."); return; }
  if (rateLimited(req)) { error(res, 429, "rate_limited", "Too many requests; try again in a minute."); return; }
  let body: unknown;
  try { body = await readJson(req); } catch (caught) {
    const code = (caught as Error).message;
    error(res, code === "body_too_large" ? 413 : 400, code, "Request body must be valid JSON within the size limit.");
    return;
  }
  if (req.url === "/v1/translate") { await handleTranslate(res, body, cfg); return; }
  const input = parseAnalyzeRequest(body);
  if (!input) { error(res, 400, "invalid_request", "Request fields are invalid or exceed limits."); return; }
  const configured = input.backend === "anthropic" ? cfg.anthropicApiKey : cfg.geminiApiKey;
  if (!configured) {
    error(res, 503, "not_configured", `${input.backend === "anthropic" ? "ANTHROPIC_API_KEY" : "GEMINI_API_KEY"} is not set in server/.env.`);
    return;
  }
  await streamAnalysis(res, input, cfg);
});

// Only listen when run directly (tests import the helpers above).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = loadConfig();
  server.listen(cfg.port, "127.0.0.1", () => {
    // Safe operational event only: never include keys, tokens, or request bodies.
    const backends = [cfg.geminiApiKey && "gemini", cfg.anthropicApiKey && "anthropic", cfg.sarvamApiKey && "sarvam"].filter(Boolean).join(", ") || "none";
    console.log(`Adaptive Web Layer proxy listening on http://127.0.0.1:${cfg.port} (backends: ${backends})`);
    if (!cfg.proxyToken) console.warn("PROXY_TOKEN is not set in server/.env; every request will be rejected.");
  });
}
