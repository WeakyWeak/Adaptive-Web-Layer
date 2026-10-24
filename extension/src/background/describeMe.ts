// ─── Profile from a description: the job (P11) ──────────────────────────────
// description → model (or keyword rules in Demo mode / on failure) → code
// checks → preview on the current page → "Save as my profile". The preview
// and the saved profile use the same settings patch, so what the reader sees
// is what they save.

import { describeChanges } from "../shared/aiFields";
import type { AiJob } from "../shared/aiJob";
import { DESCRIBE_NOTE, describeFallback, type DescribeReply } from "../shared/describe";
import { formatProviderError, toProviderError } from "../shared/plan";
import { ProviderRouter } from "../shared/providerRouter";
import { cloudConsentFor, type ReadingAids } from "../shared/settings";
import { currentAiValues } from "../shared/sitePatch";
import { loadSettings } from "../shared/storage";
import { consumeAllowOnce } from "./consent";
import { checkDescription, describeWithModel, type CheckedDescription } from "./describeModel";
import { beginJob, endJob, patchJob, writeJob } from "./jobs";
import { setPreview } from "./supervise";

const AID_LABEL: Record<keyof ReadingAids, string> = { lineFocus: "Line focus", ruler: "Reading ruler", tts: "Read aloud", syllables: "Syllable marks" };

/** What the preview card lists: the settings, then the reading aids and the lens. */
export function describeLines(checked: CheckedDescription): string[] {
  const aids = (Object.keys(AID_LABEL) as Array<keyof ReadingAids>).filter((key) => checked.reply.aids[key]).map((key) => `${AID_LABEL[key]}: on (arrives with the reading aids)`);
  return [...describeChanges(checked.changes), ...aids, ...(checked.reply.lens ? ["Dyslexia lens: on (the inspector also scores pages for you)"] : [])];
}

function profileOf(reply: DescribeReply): NonNullable<AiJob["profile"]> {
  return { name: reply.profileName.slice(0, 64), aids: reply.aids, lens: reply.lens, note: DESCRIBE_NOTE };
}

export async function runDescribeMe(tabId: number, description: string, base: AiJob): Promise<void> {
  const settings = await loadSettings();
  const current = currentAiValues(settings, base.hostname);
  const signal = beginJob(tabId);
  const ai = settings.ai;
  const job = await writeJob({ ...base, stage: ai.demoMode ? "Matching your words to settings" : `Asking ${ai.mode === "cloud" ? "cloud" : "local"} AI for a starting profile` });
  const finish = async (checked: CheckedDescription, source: AiJob["source"], extra: string[] = []) => {
    await setPreview(tabId, { changes: checked.changes });
    await patchJob(tabId, job.id, {
      status: "preview",
      stage: "Previewing",
      source,
      interpretedRequest: `Starting profile: ${checked.reply.profileName}`,
      changes: checked.changes,
      descriptions: describeLines(checked),
      reasons: checked.reply.notes,
      warnings: [...extra, ...checked.warnings],
      confidence: undefined,
      profile: profileOf(checked.reply),
    });
  };
  try {
    if (ai.demoMode) {
      await finish(checkDescription(describeFallback(description), description, current), "demo", ["Demo mode: settings picked by keyword, no AI model was used."]);
      return;
    }
    const router = new ProviderRouter({ settings: ai, consent: cloudConsentFor(settings.privacy, base.hostname) });
    const checked = await describeWithModel(router, description, current, {
      signal,
      onProgress: (received) => void patchJob(tabId, job.id, { received, stage: "Receiving the profile" }, "running"),
    });
    await consumeAllowOnce(base.hostname, router.usedProvider === "cloud");
    await finish(checked, router.usedProvider ?? "local", checked.retried ? ["The first reply was invalid; this is the model's corrected profile."] : []);
  } catch (caught) {
    const error = toProviderError(caught);
    if (error.code === "cancelled") {
      await patchJob(tabId, job.id, { status: "cancelled", stage: "Cancelled" });
      return;
    }
    const { message, hint } = formatProviderError(error);
    const fallback = checkDescription(describeFallback(description), description, current);
    await patchJob(tabId, job.id, {
      status: "error",
      stage: "Failed",
      error: { code: error.code, message, hint },
      fallback: { changes: fallback.changes, descriptions: describeLines(fallback) },
      profile: profileOf(fallback.reply),
    });
  } finally {
    endJob(tabId, signal);
  }
}
