// ─── AI job lifecycle (background only) ──────────────────────────────────────
// run → preview → apply → undo, all persisted in the job record. The page only
// ever changes through settings resolution (preview overlay or saved site rule).
// P10: every run is supervised: the draft is measured (and auto-reverted where
// it makes the page worse), then reviewed by the cloud when the mode, consent
// and review policy allow (see supervise.ts).

import { describeChanges, type PlanChanges } from "../shared/aiFields";
import { readJob, type AiJob } from "../shared/aiJob";
import { validateElements, type ElementItem, type ElementReview } from "../shared/elementPlan";
import { deterministicPlan } from "../shared/intents";
import type { AI_RUN_KINDS } from "../shared/messages";
import { BlocksSchema } from "../shared/messages";
import { detectShortcut, DomSnapshotSchema, formatProviderError, toProviderError, type DomSnapshot, type Plan } from "../shared/plan";
import { ProviderRouter } from "../shared/providerRouter";
import { draftIsUnsure, draftLedger, requestedFields, type LedgerSource } from "../shared/review";
import { cloudConsentFor, isSiteEnabled, normalizeHostname, resolveAppearance, resolveFocus, resolveMotion, resolveTypography, SiteRuleSchema } from "../shared/settings";
import { currentAiValues, exactSiteRule, restoreSiteRule, withSiteElements, withSitePatch, type SiteElements } from "../shared/sitePatch";
import { loadSettings, saveSettings } from "../shared/storage";
import { consumeAllowOnce } from "./consent";
import { beginJob, cancelJob, clearJob, endJob, patchJob, writeJob } from "./jobs";
import { runPlanner } from "./planner";
import { problemLines } from "./reviewPrompt";
import { clearShots } from "./screenshot";
import { clearSnapshot, decideReview, guardSettings, inspectorChanges, measureState, reviewJob, saveSnapshot, setPreview, settle, steps, type Settled } from "./supervise";
import { tabMessage, tabPage } from "./tabs";

export type AiRunKind = typeof AI_RUN_KINDS[number];

const DEMO_PLAN: Plan = {
  interpretedRequest: "Make the article easier to read",
  changes: { fontSize: 19, lineHeight: 1.8, maxContentWidth: 760 },
  reasons: ["Demo mode: canned plan, no AI model was used."],
  confidence: 1,
};

async function tabHostname(tabId: number): Promise<string | null> {
  return (await tabPage(tabId))?.hostname ?? null;
}

async function snapshotOf(tabId: number): Promise<DomSnapshot | null> {
  const response = await tabMessage<{ payload?: unknown }>(tabId, { type: "GET_DOM_SNAPSHOT" });
  const parsed = DomSnapshotSchema.safeParse(response?.payload);
  return parsed.success ? parsed.data : null;
}

function errorJob(base: AiJob, code: string, message: string, hint: string): AiJob {
  return { ...base, status: "error", stage: "Failed", error: { code, message, hint } };
}

/** Handle deterministic shortcuts; returns true when the request was one. */
async function runShortcut(tabId: number, hostname: string, request: string, base: AiJob): Promise<boolean> {
  const shortcut = detectShortcut(request);
  if (!shortcut) return false;
  const settings = await loadSettings();
  if (shortcut.type === "undo") {
    const job = await readJob(tabId);
    if (job?.status === "applied") return undoJob(tabId).then(() => true);
    await tabMessage(tabId, { type: "UNDO_PAGE" });
  } else if (shortcut.type === "reset") {
    await setPreview(tabId, null);
    await tabMessage(tabId, { type: "RESET_PAGE" });
  } else if (shortcut.type === "turn-off") {
    const rule = SiteRuleSchema.parse({ ...(exactSiteRule(settings, hostname) ?? { hostname }), enabled: false });
    await saveSettings({ ...settings, siteRules: [...settings.siteRules.filter((item) => normalizeHostname(item.hostname) !== hostname), rule] });
  } else {
    await saveProfile(tabId, shortcut.name);
  }
  await writeJob({ ...base, status: "nothing", stage: "Done", interpretedRequest: `Shortcut: ${shortcut.type}`, source: "rules" });
  return true;
}

/** The visible parts of these blocks (drill-down), or null when the page cannot answer. */
async function expandVia(tabId: number, ids: string[]) {
  const parsed = BlocksSchema.safeParse(await tabMessage(tabId, { type: "EXPAND_BLOCKS", ids }));
  return parsed.success ? parsed.data.blocks : null;
}

