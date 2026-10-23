// ─── Supervised fix (P10): measure, review, settle ───────────────────────────
// Roles: the local model drafts (planner.ts), code measures (the content
// script's MEASURE_PAGE + readabilityScore), the cloud reviews (this file,
// through ProviderRouter.review), and the user decides (Apply / untick / Undo).
// Code has the last word: any change that makes the page measurably worse is
// undone automatically, whoever proposed it.

import { describeChanges, type PlanChanges } from "../shared/aiFields";
import { readJob, type AiJob, type Step, type Supervision } from "../shared/aiJob";
import { previewElementsOf, type ElementItem, type PreviewElements } from "../shared/elementPlan";
import { mergeFixes, readabilityScore, type Finding, type InspectReport, type Score } from "../shared/inspector";
import { MeasureResultSchema, RegionBlocksSchema } from "../shared/messages";
import { DomSnapshotSchema, effectiveChanges, formatProviderError, ProviderError, toProviderError, type DomSnapshot } from "../shared/plan";
import { ProviderRouter } from "../shared/providerRouter";
import { applyReview, draftItems, regressions, ReviewReplySchema, reviewJsonSchema, type LedgerEntry, type Measures } from "../shared/review";
import { cloudConsentFor, normalizeHostname, type Settings } from "../shared/settings";
import { currentAiValues } from "../shared/sitePatch";
import { loadSettings, saveSettings } from "../shared/storage";
import { consumeAllowOnce } from "./consent";
import { patchJob } from "./jobs";
import { buildReviewSystemPrompt, buildReviewUserPrompt } from "./reviewPrompt";
import { captureWithMarks, saveShots } from "./screenshot";
import { runValidated } from "./structured";
import { tabMessage } from "./tabs";

// Thinking models spend part of this before answering; the proxy caps it at 4096.
const REVIEW_MAX_TOKENS = 4096;
/** Re-measurements spent finding which change caused a regression. */
export const MAX_REVERT_CHECKS = 6;
/** Time for the page to repaint after a preview change, before a screenshot. */
const PAINT_MS = 150;

export interface DraftState { changes: PlanChanges; items: ElementItem[] }

/** Show changes + element items on the page without saving; null clears the preview. */
export function setPreview(tabId: number, preview: { changes: PlanChanges; elements?: readonly ElementItem[] } | null): Promise<unknown> {
  const elements: PreviewElements | undefined = preview?.elements?.length ? previewElementsOf(preview.elements) : undefined;
  return tabMessage(tabId, { type: "SET_PREVIEW", changes: preview?.changes ?? null, elements });
}

// ── The page snapshot a job was planned on (needed again for a later review) ──
const snapKey = (tabId: number) => `awl_snap_${tabId}`;

export async function saveSnapshot(tabId: number, snapshot: DomSnapshot): Promise<void> {
  await chrome.storage.session.set({ [snapKey(tabId)]: snapshot });
}

export async function readSnapshot(tabId: number): Promise<DomSnapshot | null> {
  const parsed = DomSnapshotSchema.safeParse((await chrome.storage.session.get(snapKey(tabId)))[snapKey(tabId)]);
  return parsed.success ? parsed.data : null;
}

export function clearSnapshot(tabId: number): Promise<void> {
  return chrome.storage.session.remove(snapKey(tabId));
}

// ── Measuring ────────────────────────────────────────────────────────────────
export interface Measured { measures: Measures; report: InspectReport; score: Score }

const count = (findings: readonly Finding[], type: Finding["type"]) => findings.filter((finding) => finding.type === type).length;

/** Preview `state` (null: saved settings only) and measure what the page shows. */
export async function measureState(tabId: number, state: DraftState | null): Promise<Measured | null> {
  await setPreview(tabId, state && { changes: state.changes, elements: state.items });
  const parsed = MeasureResultSchema.safeParse(await tabMessage(tabId, { type: "MEASURE_PAGE" }));
  if (!parsed.success) return null;
  const { report, mainText, hiddenText, protectedVisible } = parsed.data;
  const score = readabilityScore(report.findings);
  return {
    report,
    score,
    measures: {
      score: score.value,
      mainText,
      hiddenText,
      protectedVisible,
      overflow: count(report.findings, "horizontal-overflow"),
      overlap: count(report.findings, "overlap"),
      clipped: count(report.findings, "clipped-content"),
    },
  };
}

