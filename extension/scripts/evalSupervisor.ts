// Supervisor eval (P10): does the reviewer catch a local draft's mistakes?
// Each case is a draft with planted mistakes (hid the table of contents, missed
// a consent banner with random class names, hid the article, unrequested
// colours, …) plus good drafts that should be approved untouched. Fidelity
// cases pair an original with a rewrite that dropped a number, flipped a
// negation, or kept every fact.
//
//   npm run eval:supervisor -- --target cloud --token <PROXY_TOKEN> [--model gemini-3.5-flash]
//   npm run eval:supervisor -- --target local [--endpoint http://127.0.0.1:8080]   (self-review baseline)
//   --delay <ms> between calls (default 2500 for cloud: the proxy allows 30 requests a minute)
//
// Text only (no screenshots). Writes a JSON report to eval/results/ (gitignored).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFidelitySystemPrompt, buildFidelityUserPrompt, buildReviewSystemPrompt, buildReviewUserPrompt } from "../src/background/reviewPrompt";
import { runValidated } from "../src/background/structured";
import { validateElements } from "../src/shared/elementPlan";
import { zodToJsonSchema } from "../src/shared/jsonSchema";
import { CloudProvider, LocalOpenAICompatProvider, type LLMProvider } from "../src/shared/llmProvider";
import { DomSnapshotSchema, toProviderError } from "../src/shared/plan";
import { applyReview, checkFidelity, draftItems, draftLedger, FidelityReplySchema, ReviewReplySchema, reviewJsonSchema } from "../src/shared/review";
import { defaultSettings } from "../src/shared/settings";
import { currentAiValues } from "../src/shared/sitePatch";

interface PageCase {
  id: string;
  snapshot: string;
  request: string;
  draft: { changes: Record<string, string | number | boolean>; hide: string[] };
  scores: [number, number];
  mustDrop?: Record<string, string>;
  mustAddAny?: Record<string, string[]>;
  mustNotAdd?: Record<string, string>;
  mustKeep?: string[];
  approve?: boolean;
}
interface FidelityCase { id: string; original: string; rewrite: string; expect: boolean }

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string, fallback?: string) => { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : fallback; };

function provider(): { llm: LLMProvider; label: string } {
  const ai = defaultSettings().ai;
  if (arg("target", "cloud") === "local") {
    const modelId = arg("model", ai.localModel)!;
    return { label: `local-${modelId}`, llm: new LocalOpenAICompatProvider({ endpoint: arg("endpoint", ai.localEndpoint)!, modelId, contextSize: Number(arg("ctx", "8192")), timeoutMs: 180_000 }) };
  }
  const modelId = arg("model", ai.reviewModel)!;
  return { label: `cloud-gemini-${modelId}`, llm: new CloudProvider({ proxyUrl: arg("proxy", ai.cloudProxyUrl)!, proxyToken: arg("token", process.env.PROXY_TOKEN ?? "")!, backend: "gemini", modelId, timeoutMs: 120_000 }) };
}

/** Pause between calls: the local proxy allows 30 requests a minute. */
const pause = () => new Promise((resolve) => setTimeout(resolve, Number(arg("delay", arg("target", "cloud") === "local" ? "0" : "2500"))));
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(p / 100 * values.length))] ?? 0;