export async function runAiJob(tabId: number, request: string, kind: AiRunKind = "ask"): Promise<void> {
  const hostname = await tabHostname(tabId);
  const now = Date.now();
  const base: AiJob = { id: `${now}-${Math.random().toString(36).slice(2, 8)}`, tabId, hostname: hostname ?? "", request, status: "running", stage: "Reading the page", received: 0, startedAt: now, updatedAt: now, kind };
  if (!hostname) {
    await writeJob(errorJob(base, "unsupported", "AI commands only work on regular web pages.", "Open an http(s) page and try again."));
    return;
  }
  if (await runShortcut(tabId, hostname, request, base)) return;

  const settings = await loadSettings();
  if (!isSiteEnabled(settings, hostname)) {
    await writeJob(errorJob(base, "unsupported", "Adaptive Web Layer is turned off for this site.", "Turn it on from the popup first."));
    return;
  }

  const signal = beginJob(tabId);
  const current = currentAiValues(settings, hostname);
  const supervision = { steps: steps({ draft: { status: "running" } }), review: "pending" as const, ledger: [], scores: {}, shots: false, reverted: [], canReview: false, needsConsent: false };
  let job = await writeJob({ ...base, supervision });
  let snapshot: DomSnapshot | null = null;
  await setPreview(tabId, null);
  await clearShots(tabId);
  try {
    snapshot = await snapshotOf(tabId);
    if (!snapshot) {
      await writeJob(errorJob(job, "no-content-script", "Could not read this page.", "Reload the page (the extension may have been updated after it loaded)."));
      return;
    }
    // Observe: what code measures before anything changes.
    const before = await measureState(tabId, null);

    let plan: Plan;
    let changes: PlanChanges;
    let elements: ElementReview;
    let source: AiJob["source"];
    const warnings: string[] = [];
    if (settings.ai.demoMode) {
      plan = deterministicPlan(request, current, snapshot) ?? DEMO_PLAN;
      changes = plan.changes;
      elements = validateElements(plan.elements, snapshot);
      source = "demo";
    } else {
      const ai = settings.ai;
      const router = new ProviderRouter({ settings: ai, consent: cloudConsentFor(settings.privacy, hostname) });
      const target = ai.mode === "cloud" ? `cloud AI (${ai.cloudBackend})` : "local AI";
      job = (await patchJob(tabId, job.id, { stage: `Asking ${target} for a draft` })) ?? job;
      let lastReport = 0;
      const result = await runPlanner(router, {
        request,
        snapshot,
        current,
        problems: kind === "fix" && before ? problemLines(before.report.findings) : undefined,
        expand: (ids) => expandVia(tabId, ids),
      }, {
        signal,
        onProgress: (received) => {
          // Throttled: each write is also an extension API call that keeps the worker alive.
          if (Date.now() - lastReport < 500) return;
          lastReport = Date.now();
          void patchJob(tabId, job.id, { received, stage: `Receiving the draft from ${target}` }, "running");
        },
      });
      plan = result.plan;
      snapshot = result.snapshot;
      changes = result.changes;
      elements = result.elements;
      source = router.usedProvider ?? undefined;
      if (result.retried) warnings.push("The first reply was invalid; this is the model's corrected plan.");
      warnings.push(...result.notes);
      await consumeAllowOnce(hostname, router.usedProvider === "cloud");
    }
    // "Fix this page" also gets the inspector's high-confidence fixes the draft left out.
    const sources: Record<string, LedgerSource> = {};
    if (kind === "fix" && before) {
      const extra = inspectorChanges(before.report, current, changes);
      for (const key of Object.keys(extra)) sources[key] = "inspector";
      changes = { ...changes, ...extra };
    }

    if (signal.aborted) {
      await patchJob(tabId, job.id, { status: "cancelled", stage: "Cancelled" });
      return;
    }
    const summary = { source, interpretedRequest: plan.interpretedRequest, reasons: plan.reasons, confidence: plan.confidence, warnings, rejectedElements: elements.rejected };
    const draftDone = steps({ draft: { status: "done" } });
    if (Object.keys(changes).length === 0 && elements.items.length === 0) {
      await patchJob(tabId, job.id, { ...summary, status: "nothing", stage: "Nothing to change", changes: {}, supervision: { ...supervision, steps: steps({ draft: { status: "done" }, measure: { status: "skipped" }, review: { status: "skipped" }, final: { status: "done" } }), review: "off" } });
      return;
    }
    await saveSnapshot(tabId, snapshot);

    // Measure: preview the draft; undo anything that makes the page measurably worse.
    job = (await patchJob(tabId, job.id, { ...summary, stage: "Measuring the draft", supervision: { ...supervision, steps: steps({ draft: { status: "done" }, measure: { status: "running" } }, draftDone) } })) ?? job;
    // Code rules first (a fix changes only what was measured; width only where lines are too long), then the measured regressions.
    const guarded = guardSettings({ changes, items: elements.items }, draftLedger(changes, elements.items, source ?? "local", sources), {
      request, kind, hasMain: snapshot.contentRegion !== "body", before: before?.measures, current,
    });
    const { state: draft, ledger } = guarded;
    const settled: Settled = before
      ? await settle(tabId, before.measures, draft, ledger, requestedFields(request, kind))
      : { state: draft, ledger, measured: await measureState(tabId, draft), reverted: [], unresolved: [] };
    if (signal.aborted) {
      await setPreview(tabId, null);
      await patchJob(tabId, job.id, { status: "cancelled", stage: "Cancelled" });
      return;
    }
    const final = settled.state;
    const scores = { before: before?.score.value, draft: settled.measured?.score.value };
    const measureNote = scores.before !== undefined && scores.draft !== undefined ? `Score ${scores.before} → ${scores.draft}` : before ? undefined : "Could not measure this page";
    if (Object.keys(final.changes).length === 0 && !final.items.some((item) => item.enabled)) {
      await setPreview(tabId, null);
      await patchJob(tabId, job.id, { status: "nothing", stage: "Nothing to change", changes: {}, elements: final.items, warnings: [...warnings, "No change was kept: each one broke a code rule or made the page measurably worse (see the list)."], supervision: { ...supervision, ledger: settled.ledger, scores, reverted: settled.reverted, steps: steps({ draft: { status: "done" }, measure: { status: "done", note: measureNote }, review: { status: "skipped" }, final: { status: "done" } }), review: "off" } });
      return;
    }

    // Review: by the cloud when the mode, consent and review policy allow.
    const unsure = draftIsUnsure({ confidence: plan.confidence, before: before?.measures, draft: settled.measured?.measures, requested: elements.items.length + elements.rejected.length, refused: elements.rejected.length });
    const decision = decideReview(settings, hostname, unsure);
    await patchJob(tabId, job.id, {
      ...summary,
      status: "preview",
      stage: decision.run ? "Cloud is reviewing the draft" : "Previewing",
      changes: final.changes,
      descriptions: describeChanges(final.changes),
      elements: final.items,
      warnings: [...warnings, ...settled.unresolved.map((reason) => `Still measured worse: ${reason}`)],
      supervision: {
        ...supervision,
        ...decision.supervision,
        ledger: settled.ledger,
        scores,
        before: before?.measures,
        reverted: settled.reverted,
        confidence: plan.confidence,
        steps: steps({ draft: { status: "done" }, measure: { status: before ? "done" : "skipped", note: measureNote }, review: { status: decision.run ? "running" : "skipped", note: decision.run ? undefined : decision.supervision.note }, final: { status: decision.run ? "pending" : "done" } }),
      },
    });
    if (decision.run) await reviewJob(tabId, job.id, signal);
  } catch (caught) {
    const error = toProviderError(caught);
    if (error.code === "cancelled") {
      await setPreview(tabId, null);
      await patchJob(tabId, job.id, { status: "cancelled", stage: "Cancelled" });
      return;
    }
    await setPreview(tabId, null);
    const { message, hint } = formatProviderError(error);
    const suggestion = snapshot ? deterministicPlan(request, current, snapshot) : null;
    const suggestedItems = suggestion && snapshot ? validateElements(suggestion.elements, snapshot).items : [];
    const useful = suggestion && (Object.keys(suggestion.changes).length > 0 || suggestedItems.length > 0);
    await patchJob(tabId, job.id, {
      status: "error",
      stage: "Failed",
      error: { code: error.code, message, hint },
      fallback: useful ? { changes: suggestion.changes, descriptions: describeChanges(suggestion.changes), elements: suggestedItems } : undefined,
      supervision: undefined,
    });
  } finally {
    endJob(tabId, signal);
  }
}