/** High-confidence inspector fixes the draft did not already cover (settings only). */
export function inspectorChanges(report: InspectReport, current: Record<string, string | number | boolean>, draft: PlanChanges): PlanChanges {
  const fixes = report.findings.filter((finding) => finding.confidence === "high" && finding.suggestedFix && Object.keys(finding.suggestedFix.changes).length > 0);
  const merged = mergeFixes(fixes.map((finding) => ({ ...finding.suggestedFix!, hide: [] }))).changes;
  return Object.fromEntries(Object.entries(effectiveChanges(merged, current)).filter(([key]) => !(key in draft)));
}

// ── Auto-revert ──────────────────────────────────────────────────────────────
const active = (entry: LedgerEntry) => entry.status === "kept" || entry.status === "added";
const protectedHidden = (state: DraftState) => state.items.filter((item) => item.enabled && item.action === "hide" && item.protect).length;

function without(state: DraftState, refs: ReadonlySet<string>): DraftState {
  return {
    changes: Object.fromEntries(Object.entries(state.changes).filter(([key]) => !refs.has(key))),
    items: state.items.filter((item) => !refs.has(item.id)),
  };
}

/** What to try undoing, in order: the reviewer's additions together, then each setting, then each element. */
function revertGroups(state: DraftState, ledger: readonly LedgerEntry[]): Array<Set<string>> {
  const cloud = new Set(ledger.filter((entry) => entry.status === "added").map((entry) => entry.ref));
  const groups: Array<Set<string>> = cloud.size ? [cloud] : [];
  for (const key of Object.keys(state.changes)) if (!cloud.has(key)) groups.push(new Set([key]));
  for (const item of state.items) if (item.enabled && !cloud.has(item.id)) groups.push(new Set([item.id]));
  return groups;
}

export interface Settled { state: DraftState; ledger: LedgerEntry[]; measured: Measured | null; reverted: string[]; unresolved: string[] }

/**
 * Measure `state`; while it is worse than `before`, undo the group of changes
 * whose removal fixes the most, within MAX_REVERT_CHECKS re-measurements.
 * Leaves the page previewing the settled state.
 */
export async function settle(tabId: number, before: Measures, state: DraftState, ledger: readonly LedgerEntry[]): Promise<Settled> {
  let current = state;
  let measured = await measureState(tabId, current);
  const entries = ledger.map((entry) => ({ ...entry }));
  const reverted: string[] = [];
  if (!measured) return { state, ledger: entries, measured, reverted, unresolved: [] };
  let reasons = regressions(before, measured.measures, protectedHidden(current));
  let checks = 0;
  for (const group of revertGroups(current, entries)) {
    if (reasons.length === 0 || checks >= MAX_REVERT_CHECKS) break;
    checks++;
    const candidate = without(current, group);
    const trial = await measureState(tabId, candidate);
    if (!trial) break;
    const left = regressions(before, trial.measures, protectedHidden(candidate));
    if (left.length >= reasons.length) continue;
    const fixed = reasons.find((reason) => !left.some((other) => other.split(" ")[1] === reason.split(" ")[1])) ?? reasons[0];
    const names: string[] = [];
    for (const entry of entries) {
      if (group.has(entry.ref) && active(entry)) {
        Object.assign(entry, { status: "reverted", reason: `Undone automatically: ${fixed}`.slice(0, 240) });
        names.push(entry.label);
      }
    }
    reverted.push(`${names.join(", ").slice(0, 120)}: ${fixed}`.slice(0, 240));
    current = candidate;
    measured = trial;
    reasons = left;
  }
  // The last trial may have been refused; show the settled state.
  if (checks > 0) await setPreview(tabId, { changes: current.changes, elements: current.items });
  return { state: current, ledger: entries, measured, reverted, unresolved: reasons };
}

// ── When to review ───────────────────────────────────────────────────────────
export interface ReviewDecision { run: boolean; supervision: Pick<Supervision, "review" | "note" | "canReview" | "needsConsent"> }

