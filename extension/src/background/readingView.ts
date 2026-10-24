// ─── Dyslexia reading view (P11) ─────────────────────────────────────────────
// The P10 roles on text: the local model drafts a rewrite of the main text
// (short paragraphs, lists, split sentences), code checks every part for
// changed numbers, names and negations, and the cloud reviews the flagged
// parts plus a sample (only with page-text consent). The result is shown
// over the page; the page's own text is never changed, so the original is
// one click away. Code, links and identifiers are masked placeholders.

import { chunkText } from "../shared/chunk";
import { ReadingViewResultSchema, type ReadingBlock, type ReadingViewResult } from "../shared/comprehension";
import { cacheKey, readCache, writeCache } from "../shared/comprehensionCache";
import { ProviderError, toProviderError } from "../shared/plan";
import { checkFidelity, chunksToReview, type FidelityIssue } from "../shared/review";
import { mask, stripCodeMarks, unmask } from "../shared/textMask";
import { fidelityNotes, registerPageRunner, summarize, type PageJob } from "./comprehension";
import { runComprehension } from "./comprehensionModel";
import { tell } from "./tabs";

/** Characters of (masked) text per draft call: the rewrite comes back about as long. */
export const READING_CHUNK_CHARS = 2400;
export const MAX_READING_PARTS = 6;
const MAX_SENTENCES = 3;

