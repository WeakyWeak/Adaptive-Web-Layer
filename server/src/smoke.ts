// Live check that each configured backend accepts our structured-output
// request shape. Run: npm run smoke --workspace=server
// It sends a tiny synthetic prompt only (no page data).

import { deflateSync } from "node:zlib";
import { loadConfig, type Config } from "./config.ts";
import { analyze, backendConfigured } from "./index.ts";
import { geminiSchemaField } from "./providers/gemini.ts";
import { translateWithSarvam } from "./providers/sarvam.ts";
import type { AnalyzeRequest, Backend } from "./providers/types.ts";

const MODELS: Record<Backend, string> = {
  gemini: process.env.SMOKE_GEMINI_MODEL ?? "gemini-3.5-flash-lite",
  anthropic: process.env.SMOKE_ANTHROPIC_MODEL ?? "claude-opus-5-5",
  openai: process.env.SMOKE_OPENAI_MODEL ?? "",
};
// The P10 reviewer reads screenshots: check image input on the review model too.
const VISION_MODELS: Record<Backend, string> = {
  gemini: process.env.SMOKE_GEMINI_REVIEW_MODEL ?? "gemini-3.5-flash",
  anthropic: MODELS.anthropic,
  openai: MODELS.openai,
};

/** A 64×32 PNG, red on the left half and blue on the right (no image library). */
function testPng(): string {
  const width = 64, height = 32;
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buffer: Buffer) => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = y * (width * 3 + 1) + 1 + x * 3;
    if (x < width / 2) rows[at] = 220; else rows[at + 2] = 220;
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

async function checkVision(backend: Backend, cfg: Config): Promise<boolean> {
  const colours = { type: "object", additionalProperties: false, required: ["left", "right"], properties: { left: { type: "string" }, right: { type: "string" } } };
  const started = Date.now();
  try {
    const result = await analyze({ backend, model: VISION_MODELS[backend], systemPrompt: "Reply with JSON only.", userPrompt: "Name the colour of the left half and of the right half of the image, one word each.", schema: colours, images: [{ mimeType: "image/png", data: testPng() }], maxTokens: 256 }, cfg);
    const data = result.data as { left?: string; right?: string } | undefined;
    const ok = /red/i.test(data?.left ?? "") && /blue/i.test(data?.right ?? "");
    console.log(`${ok ? "✓" : "✗"} ${backend} image input (${VISION_MODELS[backend]}): ${JSON.stringify(data)} in ${Date.now() - started} ms`);
    return ok;
  } catch (error) {
    console.log(`✗ ${backend} image input (${VISION_MODELS[backend]}): ${(error as Error).message}`);
    return false;
  }
}

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
  if (!backendConfigured(backend, cfg)) { console.log(`- ${backend}: skipped (not configured in server/.env)`); return true; }
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
    console.log(`${ok ? "✓" : "✗"} ${backend} (${MODELS[backend] || "env model"}): ${JSON.stringify(result.data)} in ${Date.now() - started} ms${extra}`);
    return ok && await checkVision(backend, cfg);
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

const results = [await check("gemini"), await check("anthropic"), await check("openai"), await checkSarvam()];
process.exit(results.every(Boolean) ? 0 : 1);