/** P10: ask the cloud to review the current preview (after consent, a skipped or a failed review). */
export async function requestReview(tabId: number): Promise<string | null> {
  const job = await readJob(tabId);
  if (job?.status !== "preview" || !job.supervision) return "There is no previewed draft to review.";
  if (job.supervision.review === "running") return "The review is already running.";
  const settings = await loadSettings();
  if (settings.ai.demoMode) return "Demo mode has no cloud reviewer.";
  if (settings.ai.mode === "local") return "Local mode never sends anything to the cloud. Switch AI mode to hybrid in Settings to have drafts reviewed.";
  const signal = beginJob(tabId);
  void reviewJob(tabId, job.id, signal).finally(() => endJob(tabId, signal));
  return null;
}

/** Turn the enabled element items into selectors that survive a reload. */
async function savedSelectors(tabId: number, items: readonly ElementItem[]): Promise<{ elements: SiteElements; unsaved: string[] } | null> {
  const enabled = items.filter((item) => item.enabled);
  const elements: SiteElements = { hide: [], dim: [], highlight: [] };
  if (enabled.length === 0) return { elements, unsaved: [] };
  const response = await tabMessage<{ selectors?: Record<string, string | null>; sameKind?: Record<string, string> }>(tabId, { type: "RESOLVE_SELECTORS", ids: enabled.map((item) => item.id) });
  if (!response?.selectors) return null;
  const unsaved: string[] = [];
  for (const item of enabled) {
    // A hidden clutter widget is saved as "every copy of it", so copies loaded later stay hidden too.
    const selector = (item.action === "hide" ? response.sameKind?.[item.id] : undefined) ?? response.selectors[item.id];
    if (selector) elements[item.action].push(selector); else unsaved.push(item.label);
  }
  return { elements, unsaved };
}