const sentencesOf = (text: string) => text.split(/(?<=[.!?]["”’)]?)\s+(?=["“‘(]?[A-Z0-9])/).filter((sentence) => sentence.trim());

/** Paragraphs of more than three sentences are split by code (the model sometimes runs on). */
export function shortParagraphs(blocks: readonly ReadingBlock[]): ReadingBlock[] {
  return blocks.flatMap((block) => {
    const text = block.text.trim();
    if (block.kind === "list") {
      const items = block.items.map((item) => item.trim()).filter(Boolean);
      return items.length ? [{ kind: "list" as const, text, items }] : text ? [{ kind: "paragraph" as const, text, items: [] }] : [];
    }
    if (!text) return [];
    if (block.kind === "heading") return [{ ...block, text, items: [] }];
    const sentences = sentencesOf(text);
    const parts: ReadingBlock[] = [];
    for (let start = 0; start < sentences.length; start += MAX_SENTENCES) parts.push({ kind: "paragraph", text: sentences.slice(start, start + MAX_SENTENCES).join(" "), items: [] });
    return parts;
  });
}

const blockText = (blocks: readonly ReadingBlock[]) => blocks.map((block) => [block.text, ...block.items].filter(Boolean).join("\n")).join("\n\n");

/** Put code, links and identifiers back into a part's blocks. */
function restore(blocks: readonly ReadingBlock[], tokens: readonly string[]): ReadingBlock[] {
  const put = (text: string) => unmask(text, tokens).text;
  return blocks.map((block) => ({ ...block, text: put(block.text), items: block.items.map(put) }));
}

/** Placeholders of `chunk` the rewrite dropped. */
const droppedPlaceholders = (chunk: string, rewrite: string) => [...new Set(chunk.match(/\[\[\d+\]\]/g) ?? [])].filter((placeholder) => !rewrite.includes(placeholder)).length;

/** Demo mode: code splits the text into short paragraphs; no rewrite. */
function demoView(plain: string): ReadingViewResult {
  const paragraphs = plain.split(/\n+/).map((paragraph) => paragraph.trim()).filter((paragraph) => paragraph.split(/\s+/).length >= 4);
  const blocks = shortParagraphs(paragraphs.map((text) => ({ kind: "paragraph", text, items: [] })));
  return {
    summary: paragraphs.slice(0, 3).map((paragraph) => sentencesOf(paragraph)[0] ?? paragraph),
    blocks, coverage: 1, shown: true, source: "demo", cached: false,
    checks: { flagged: 0, parts: 1, review: "not-allowed", reviewedParts: 0, issues: 0 },
    notes: ["Demo mode: the text split into short paragraphs by code, not rewritten by AI. The summary is the first sentences."],
  };
}

export async function buildReadingView(job: Pick<PageJob, "runner" | "text" | "title" | "stage">): Promise<ReadingViewResult> {
  const { runner, title, stage } = job;
  const plain = stripCodeMarks(job.text);
  if (!runner.router) return demoView(plain);
  const masked = mask(job.text);
  const chunks = chunkText(masked.text, READING_CHUNK_CHARS);
  const used = chunks.slice(0, MAX_READING_PARTS);
  const notes: string[] = [];

  // Draft: the routed model rewrites each part.
  const parts: Array<{ blocks: ReadingBlock[]; maskedRewrite: string; checks: FidelityIssue[] }> = [];
  let lost = 0;
  for (const [index, chunk] of used.entries()) {
    await stage(used.length > 1 ? `Drafting part ${index + 1} of ${used.length}` : "Drafting the reading view");
    const { reply } = await runComprehension(runner.router, "readingView", { text: chunk, title }, { signal: runner.signal });
    const shaped = shortParagraphs(reply.blocks);
    const maskedRewrite = blockText(shaped);
    lost += droppedPlaceholders(chunk, maskedRewrite);
    const blocks = restore(shaped, masked.tokens);
    // Check: code compares each part with its original.
    parts.push({ blocks, maskedRewrite, checks: checkFidelity(stripCodeMarks(unmask(chunk, masked.tokens).text), blockText(blocks)) });
  }
  if (lost > 0) notes.push(`${lost} piece(s) of code or link text could not be placed; see the original.`);

  // Review: flagged parts plus a sample, by the cloud, when page text may go there.
  const flagged = parts.map((part, index) => (part.checks.length ? index : -1)).filter((index) => index >= 0);
  let cloud: FidelityIssue[] | null = null;
  let review: ReadingViewResult["checks"]["review"] = "not-allowed";
  const reviewedParts: number[] = [];
  try {
    for (const index of chunksToReview(parts.length, flagged)) {
      await stage(`Checking part ${index + 1} of ${parts.length} against the original`);
      const issues = await runner.reviewText(used[index], parts[index].maskedRewrite, parts[index].checks);
      if (issues === null) break;
      cloud = [...(cloud ?? []), ...issues];
      reviewedParts.push(index);
      review = "reviewed";
    }
  } catch (error) {
    if (toProviderError(error).code === "cancelled") throw error;
    review = "failed";
    notes.push("The cloud check of the reading view failed; only the code check ran.");
  }

  await stage("Writing the summary");
  const summary = await summarize(runner, job.text, title, stage).then((result) => result.bullets.slice(0, 3)).catch((error) => {
    if (toProviderError(error).code === "cancelled") throw error;
    notes.push("The 3-line summary could not be made; the reading view is still complete.");
    return [] as string[];
  });

  const coverage = Math.min(1, used.reduce((total, chunk) => total + chunk.length, 0) / masked.text.length);
  if (coverage < 0.99) notes.unshift(`Long page: the reading view covers the first ${Math.round(coverage * 100)}% of the article.`);
  const checks = parts.flatMap((part) => part.checks);
  notes.push(...fidelityNotes(checks, review === "reviewed" ? cloud : null));
  const blocks = parts.flatMap((part) => part.blocks);
  if (blocks.length === 0) throw new ProviderError("invalid-plan", "The reading view came back empty.", "Try again, or switch model.");
  return {
    summary, blocks, coverage, shown: true, source: job.runner.source(), cached: false, notes,
    checks: { flagged: flagged.length, parts: parts.length, review, reviewedParts: reviewedParts.length, issues: checks.length + (cloud?.length ?? 0) },
  };
}

registerPageRunner("readingView", async (job) => {
  const key = await cacheKey("readingView", job.url, job.text);
  const cached = job.refresh ? null : await readCache(key, ReadingViewResultSchema);
  const view = cached ? { ...cached, cached: true, shown: true } : await buildReadingView(job);
  if (!cached) await writeCache(key, view);
  await job.update((state) => ({ ...state, readingView: view }));
  tell(job.tabId, { type: "SHOW_READING_VIEW", view });
});
