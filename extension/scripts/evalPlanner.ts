// Planner eval: runs the real planner + provider against eval/cases.json and
// scores valid-plan rate, expectation accuracy, injection safety, latency and
// (P07) element precision/recall for hide plans.
//
//   npm run eval:planner -- --target local [--endpoint http://127.0.0.1:8080] [--model id]
//   npm run eval:planner -- --target cloud --backend gemini|anthropic --token <PROXY_TOKEN> [--model id]
//
// Writes a JSON report to eval/results/ (gitignored).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runPlanner } from "../src/background/planner";
import type { ElementReview } from "../src/shared/elementPlan";
import { CloudProvider, LocalOpenAICompatProvider, type LLMProvider } from "../src/shared/llmProvider";
import { DomSnapshotSchema, toProviderError, type DomSnapshot } from "../src/shared/plan";
import { defaultSettings } from "../src/shared/settings";
import { currentAiValues } from "../src/shared/sitePatch";

type Value = string | number | boolean;
interface EvalCase {
  id: string;
  snapshot: string;
  request: string;
  current?: Record<string, Value>;
  expect?: Record<string, Value | Value[] | ">" | "<">;
  absent?: string[];
  expectAny?: string[];
  maxValue?: Record<string, number>;
  /** Ids that must be hidden (id → what it is). */
  expectHide?: Record<string, string>;
  /** Ids that may be hidden without counting against precision. */
  allowHide?: string[];
  /** Ids that must not be hidden (id → why). */
  mustKeep?: Record<string, string>;
  expectDim?: string[];
  expectHighlight?: string[];
  /** The plan must not touch any element. */
  noElements?: boolean;
}
type ElementLists = Record<"hide" | "dim" | "highlight", string[]>;
interface CaseResult { id: string; ok: boolean; valid: boolean; ms: number; retried: boolean; changes?: Record<string, Value>; elements?: ElementLists; problems: string[]; hits?: number; predicted?: number; expected?: number }

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function provider(): { provider: LLMProvider; label: string } {
  const target = arg("target", "local");
  const ai = defaultSettings().ai;
  if (target === "cloud") {
    const backend = arg("backend", "gemini") === "anthropic" ? "anthropic" : "gemini";
    const modelId = arg("model", backend === "anthropic" ? ai.anthropicModel : ai.cloudModel)!;
    return {
      label: `cloud-${backend}-${modelId}`,
      provider: new CloudProvider({ proxyUrl: arg("proxy", ai.cloudProxyUrl)!, proxyToken: arg("token", process.env.PROXY_TOKEN ?? "")!, backend, modelId, timeoutMs: 120_000 }),
    };
  }
  const modelId = arg("model", ai.localModel)!;
  return {
    label: `local-${modelId}`,
    provider: new LocalOpenAICompatProvider({ endpoint: arg("endpoint", ai.localEndpoint)!, modelId, contextSize: Number(arg("ctx", "8192")), timeoutMs: 120_000 }),
  };
}

/** Every id the model asked for (accepted or rejected by the validator), per action. */
function requested(review: ElementReview): ElementLists {
  const lists: ElementLists = { hide: [], dim: [], highlight: [] };
  for (const item of [...review.items, ...review.rejected]) if (!lists[item.action].includes(item.id)) lists[item.action].push(item.id);
  return lists;
}

/** Hide precision/recall counts; allowed ids are neither hits nor misses. */
function scoreHide(testCase: EvalCase, elements: ElementLists): { hits: number; predicted: number; expected: number } {
  const expected = Object.keys(testCase.expectHide ?? {});
  const counted = elements.hide.filter((id) => !(testCase.allowHide ?? []).includes(id));
  return { hits: counted.filter((id) => expected.includes(id)).length, predicted: counted.length, expected: expected.length };
}

function checkElements(testCase: EvalCase, elements: ElementLists): string[] {
  const problems: string[] = [];
  for (const [id, what] of Object.entries(testCase.expectHide ?? {})) if (!elements.hide.includes(id)) problems.push(`missed ${id} (${what})`);
  for (const [id, why] of Object.entries(testCase.mustKeep ?? {})) if (elements.hide.includes(id)) problems.push(`hid ${id}: ${why}`);
  for (const id of testCase.expectDim ?? []) if (!elements.dim.includes(id)) problems.push(`did not dim ${id}`);
  for (const id of testCase.expectHighlight ?? []) if (!elements.highlight.includes(id)) problems.push(`did not highlight ${id}`);
  if (testCase.noElements && elements.hide.length + elements.dim.length + elements.highlight.length > 0) problems.push(`touched elements: ${JSON.stringify(elements)}`);
  return problems;
}

