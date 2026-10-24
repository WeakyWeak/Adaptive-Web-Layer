// "Profile from a description" eval (P11): runs the real prompt + checks
// against eval/describe.json and scores valid replies, expected settings and
// aids, removed overclaiming notes, and latency.
//
//   npm run eval:describe -- --target local [--endpoint http://127.0.0.1:8080]
//   npm run eval:describe -- --target cloud --backend gemini --token <PROXY_TOKEN>
//
// Writes a JSON report to eval/results/ (gitignored).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeWithModel } from "../src/background/describeModel";
import { overclaims } from "../src/shared/describe";
import { CloudProvider, LocalOpenAICompatProvider, type LLMProvider } from "../src/shared/llmProvider";
import { toProviderError } from "../src/shared/plan";
import { defaultSettings, type ReadingAids } from "../src/shared/settings";
import { currentAiValues } from "../src/shared/sitePatch";

type Value = string | number | boolean;
interface EvalCase {
  id: string;
  description: string;
  expect?: Record<string, Value | Value[] | ">" | "<">;
  expectAny?: string[];
  absent?: string[];
  aids?: Partial<ReadingAids>;
  aidsAny?: Array<keyof ReadingAids>;
  lens?: boolean;
  maxValue?: Record<string, number>;
  maxChanges?: number;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string, fallback?: string) => { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : fallback; };

function provider(): { provider: LLMProvider; label: string } {
  const ai = defaultSettings().ai;
  if (arg("target", "local") === "cloud") {
    const backend = arg("backend", "gemini") === "anthropic" ? "anthropic" : "gemini";
    const modelId = arg("model", backend === "anthropic" ? ai.anthropicModel : ai.cloudModel)!;
    return { label: `cloud-${backend}-${modelId}`, provider: new CloudProvider({ proxyUrl: arg("proxy", ai.cloudProxyUrl)!, proxyToken: arg("token", process.env.PROXY_TOKEN ?? "")!, backend, modelId, timeoutMs: 120_000 }) };
  }
  const modelId = arg("model", ai.localModel)!;
  return { label: `local-${modelId}`, provider: new LocalOpenAICompatProvider({ endpoint: arg("endpoint", ai.localEndpoint)!, modelId, contextSize: Number(arg("ctx", "8192")), timeoutMs: 120_000 }) };
}

function check(testCase: EvalCase, current: Record<string, Value>, changes: Record<string, Value>, aids: ReadingAids, lens: boolean): string[] {
  const problems: string[] = [];
  for (const [key, want] of Object.entries(testCase.expect ?? {})) {
    const got = changes[key];
    const ok = want === ">" ? typeof got === "number" && got > Number(current[key]) : want === "<" ? typeof got === "number" && got < Number(current[key]) : Array.isArray(want) ? want.includes(got as Value) : got === want;
    if (!ok) problems.push(`${key}: wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
  if (testCase.expectAny && !testCase.expectAny.some((key) => key in changes)) problems.push(`expected one of ${testCase.expectAny.join(", ")}`);
  for (const key of testCase.absent ?? []) if (key in changes) problems.push(`${key} should not change`);
  for (const [key, want] of Object.entries(testCase.aids ?? {})) if (aids[key as keyof ReadingAids] !== want) problems.push(`aids.${key}: wanted ${want}`);
  if (testCase.aidsAny && !testCase.aidsAny.some((key) => aids[key])) problems.push(`expected one of aids ${testCase.aidsAny.join(", ")}`);
  if (testCase.lens !== undefined && lens !== testCase.lens) problems.push(`lens: wanted ${testCase.lens}`);
  for (const [key, max] of Object.entries(testCase.maxValue ?? {})) if (Number(changes[key]) > max) problems.push(`${key} above ${max}`);
  if (testCase.maxChanges !== undefined && Object.keys(changes).length > testCase.maxChanges) problems.push(`${Object.keys(changes).length} changes (max ${testCase.maxChanges})`);
  return problems;
}

async function main(): Promise<void> {
  const { cases } = JSON.parse(readFileSync(join(root, "eval/describe.json"), "utf8")) as { cases: EvalCase[] };
  const { provider: llm, label } = provider();
  const health = await llm.testConnection();
  if (!health.ok) { console.error(`Provider not reachable: ${health.error}`); process.exit(2); }
  console.log(`Evaluating describeMe on ${label} (${health.modelId ?? "?"}), ${cases.length} cases\n`);
  const current = currentAiValues(defaultSettings(), "localhost");
  const results: Array<{ id: string; ok: boolean; valid: boolean; ms: number; overclaimsRemoved: number; changes?: Record<string, Value>; problems: string[] }> = [];
  for (const testCase of cases) {
    const started = Date.now();
    try {
      const result = await describeWithModel(llm, testCase.description, current);
      const removed = result.warnings.some((warning) => warning.includes("promised more")) ? 1 : 0;
      const problems = check(testCase, current, result.changes, result.reply.aids, result.reply.lens);
      if (result.reply.notes.some(overclaims)) problems.push("an overclaiming note got through");
      results.push({ id: testCase.id, ok: problems.length === 0, valid: true, ms: Date.now() - started, overclaimsRemoved: removed, changes: result.changes, problems });
    } catch (error) {
      const failure = toProviderError(error);
      results.push({ id: testCase.id, ok: false, valid: false, ms: Date.now() - started, overclaimsRemoved: 0, problems: [`${failure.code}: ${failure.message.slice(0, 160)}`] });
    }
    const last = results[results.length - 1];
    console.log(`${last.ok ? "✓" : "✗"} ${testCase.id.padEnd(16)} ${String(last.ms).padStart(6)} ms ${JSON.stringify(last.changes ?? {})} ${last.problems.join("; ")}`);
  }
  const times = results.map((item) => item.ms).sort((a, b) => a - b);
  const summary = {
    label, model: health.modelId, cases: results.length,
    validRate: results.filter((item) => item.valid).length / results.length,
    accuracy: results.filter((item) => item.ok).length / results.length,
    overclaimsRemoved: results.reduce((total, item) => total + item.overclaimsRemoved, 0),
    p50ms: times[Math.floor(times.length / 2)] ?? 0,
    p95ms: times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] ?? 0,
  };
  console.log(`\nvalid ${(summary.validRate * 100).toFixed(0)}% · accuracy ${(summary.accuracy * 100).toFixed(0)}% · overclaiming replies cleaned ${summary.overclaimsRemoved} · p50 ${summary.p50ms} ms · p95 ${summary.p95ms} ms`);
  const outDir = join(root, "eval/results");
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-describe-${label.replace(/[^\w.-]+/g, "_")}.json`);
  writeFileSync(file, JSON.stringify({ summary, results }, null, 2));
  console.log(`Report: ${file}`);
}

void main();