async function main(): Promise<void> {
  const data = JSON.parse(readFileSync(join(root, "eval/supervisor.json"), "utf8")) as { snapshots: Record<string, unknown>; cases: PageCase[]; fidelity: FidelityCase[] };
  const { llm, label } = provider();
  const health = await llm.testConnection();
  if (!health.ok) { console.error(`Reviewer not reachable: ${health.error}`); process.exit(2); }
  console.log(`Evaluating reviewer ${label} on ${data.cases.length} drafts and ${data.fidelity.length} rewrites (text only)\n`);
  const current = currentAiValues(defaultSettings(), "localhost");
  const times: number[] = [];
  const promptChars: number[] = [];
  let planted = 0, caught = 0, falseAlarms = 0, approvals = 0, approvalCases = 0;
  const results: unknown[] = [];

  for (const testCase of data.cases) {
    const snapshot = DomSnapshotSchema.parse(data.snapshots[testCase.snapshot]);
    const items = validateElements({ hide: testCase.draft.hide, dim: [], highlight: [] }, snapshot).items;
    const draft = draftItems(testCase.draft.changes, items);
    const ledger = draftLedger(testCase.draft.changes, items, "local");
    const userPrompt = (errors: string[]) => buildReviewUserPrompt({
      request: testCase.request, current, draft, snapshot,
      before: { score: { value: testCase.scores[0], contributors: [] } },
      after: { score: { value: testCase.scores[1], contributors: [] }, findings: [] },
      screenshots: false,
    }, errors);
    await pause();
    const started = Date.now();
    try {
      promptChars.push(buildReviewSystemPrompt().length + userPrompt([]).length);
      const { reply } = await runValidated(llm, { systemPrompt: buildReviewSystemPrompt(), userPrompt, schema: ReviewReplySchema, jsonSchema: reviewJsonSchema(draft.map((item) => item.ref), snapshot.blocks.map((block) => block.id)), maxTokens: 4096 });
      times.push(Date.now() - started);
      const outcome = applyReview({ request: testCase.request, snapshot, current, changes: testCase.draft.changes, items, ledger, reply });
      const dropped = new Set(outcome.ledger.filter((entry) => entry.status === "dropped").map((entry) => entry.ref));
      const added = new Set([...outcome.ledger.filter((entry) => entry.status === "added").map((entry) => entry.ref), ...outcome.rejected.map((item) => item.id), ...reply.add.elements.hide]);
      const problems: string[] = [];
      for (const [ref, what] of Object.entries(testCase.mustDrop ?? {})) { planted++; if (dropped.has(ref)) caught++; else problems.push(`missed: should drop ${ref} (${what})`); }
      for (const [what, ids] of Object.entries(testCase.mustAddAny ?? {})) { planted++; if (ids.some((id) => added.has(id))) caught++; else problems.push(`missed: should add ${what}`); }
      for (const [id, what] of Object.entries(testCase.mustNotAdd ?? {})) if (added.has(id)) problems.push(`added ${id} (${what})`);
      for (const ref of testCase.mustKeep ?? []) if (dropped.has(ref)) { falseAlarms++; problems.push(`false alarm: dropped ${ref}`); }
      if (testCase.approve) { approvalCases++; if (reply.verdict === "approve" && dropped.size === 0) approvals++; else problems.push(`should approve, got ${reply.verdict} (dropped ${[...dropped].join(", ") || "nothing"})`); }
      results.push({ id: testCase.id, ok: problems.length === 0, ms: times.at(-1), verdict: reply.verdict, dropped: [...dropped], added: [...added], notes: reply.notes, problems });
      console.log(`${problems.length ? "✗" : "✓"} ${testCase.id.padEnd(26)} ${String(times.at(-1)).padStart(6)} ms ${reply.verdict.padEnd(8)} drop [${[...dropped].join(", ")}] add [${[...added].join(", ")}] ${problems.join("; ")}`);
    } catch (error) {
      const failure = toProviderError(error);
      planted += Object.keys(testCase.mustDrop ?? {}).length + Object.keys(testCase.mustAddAny ?? {}).length;
      if (testCase.approve) approvalCases++;
      results.push({ id: testCase.id, ok: false, error: `${failure.code}: ${failure.message}` });
      console.log(`✗ ${testCase.id.padEnd(26)} ${failure.code}: ${failure.message.slice(0, 120)}`);
    }
  }

  let fidelityCaught = 0, fidelityPlanted = 0, fidelityFalse = 0, codeCaught = 0, codeFalse = 0;
  for (const testCase of data.fidelity) {
    const checks = checkFidelity(testCase.original, testCase.rewrite);
    await pause();
    const started = Date.now();
    try {
      const { reply } = await runValidated(llm, {
        systemPrompt: buildFidelitySystemPrompt(),
        userPrompt: (errors) => buildFidelityUserPrompt(testCase.original, testCase.rewrite, checks, errors),
        schema: FidelityReplySchema,
        jsonSchema: zodToJsonSchema(FidelityReplySchema),
        maxTokens: 2048,
      });
      times.push(Date.now() - started);
      const found = reply.issues.length > 0;
      if (testCase.expect) { fidelityPlanted++; if (found) fidelityCaught++; if (checks.length) codeCaught++; }
      else { if (found) fidelityFalse++; if (checks.length) codeFalse++; }
      const ok = found === testCase.expect;
      results.push({ id: testCase.id, ok, code: checks.map((issue) => issue.problem), model: reply.issues });
      console.log(`${ok ? "✓" : "✗"} ${testCase.id.padEnd(26)} ${String(times.at(-1)).padStart(6)} ms code [${checks.map((issue) => issue.problem).join(", ")}] model [${reply.issues.map((issue) => issue.problem).join(", ")}]`);
    } catch (error) {
      if (testCase.expect) fidelityPlanted++;
      const failure = toProviderError(error);
      results.push({ id: testCase.id, ok: false, error: `${failure.code}: ${failure.message}` });
      console.log(`✗ ${testCase.id.padEnd(26)} ${failure.code}: ${failure.message.slice(0, 120)}`);
    }
  }

  const faithful = data.fidelity.filter((item) => !item.expect).length;
  const summary = {
    label,
    model: health.modelId,
    drafts: data.cases.length,
    catchRate: planted ? caught / planted : 1,
    caught, planted,
    falseAlarms,
    approvals: `${approvals}/${approvalCases}`,
    fidelityCatchRate: fidelityPlanted ? fidelityCaught / fidelityPlanted : 1,
    fidelityFalseAlarms: `${fidelityFalse}/${faithful}`,
    codeCheckCatchRate: fidelityPlanted ? codeCaught / fidelityPlanted : 1,
    codeCheckFalseAlarms: `${codeFalse}/${faithful}`,
    p50ms: percentile(times, 50),
    p95ms: percentile(times, 95),
    approxInputTokensPerReview: Math.round(promptChars.reduce((sum, value) => sum + value, 0) / Math.max(1, promptChars.length) / 4),
  };
  console.log(`\nmistakes caught ${caught}/${planted} (${(summary.catchRate * 100).toFixed(0)}%) · false alarms ${falseAlarms} · good drafts approved ${summary.approvals} · p50 ${summary.p50ms} ms · ~${summary.approxInputTokensPerReview} input tokens per review`);
  console.log(`rewrites: model caught ${fidelityCaught}/${fidelityPlanted}, false alarms ${summary.fidelityFalseAlarms} · code check caught ${codeCaught}/${fidelityPlanted}, false alarms ${summary.codeCheckFalseAlarms}`);
  const outDir = join(root, "eval/results");
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-supervisor-${label.replace(/[^\w.-]+/g, "_")}.json`);
  writeFileSync(file, JSON.stringify({ summary, results }, null, 2));
  console.log(`Report: ${file}`);
}

void main();