function check(testCase: EvalCase, current: Record<string, Value>, changes: Record<string, Value>): string[] {
  const problems: string[] = [];
  for (const [key, want] of Object.entries(testCase.expect ?? {})) {
    const got = changes[key];
    const ok = want === ">" ? typeof got === "number" && got > Number(current[key])
      : want === "<" ? typeof got === "number" && got < Number(current[key])
      : Array.isArray(want) ? want.includes(got as Value)
      : got === want;
    if (!ok) problems.push(`${key}: wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
  for (const key of testCase.absent ?? []) if (key in changes) problems.push(`${key} should not change (got ${JSON.stringify(changes[key])})`);
  if (testCase.expectAny && !testCase.expectAny.some((key) => key in changes)) problems.push(`expected one of ${testCase.expectAny.join(", ")}`);
  for (const [key, max] of Object.entries(testCase.maxValue ?? {})) if (Number(changes[key]) > max) problems.push(`${key} above ${max} (injection?)`);
  return problems;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

async function main(): Promise<void> {
  const data = JSON.parse(readFileSync(join(root, "eval/cases.json"), "utf8")) as { snapshots: Record<string, unknown>; cases: EvalCase[] };
  const only = arg("only");
  const cases = data.cases.filter((item) => !only || item.id === only);
  const { provider: llm, label } = provider();
  const health = await llm.testConnection();
  if (!health.ok) { console.error(`Provider not reachable: ${health.error}`); process.exit(2); }
  console.log(`Evaluating ${label} (${health.modelId ?? "?"}) on ${cases.length} cases\n`);

  const results: CaseResult[] = [];
  for (const testCase of cases) {
    const snapshot: DomSnapshot = DomSnapshotSchema.parse(data.snapshots[testCase.snapshot]);
    const current = { ...currentAiValues(defaultSettings(), "localhost"), ...testCase.current };
    const started = Date.now();
    try {
      const result = await runPlanner(llm, { request: testCase.request, snapshot, current });
      const elements = requested(result.elements);
      const problems = [...check(testCase, current, result.changes), ...checkElements(testCase, elements)];
      const score = testCase.expectHide ? scoreHide(testCase, elements) : {};
      results.push({ id: testCase.id, ok: problems.length === 0, valid: true, ms: Date.now() - started, retried: result.retried, changes: result.changes, elements, problems, ...score });
    } catch (error) {
      const failure = toProviderError(error);
      results.push({ id: testCase.id, ok: false, valid: false, ms: Date.now() - started, retried: false, problems: [`${failure.code}: ${failure.message.slice(0, 160)}`] });
    }
    const last = results[results.length - 1];
    const touched = last.elements && Object.values(last.elements).some((ids) => ids.length) ? ` ${JSON.stringify(last.elements)}` : "";
    console.log(`${last.ok ? "✓" : "✗"} ${testCase.id.padEnd(20)} ${String(last.ms).padStart(6)} ms ${last.retried ? "(retried) " : ""}${JSON.stringify(last.changes ?? {})}${touched} ${last.problems.join("; ")}`);
  }

  const times = results.map((item) => item.ms);
  const scored = results.filter((item) => item.expected !== undefined);
  const sum = (key: "hits" | "predicted" | "expected") => scored.reduce((total, item) => total + (item[key] ?? 0), 0);
  const summary = {
    label,
    model: health.modelId,
    cases: results.length,
    validPlanRate: results.filter((item) => item.valid).length / results.length,
    accuracy: results.filter((item) => item.ok).length / results.length,
    retries: results.filter((item) => item.retried).length,
    injectionFailures: results.filter((item) => item.id.startsWith("injection") && !item.ok).map((item) => item.id),
    p50ms: percentile(times, 50),
    p95ms: percentile(times, 95),
    elementCases: scored.length,
    elementPrecision: sum("predicted") ? sum("hits") / sum("predicted") : 1,
    elementRecall: sum("expected") ? sum("hits") / sum("expected") : 1,
  };
  console.log(`\nvalid plans ${(summary.validPlanRate * 100).toFixed(0)}% · accuracy ${(summary.accuracy * 100).toFixed(0)}% · retries ${summary.retries} · p50 ${summary.p50ms} ms · p95 ${summary.p95ms} ms · injection failures: ${summary.injectionFailures.join(", ") || "none"}`);
  if (scored.length) console.log(`elements (${scored.length} cases): precision ${summary.elementPrecision.toFixed(2)} · recall ${summary.elementRecall.toFixed(2)}`);

  const outDir = join(root, "eval/results");
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${label.replace(/[^\w.-]+/g, "_")}.json`);
  writeFileSync(file, JSON.stringify({ summary, results }, null, 2));
  console.log(`Report: ${file}`);
}

void main();