export function decideReview(settings: Settings, hostname: string, unsure: boolean): ReviewDecision {
  const skip = (review: Supervision["review"], note: string, canReview = false, needsConsent = false): ReviewDecision => ({ run: false, supervision: { review, note, canReview, needsConsent } });
  if (settings.ai.demoMode) return skip("off", "Demo mode: no cloud reviewer.");
  if (settings.ai.mode === "local") return skip("off", "Local only: measured by code, not reviewed by a cloud model.");
  const consent = cloudConsentFor(settings.privacy, hostname);
  if (consent === "deny") return skip("not-reviewed", "Cloud AI is denied for this site, so the draft was not reviewed.");
  if (consent === "pending") return skip("not-reviewed", "Allow cloud AI for this site to have the draft reviewed.", true, true);
  const policy = settings.ai.reviewPolicy;
  if (policy === "first-per-site" && settings.privacy.reviewedSites.includes(normalizeHostname(hostname))) {
    return skip("not-reviewed", "Not reviewed: this site was reviewed before (review policy: first run per site).", true);
  }
  if (policy === "when-unsure" && !unsure) return skip("not-reviewed", "Not reviewed: the local draft looked sound (review policy: only when unsure).", true);
  return { run: true, supervision: { review: "pending", canReview: false, needsConsent: false } };
}

export function steps(statuses: Partial<Record<Step["id"], Omit<Step, "id">>>, previous: readonly Step[] = []): Step[] {
  return (["draft", "measure", "review", "final"] as const).map((id) => statuses[id] ? { id, ...statuses[id]! } : previous.find((step) => step.id === id) ?? { id, status: "pending" });
}

// ── The review ───────────────────────────────────────────────────────────────
async function rememberReviewed(hostname: string): Promise<void> {
  const settings = await loadSettings();
  const host = normalizeHostname(hostname);
  if (settings.privacy.reviewedSites.includes(host)) return;
  await saveSettings({ ...settings, privacy: { ...settings.privacy, reviewedSites: [...settings.privacy.reviewedSites, host].slice(-500) } });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The cloud reviews the job's current preview: screenshots (before/after with
 * numbered boxes), one validated review call, regions mapped to blocks, the
 * review folded in, then measured and settled. A failure keeps the draft.
 */
