// Live check that each configured backend accepts our structured-output
// request shape. Run: npm run smoke --workspace=server
// It sends a tiny synthetic prompt only (no page data).

import { loadConfig } from "./config.ts";
import { analyze } from "./index.ts";
import { geminiSchemaField } from "./providers/gemini.ts";
import { translateWithSarvam } from "./providers/sarvam.ts";
import type { AnalyzeRequest, Backend } from "./providers/types.ts";

const MODELS: Record<Backend, string> = {
  gemini: process.env.SMOKE_GEMINI_MODEL ?? "gemini-3.5-flash-lite",
  anthropic: process.env.SMOKE_ANTHROPIC_MODEL ?? "claude-opus-5-5",
};

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["fontSize", "theme"],
  properties: {
    fontSize: { type: "number" },
    theme: { type: "string", enum: ["light", "dark", "sepia"] },
  },
};

async function check(backend: Backend): Promise<boolean> {
  const cfg = loadConfig();
  const key = backend === "anthropic" ? cfg.anthropicApiKey : cfg.geminiApiKey;
  if (!key) { console.log(`- ${backend}: skipped (no API key in server/.env)`); return true; }
  const input: AnalyzeRequest = {
    backend,
    model: MODELS[backend],
    systemPrompt: "Reply with JSON only.",
    userPrompt: "The reader wants 20px text and a dark theme.",
    schema,
    schemaFallback: { ...schema, additionalProperties: undefined },
    maxTokens: 512,
  };
  const started = Date.now();
  try {
    const result = await analyze(input, cfg);
    const data = result.data as { fontSize?: unknown; theme?: unknown } | undefined;
    const ok = typeof data?.fontSize === "number" && typeof data.theme === "string";
    const extra = backend === "gemini" ? `, schema field: ${geminiSchemaField()}` : "";
    console.log(`${ok ? "✓" : "✗"} ${backend} (${MODELS[backend]}): ${JSON.stringify(result.data)} in ${Date.now() - started} ms${extra}`);
    return ok;
  } catch (error) {
    console.log(`✗ ${backend} (${MODELS[backend]}): ${(error as Error).message}`);
    return false;
  }
}

async function checkSarvam(): Promise<boolean> {
  const cfg = loadConfig();
  if (!cfg.sarvamApiKey) { console.log("- sarvam: skipped (no SARVAM_API_KEY in server/.env)"); return true; }
  const started = Date.now();
  try {
    // A fixed synthetic sentence; the placeholder must survive translation.
    const result = await translateWithSarvam({ text: "Open the settings page and copy [[1]] into the box.", source: "en-IN", target: "hi-IN" }, cfg.sarvamApiKey);
    const ok = /[\u0900-\u097F]/.test(result.text);
    console.log(`${ok ? "✓" : "✗"} sarvam (${result.modelId}): ${result.text} in ${Date.now() - started} ms; placeholder ${result.text.includes("[[1]]") ? "kept" : "NOT kept"}`);
    return ok;
  } catch (error) {
    console.log(`✗ sarvam: ${(error as Error).message}`);
    return false;
  }
}

const results = [await check("gemini"), await check("anthropic"), await checkSarvam()];
process.exit(results.every(Boolean) ? 0 : 1);
