// Live check that each configured backend accepts our structured-output
// request shape. Run: npm run smoke --workspace=server
// It sends a tiny synthetic prompt only (no page data).

import { loadConfig } from "./config.ts";
import { analyze } from "./index.ts";
import { geminiSchemaField } from "./providers/gemini.ts";
import type { AnalyzeRequest, Backend } from "./providers/types.ts";

const MODELS: Record<Backend, string> = {
  gemini: process.env.SMOKE_GEMINI_MODEL ?? "gemini-3.8-flash",
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

const results = [await check("gemini"), await check("anthropic")];
process.exit(results.every(Boolean) ? 0 : 1);