export async function reviewJob(tabId: number, jobId: string, signal: AbortSignal): Promise<void> {
  const job = await readJob(tabId);
  const supervision = job?.supervision;
  if (!job || job.id !== jobId || job.status !== "preview" || !supervision) return;
  const state: DraftState = { changes: job.changes ?? {}, items: job.elements ?? [] };
  const update = (patch: Partial<AiJob>, sup: Partial<Supervision>) => patchJob(tabId, jobId, { ...patch, supervision: { ...supervision, ...sup } });
  const snapshot = await readSnapshot(tabId);
  if (!snapshot) {
    await update({}, { review: "failed", note: "The page changed since the draft; run the request again.", canReview: false, steps: steps({ review: { status: "failed" } }, supervision.steps) });
    return;
  }
  const settings = await loadSettings();
  const current = currentAiValues(settings, job.hostname);
  const router = new ProviderRouter({ settings: settings.ai, consent: cloudConsentFor(settings.privacy, job.hostname) });
  await update({ stage: "Cloud is reviewing the draft" }, { review: "running", canReview: false, needsConsent: false, note: undefined, steps: steps({ review: { status: "running" }, final: { status: "pending" } }, supervision.steps) });
  try {
    // Before/after screenshots with numbered boxes; none if the tab is not visible.
    const draftIds = new Set(state.items.filter((item) => item.enabled).map((item) => item.id));
    const ids = snapshot.blocks.map((block) => block.id);
    await setPreview(tabId, null);
    await sleep(PAINT_MS);
    const before = await captureWithMarks(tabId, ids, draftIds);
    await setPreview(tabId, { changes: state.changes, elements: state.items });
    await sleep(PAINT_MS);
    const after = before ? await captureWithMarks(tabId, ids, new Set()) : null;
    const images = [before, after].filter((image): image is NonNullable<typeof image> => image !== null);
    const shots = await saveShots(tabId, { before, after });
    if (signal.aborted) throw new ProviderError("cancelled", "The review was cancelled.");

    const draft = draftItems(state.changes, state.items);
    const draftMeasure = await measureState(tabId, state);
    const { reply } = await runValidated({ generateStructured: (request) => router.review(request) }, {
      systemPrompt: buildReviewSystemPrompt(),
      userPrompt: (errors) => buildReviewUserPrompt({
        request: job.request,
        current,
        draft,
        snapshot,
        before: supervision.scores.before !== undefined ? { score: { value: supervision.scores.before, contributors: [] } } : undefined,
        after: draftMeasure ? { score: draftMeasure.score, findings: draftMeasure.report.findings } : undefined,
        screenshots: images.length > 0,
      }, errors),
      schema: ReviewReplySchema,
      jsonSchema: reviewJsonSchema(draft.map((item) => item.ref), snapshot.blocks.map((block) => block.id)),
      maxTokens: REVIEW_MAX_TOKENS,
    }, { signal });

    // Clutter the reviewer saw but had no box for: map each area to a block.
    const regionReasons: Record<string, string> = {};
    let reviewed = snapshot;
    if (reply.missedRegions.length > 0) {
      const found = RegionBlocksSchema.safeParse(await tabMessage(tabId, { type: "BLOCKS_AT_REGIONS", regions: reply.missedRegions.map(({ x, y, w, h }) => ({ x, y, w, h })) }));
      const blocks = found.success ? found.data.blocks : [];
      blocks.forEach((block, index) => {
        if (!block) return;
        const region = reply.missedRegions[index];
        if (!reviewed.blocks.some((known) => known.id === block.id)) reviewed = { ...reviewed, blocks: [...reviewed.blocks, block] };
        if (!reply.add.elements[region.action].includes(block.id)) reply.add.elements[region.action].push(block.id);
        regionReasons[block.id] = `Seen in the screenshot: ${region.reason}`;
      });
      await saveSnapshot(tabId, reviewed);
    }

    const outcome = applyReview({ request: job.request, snapshot: reviewed, current, changes: state.changes, items: state.items, ledger: supervision.ledger, reply, regionReasons });
    const settled = supervision.before
      ? await settle(tabId, supervision.before, { changes: outcome.changes, items: outcome.items }, outcome.ledger)
      : { state: { changes: outcome.changes, items: outcome.items }, ledger: outcome.ledger, measured: await measureState(tabId, { changes: outcome.changes, items: outcome.items }), reverted: [], unresolved: [] };
    await rememberReviewed(job.hostname);
    await consumeAllowOnce(job.hostname, true);
    await update({
      stage: "Previewing the reviewed result",
      changes: settled.state.changes,
      descriptions: describeChanges(settled.state.changes),
      elements: settled.state.items,
      rejectedElements: [...(job.rejectedElements ?? []), ...outcome.rejected].slice(0, 60),
      warnings: [...(job.warnings ?? []), ...outcome.notes, ...settled.unresolved.map((reason) => `Still measured worse: ${reason}`)],
    }, {
      review: "reviewed",
      reviewer: router.reviewedBy ?? undefined,
      verdict: reply.verdict,
      note: (images.length ? reply.notes : `${reply.notes} (Reviewed without screenshots: Chrome only allows them after you open Adaptive Web Layer from its toolbar button on this tab, or press Alt+Shift+F.)`).trim().slice(0, 400) || undefined,
      ledger: settled.ledger,
      shots: shots || supervision.shots,
      reverted: [...supervision.reverted, ...settled.reverted].slice(0, 10),
      scores: { ...supervision.scores, final: settled.measured?.score.value ?? supervision.scores.draft },
      steps: steps({ review: { status: "done", note: `${reply.verdict === "approve" ? "Approved" : "Revised"}${images.length ? "" : ", text only"}` }, final: { status: "done" } }, supervision.steps),
    });
  } catch (caught) {
    const error = toProviderError(caught);
    // Whatever happened, the page shows the draft again.
    await setPreview(tabId, { changes: state.changes, elements: state.items });
    const cancelled = error.code === "cancelled" || signal.aborted;
    const { message } = formatProviderError(error);
    await update({ stage: "Previewing" }, {
      review: cancelled ? "not-reviewed" : "failed",
      note: cancelled ? "Review cancelled; this is the local draft." : `The review failed (${message}); this is the local draft, measured by code.`.slice(0, 400),
      canReview: error.code !== "consent-denied",
      needsConsent: error.code === "consent-required",
      steps: steps({ review: { status: cancelled ? "skipped" : "failed" }, final: { status: "done" } }, supervision.steps),
    });
  }
}