export async function applyJob(tabId: number): Promise<string | null> {
  const job = await readJob(tabId);
  if (job?.status !== "preview" || !job.changes) return "There is no preview to apply.";
  if (job.supervision?.review === "running") return "The cloud is still reviewing. Wait for it, or cancel the review first.";
  const resolved = await savedSelectors(tabId, job.elements ?? []);
  if (!resolved) return "Could not read the page to save the element changes. Reload it and try again.";
  const settings = await loadSettings();
  const previousRule = exactSiteRule(settings, job.hostname) ?? null;
  const next = withSiteElements(withSitePatch(settings, job.hostname, job.changes), job.hostname, resolved.elements);
  if (!await saveSettings(next)) return "Could not save the changes.";
  // The saved rule now carries the changes; drop the overlay so nothing is doubled.
  await setPreview(tabId, null);
  await writeJob({ ...job, status: "applied", stage: "Applied to this site", previousRule, unsaved: resolved.unsaved.length ? resolved.unsaved : undefined });
  return null;
}

/** Per-item toggle in a preview. Enabling a protected hide is the user's explicit confirmation. */
export async function setElementEnabled(tabId: number, id: string, enabled: boolean): Promise<string | null> {
  const job = await readJob(tabId);
  if (job?.status !== "preview" || !job.elements?.some((item) => item.id === id)) return "That element is not part of the current preview.";
  const elements = job.elements.map((item) => item.id === id ? { ...item, enabled } : item);
  await setPreview(tabId, { changes: job.changes ?? {}, elements });
  await writeJob({ ...job, elements });
  return null;
}

export async function undoJob(tabId: number): Promise<string | null> {
  const job = await readJob(tabId);
  if (job?.status !== "applied") return "There is no applied AI change to undo.";
  const settings = await loadSettings();
  if (!await saveSettings(restoreSiteRule(settings, job.hostname, job.previousRule ?? undefined))) return "Could not restore the previous settings.";
  await writeJob({ ...job, status: "cancelled", stage: "Undone", previousRule: undefined });
  return null;
}

export async function discardJob(tabId: number): Promise<void> {
  cancelJob(tabId);
  await setPreview(tabId, null);
  await clearJobData(tabId);
}

/** The job plus what it keeps beside it (snapshot, screenshots). */
export async function clearJobData(tabId: number): Promise<void> {
  await Promise.all([clearJob(tabId), clearShots(tabId), clearSnapshot(tabId)]);
}

export async function useFallback(tabId: number): Promise<string | null> {
  const job = await readJob(tabId);
  if (!job?.fallback) return "There is no suggestion to preview.";
  await setPreview(tabId, { changes: job.fallback.changes, elements: job.fallback.elements });
  await writeJob({ ...job, status: "preview", stage: "Previewing suggestion", source: "rules", changes: job.fallback.changes, descriptions: job.fallback.descriptions, elements: job.fallback.elements, interpretedRequest: job.request, fallback: undefined, error: undefined });
  return null;
}

/** Save what the page currently shows (saved settings + any preview) as a named profile. */
export async function saveProfile(tabId: number, name: string): Promise<string | null> {
  const hostname = await tabHostname(tabId);
  if (!hostname) return "Open a regular web page first.";
  const settings = await loadSettings();
  if (settings.profiles.some((profile) => profile.name.toLowerCase() === name.toLowerCase())) return `A profile named "${name}" already exists.`;
  const job = await readJob(tabId);
  const shown = job?.status === "preview" && job.changes ? withSitePatch(settings, hostname, job.changes) : settings;
  const profile = {
    id: `custom-${Date.now()}`,
    name,
    builtIn: false,
    typography: resolveTypography(shown, hostname),
    appearance: resolveAppearance(shown, hostname),
    focus: resolveFocus(shown, hostname),
    motion: resolveMotion(shown, hostname),
  };
  return await saveSettings({ ...settings, profiles: [...settings.profiles, profile] }) ? null : "Could not save the profile.";
}
