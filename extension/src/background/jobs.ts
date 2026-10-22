// ─── AI job store + worker keepalive (background only) ──────────────────────
// MV3 kills an idle service worker after ~30 s. While a model is generating we
// call a trivial extension API every 20 s, which resets that idle timer.

import { AiJobSchema, jobKey, JOB_KEY_PREFIX, readJob, type AiJob, type AiJobStatus } from "../shared/aiJob";

const KEEPALIVE_MS = 20_000;
const controllers = new Map<number, AbortController>();
let keepalive: ReturnType<typeof setInterval> | null = null;

function updateKeepalive(): void {
  if (controllers.size > 0 && !keepalive) {
    keepalive = setInterval(() => { void chrome.runtime.getPlatformInfo(); }, KEEPALIVE_MS);
  } else if (controllers.size === 0 && keepalive) {
    clearInterval(keepalive);
    keepalive = null;
  }
}

// Read-modify-write of a job must not interleave (progress updates race with
// the final result), so every write for a tab runs on one promise chain.
const queues = new Map<number, Promise<unknown>>();

function enqueue<T>(tabId: number, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(tabId) ?? Promise.resolve()).then(task, task);
  queues.set(tabId, run.catch(() => undefined));
  return run;
}

async function store(job: AiJob): Promise<AiJob> {
  const next = AiJobSchema.parse({ ...job, updatedAt: Date.now() });
  await chrome.storage.session.set({ [jobKey(job.tabId)]: next });
  return next;
}

export function writeJob(job: AiJob): Promise<AiJob> {
  return enqueue(job.tabId, () => store(job));
}

/**
 * Merge `patch` into the tab's job if it is still job `jobId` (a newer job
 * supersedes it) and, when given, still has status `onlyIf`.
 */
export function patchJob(tabId: number, jobId: string, patch: Partial<AiJob>, onlyIf?: AiJobStatus): Promise<AiJob | null> {
  return enqueue(tabId, async () => {
    const current = await readJob(tabId);
    if (!current || current.id !== jobId || (onlyIf && current.status !== onlyIf)) return null;
    return store({ ...current, ...patch });
  });
}

export function clearJob(tabId: number): Promise<void> {
  return enqueue(tabId, () => chrome.storage.session.remove(jobKey(tabId)));
}

/** Start tracking a running job; returns its abort signal. Cancels any older job on the tab. */
export function beginJob(tabId: number): AbortSignal {
  controllers.get(tabId)?.abort("superseded");
  const controller = new AbortController();
  controllers.set(tabId, controller);
  updateKeepalive();
  return controller.signal;
}

export function endJob(tabId: number, signal: AbortSignal): void {
  if (controllers.get(tabId)?.signal === signal) controllers.delete(tabId);
  updateKeepalive();
}

export function cancelJob(tabId: number): boolean {
  const controller = controllers.get(tabId);
  controller?.abort("cancelled");
  return Boolean(controller);
}

/**
 * On worker start, any job still marked "running" lost its in-memory request
 * when the previous worker died; report that instead of spinning forever.
 */
export async function failOrphanedJobs(): Promise<void> {
  const all = await chrome.storage.session.get(null);
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(JOB_KEY_PREFIX)) continue;
    const parsed = AiJobSchema.safeParse(value);
    if (!parsed.success || parsed.data.status !== "running" || controllers.has(parsed.data.tabId)) continue;
    await writeJob({
      ...parsed.data,
      status: "error",
      stage: "Interrupted",
      error: { code: "network", message: "The extension restarted while the AI was working.", hint: "Run the request again." },
    });
  }
}
