// ─── AI job lifecycle (background only) ──────────────────────────────────────
// run → preview → apply → undo, all persisted in the job record. The page only
// ever changes through settings resolution (preview overlay or saved site rule).

import { describeChanges, type PlanChanges } from "../shared/aiFields";
import { readJob, type AiJob } from "../shared/aiJob";
import { matchIntents } from "../shared/intents";
import { detectShortcut, DomSnapshotSchema, formatProviderError, toProviderError, type DomSnapshot, type Plan } from "../shared/plan";
import { ProviderRouter } from "../shared/providerRouter";
import { cloudConsentFor, isSiteEnabled, normalizeHostname, resolveAppearance, resolveFocus, resolveMotion, resolveTypography, SiteRuleSchema } from "../shared/settings";
import { currentAiValues, exactSiteRule, restoreSiteRule, withSitePatch } from "../shared/sitePatch";
import { loadSettings, saveSettings } from "../shared/storage";
import { beginJob, clearJob, endJob, patchJob, writeJob } from "./jobs";
import { runPlanner } from "./planner";

const DEMO_PLAN: Plan = {
  interpretedRequest: "Make the article easier to read",
  changes: { fontSize: 19, lineHeight: 1.8, maxContentWidth: 760 },
  reasons: ["Demo mode: canned plan, no AI model was used."],
  confidence: 1,
};

function tabMessage<T>(tabId: number, message: unknown): Promise<T | null> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response: T) => {
      resolve(chrome.runtime.lastError ? null : response ?? null);
    });
  });
}

const setPreview = (tabId: number, changes: PlanChanges | null) => tabMessage(tabId, { type: "SET_PREVIEW", changes });

async function tabHostname(tabId: number): Promise<string | null> {
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = new URL(tab.url ?? "");
    return url.protocol === "http:" || url.protocol === "https:" ? normalizeHostname(url.hostname) : null;
  } catch {
    return null;
  }
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

export async function runAiJob(tabId: number, request: string): Promise<void> {
  const hostname = await tabHostname(tabId);
  const now = Date.now();
  const base: AiJob = { id: `${now}-${Math.random().toString(36).slice(2, 8)}`, tabId, hostname: hostname ?? "", request, status: "running", stage: "Reading the page", received: 0, startedAt: now, updatedAt: now };
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
  let job = await writeJob(base);
  await setPreview(tabId, null);
  try {
    const snapshot = await snapshotOf(tabId);
    if (!snapshot) {
      await writeJob(errorJob(job, "no-content-script", "Could not read this page.", "Reload the page (the extension may have been updated after it loaded)."));
      return;
    }

    let plan: Plan;
    let changes: PlanChanges;
    let source: AiJob["source"];
    const warnings: string[] = [];
    if (settings.ai.demoMode) {
      plan = matchIntents(request, current) ?? DEMO_PLAN;
      changes = plan.changes;
      source = "demo";
    } else {
      const ai = settings.ai;
      const router = new ProviderRouter({ settings: ai, consent: cloudConsentFor(settings.privacy, hostname) });
      const target = ai.mode === "cloud" ? `cloud AI (${ai.cloudBackend})` : "local AI";
      job = (await patchJob(tabId, job.id, { stage: `Asking ${target}` })) ?? job;
      let lastReport = 0;
      const result = await runPlanner(router, { request, snapshot, current }, {
        signal,
        onProgress: (received) => {
          // Throttled: each write is also an extension API call that keeps the worker alive.
          if (Date.now() - lastReport < 500) return;
          lastReport = Date.now();
          void patchJob(tabId, job.id, { received, stage: `Receiving from ${target}` }, "running");
        },
      });
      plan = result.plan;
      changes = result.changes;
      source = router.usedProvider ?? undefined;
      if (result.retried) warnings.push("The first reply was invalid; this is the model's corrected plan.");
      warnings.push(...result.notes);
      if (router.usedProvider === "cloud" && settings.privacy.cloudAllowOnceFor === hostname) {
        const latest = await loadSettings();
        await saveSettings({ ...latest, privacy: { ...latest.privacy, cloudAllowOnceFor: undefined } });
      }
    }

    if (signal.aborted) {
      await patchJob(tabId, job.id, { status: "cancelled", stage: "Cancelled" });
      return;
    }
    const summary = { source, interpretedRequest: plan.interpretedRequest, reasons: plan.reasons, confidence: plan.confidence, warnings };
    if (Object.keys(changes).length === 0) {
      await patchJob(tabId, job.id, { ...summary, status: "nothing", stage: "Nothing to change", changes: {} });
      return;
    }
    await setPreview(tabId, changes);
    await patchJob(tabId, job.id, { ...summary, status: "preview", stage: "Previewing", changes, descriptions: describeChanges(changes) });
  } catch (caught) {
    const error = toProviderError(caught);
    if (error.code === "cancelled") {
      await patchJob(tabId, job.id, { status: "cancelled", stage: "Cancelled" });
      return;
    }
    const { message, hint } = formatProviderError(error);
    const suggestion = matchIntents(request, current);
    await patchJob(tabId, job.id, {
      status: "error",
      stage: "Failed",
      error: { code: error.code, message, hint },
      fallback: suggestion && Object.keys(suggestion.changes).length > 0 ? { changes: suggestion.changes, descriptions: describeChanges(suggestion.changes) } : undefined,
    });
  } finally {
    endJob(tabId, signal);
  }
}

export async function applyJob(tabId: number): Promise<string | null> {
  const job = await readJob(tabId);
  if (job?.status !== "preview" || !job.changes) return "There is no preview to apply.";
  const settings = await loadSettings();
  const previousRule = exactSiteRule(settings, job.hostname) ?? null;
  if (!await saveSettings(withSitePatch(settings, job.hostname, job.changes))) return "Could not save the changes.";
  // The saved rule now carries the changes; drop the overlay so nothing is doubled.
  await setPreview(tabId, null);
  await writeJob({ ...job, status: "applied", stage: "Applied to this site", previousRule });
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
  await setPreview(tabId, null);
  await clearJob(tabId);
}

export async function useFallback(tabId: number): Promise<string | null> {
  const job = await readJob(tabId);
  if (!job?.fallback) return "There is no suggestion to preview.";
  await setPreview(tabId, job.fallback.changes);
  await writeJob({ ...job, status: "preview", stage: "Previewing suggestion", source: "rules", changes: job.fallback.changes, descriptions: job.fallback.descriptions, interpretedRequest: job.request, fallback: undefined, error: undefined });
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
