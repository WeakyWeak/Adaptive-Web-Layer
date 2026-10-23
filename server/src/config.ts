import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve from this file so workspace scripts and direct Node starts load the
// same server/.env, independent of the caller's working directory.
const ENV_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../.env");

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Config {
  geminiApiKey: string;
  anthropicApiKey: string;
  anthropicEffort: Effort;
  sarvamApiKey: string;
  proxyToken: string;
  port: number;
  /** Exact origins allowed; empty means "any chrome-extension:// origin". */
  allowedOrigins: string[];
}

function loadEnvFile(): Record<string, string> {
  const values: Record<string, string> = {};
  try {
    for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  } catch { /* A missing .env is reported safely by /health and requests. */ }
  return values;
}

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export function loadConfig(): Config {
  const env: Record<string, string | undefined> = { ...loadEnvFile(), ...process.env };
  const placeholder = (value: string | undefined) => !value || value.startsWith("replace_with") || value.includes("your_extension_id");
  const effort = env.ANTHROPIC_EFFORT as Effort | undefined;
  return {
    geminiApiKey: placeholder(env.GEMINI_API_KEY) ? "" : env.GEMINI_API_KEY ?? "",
    // Real Anthropic keys start with "sk-ant-"; anything else is a leftover placeholder.
    anthropicApiKey: !placeholder(env.ANTHROPIC_API_KEY) && env.ANTHROPIC_API_KEY?.startsWith("sk-ant-") ? env.ANTHROPIC_API_KEY : "",
    anthropicEffort: effort && EFFORTS.includes(effort) ? effort : "low",
    sarvamApiKey: placeholder(env.SARVAM_API_KEY) ? "" : env.SARVAM_API_KEY ?? "",
    proxyToken: placeholder(env.PROXY_TOKEN) ? "" : env.PROXY_TOKEN ?? "",
    port: Number(env.PORT ?? 8787),
    allowedOrigins: placeholder(env.ALLOWED_ORIGIN) ? [] : (env.ALLOWED_ORIGIN ?? "").split(",").map((origin) => origin.trim()).filter(Boolean),
  };
}
