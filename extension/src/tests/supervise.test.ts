// P10 supervised fix end to end against fakes: the chrome APIs (page,
// storage, screenshots), a streaming local model and the cloud proxy.
// Draft → measure (auto-revert) → cloud review → final, plus the failure,
// consent, cancel and local-only paths.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestReview, runAiJob } from "../background/aiJobs";
import { cancelJob } from "../background/jobs";
import { readJob } from "../shared/aiJob";
import { CLEAN_PAGE_REQUEST, FIX_PAGE_REQUEST, type SnapshotBlock } from "../shared/elementPlan";
import type { Finding } from "../shared/inspector";
import { defaultSettings, type Settings } from "../shared/settings";
import { loadSettings, saveSettings } from "../shared/storage";

const TAB = 9;
const PROXY = "http://127.0.0.1:8787";
const block = (id: string, extra: Partial<SnapshotBlock> = {}): SnapshotBlock => ({ id, tag: "div", hints: "", text: "", box: [0, 0, 100, 10], fixed: false, area: 3, linkDensity: 0, main: false, inMain: false, children: 0, ad: false, textShare: 0, title: false, ...extra });
const snapshot = {
  url: "https://example.com/a", title: "A", contentRegion: "main", headings: [], landmarks: [], textBlocks: [], imageCnt: 0, tableCnt: 0, codeBlockCnt: 0, tokenEstimate: 10,
  blocks: [
    block("s1", { hints: "x9a3f", text: "We value your privacy" }),
    block("s2", { tag: "nav", protect: "navigation", text: "Home About" }),
    block("s3", { hints: "mm42", text: "FLASH SALE" }),
    block("s4", { hints: "c1z", text: "On this page", linkDensity: 0.9 }),
    block("s5", { tag: "main", main: true, area: 50 }),
  ],
};

let plan: Record<string, unknown>;
let review: Record<string, unknown> | { error: string };
/** Resolves when the proxy has been asked, so a test can cancel mid-review. */
let proxyAsked: () => void;
let proxyCalls: string[];
let proxyBodies: Array<{ schema?: unknown; images?: unknown[] }>;
/** The proxy refuses this many review requests outright (HTTP 400, as Gemini does for a schema it cannot serve). */
let refuse: number;
let localCalls: number;
let preview: { changes: Record<string, unknown> | null; elements?: { hide: string[] } } = { changes: null };
let captureVisibleTab: ReturnType<typeof vi.fn>;
let tabActive: boolean;

function memoryArea() {
  const data: Record<string, unknown> = {};
  return {
    get: vi.fn(async (key?: string | null) => (key ? { [key]: data[key] } : { ...data })),
    set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(data, structuredClone(values)); }),
    remove: vi.fn(async (key: string) => { delete data[key]; }),
  };
}

/** What code measures for the current preview: small text until fontSize ≥ 18; a too-narrow width overflows. */
function measure() {
  const changes = preview.changes ?? {};
  const findings: Finding[] = [];
  if (Number(changes.fontSize ?? 14) < 18) findings.push({ id: "small-text-1", type: "small-text", severity: "high", confidence: "high", title: "t", detail: "d", evidence: { px: 14 }, suggestedFix: { changes: { fontSize: 18 }, hide: [], description: "Text 18px" } });
  // A dark theme that leaves some faint text: the score dips.
  if (changes.theme === "dark") findings.push({ id: "low-contrast-9", type: "low-contrast", severity: "medium", confidence: "high", title: "t", detail: "d", evidence: { ratio: 3.9 } });
  if (changes.maxContentWidth === 700) findings.push({ id: "horizontal-overflow-1", type: "horizontal-overflow", severity: "high", confidence: "high", title: "t", detail: "d", evidence: { px: 300 } });
  return { type: "MEASURE_RESULT", report: { findings, scanned: 100, capped: false, durationMs: 5 }, mainText: 1000, hiddenText: 0, protectedVisible: 2 };
}

const stream = (lines: string[]) => new Response(lines.join("\n") + "\n", { status: 200 });

function installFakes(): void {
  proxyCalls = [];
  proxyBodies = [];
  refuse = 0;
  localCalls = 0;
  preview = { changes: null };
  tabActive = false;
  captureVisibleTab = vi.fn(async () => { throw new Error("no screenshots in tests"); });
  vi.stubGlobal("chrome", {
    runtime: { lastError: undefined, getPlatformInfo: vi.fn(async () => ({})) },
    storage: { local: memoryArea(), session: memoryArea(), onChanged: { addListener: vi.fn() } },
    tabs: {
      get: vi.fn(async () => ({ id: TAB, url: "https://example.com/a", active: tabActive, windowId: 1 })),
      captureVisibleTab,
      sendMessage: vi.fn((_tab: number, message: { type: string; changes?: Record<string, unknown> | null; elements?: { hide: string[] } }, reply: (response: unknown) => void) => {
        if (message.type === "GET_DOM_SNAPSHOT") reply({ type: "DOM_SNAPSHOT", payload: snapshot });
        else if (message.type === "SET_PREVIEW") { preview = { changes: message.changes ?? null, elements: message.elements }; reply({ type: "ACK", ok: true }); }
        else if (message.type === "MEASURE_PAGE") reply(measure());
        else if (message.type === "GET_MARKS") reply({ type: "MARKS", marks: [], width: 1280, height: 800 });
        else if (message.type === "BLOCKS_AT_REGIONS") reply({ type: "REGION_BLOCKS", blocks: [block("s40", { hints: "zq", text: "Chat with us" })] });
        else reply({ type: "ACK", ok: true });
      }),
    },
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith(PROXY)) {
      proxyCalls.push(url);
      proxyBodies.push(JSON.parse(String(init?.body ?? "{}")));
      proxyAsked();
      if (refuse > 0) {
        refuse--;
        return stream([JSON.stringify({ type: "ping" }), JSON.stringify({ type: "error", status: 400, code: "upstream_error", message: "Request contains an invalid argument." })]);
      }
      if ("error" in review) {
        if (review.error === "hang") {
          return await new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
        }
        return stream([JSON.stringify({ type: "ping" }), JSON.stringify({ type: "error", status: 503, code: "upstream_error", message: review.error })]);
      }
      return stream([JSON.stringify({ type: "ping" }), JSON.stringify({ type: "result", data: review, modelId: "gemini-3.5-flash" })]);
    }
    localCalls++;
    return stream([`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(plan) } }] })}`, "data: [DONE]"]);
  }));
}

async function useSettings(patch: (settings: Settings) => Settings): Promise<void> {
  const base = defaultSettings();
  await saveSettings(patch({ ...base, ai: { ...base.ai, mode: "hybrid", cloudProxyToken: "t" }, privacy: { ...base.privacy, cloudSiteConsents: { "example.com": "allow" } } }));
}

const draftPlan = (patch: Record<string, unknown> = {}) => ({
  interpretedRequest: "Clean up", changes: { fontSize: 20 }, elements: { hide: ["s1", "s4"], dim: [], highlight: [] }, reasons: [], confidence: 0.9, ...patch,
});
const reviewReply = (patch: Record<string, unknown> = {}) => ({
  verdict: "revise", drop: [{ ref: "s4", reason: "That is the table of contents." }], add: { changes: {}, elements: { hide: ["s3"], dim: [], highlight: [] } }, missedRegions: [], notes: "Kept the table of contents; hid the sale strip.", ...patch,
});

beforeEach(async () => {
  let resolve!: () => void;
  const asked = new Promise<void>((done) => { resolve = done; });
  proxyAsked = resolve;
  (globalThis as { proxyAskedPromise?: Promise<void> }).proxyAskedPromise = asked;
  plan = draftPlan();
  review = reviewReply();
  installFakes();
});
afterEach(() => vi.unstubAllGlobals());

describe("supervised fix", () => {
  it("hybrid: the local draft is measured, reviewed by the cloud, and folded back in", async () => {
    await useSettings((settings) => settings);
    await runAiJob(TAB, CLEAN_PAGE_REQUEST, "clean");
    const job = (await readJob(TAB))!;
    expect(job.status).toBe("preview");
    expect(localCalls).toBe(1);
    expect(proxyCalls).toEqual([`${PROXY}/v1/analyze`]);
    const supervision = job.supervision!;
    expect(supervision.review).toBe("reviewed");
    expect(supervision.reviewer).toBe("gemini-3.5-flash");
    expect(supervision.steps.map((step) => step.status)).toEqual(["done", "done", "done", "done"]);
    // A clean run does not change text size, so the draft's fontSize is undone by a code rule.
    expect(supervision.scores).toMatchObject({ before: 90, draft: 90, final: 90 });
    expect(supervision.ledger.find((entry) => entry.ref === "fontSize")).toMatchObject({ status: "reverted" });
    expect(job.elements?.map((item) => item.id)).toEqual(["s1", "s3"]);
    expect(supervision.ledger.find((entry) => entry.ref === "s4")).toMatchObject({ status: "dropped", source: "cloud" });
    expect(supervision.ledger.find((entry) => entry.ref === "s3")).toMatchObject({ status: "added", source: "cloud" });
    // The page previews the reviewed result, not the draft.
    expect(preview.elements?.hide).toEqual(["s1", "s3"]);
    // The site is remembered for the "first-per-site" policy.
    expect((await loadSettings()).privacy.reviewedSites).toEqual(["example.com"]);
    // The tab was not visible, so there was no screenshot: a text-only review.
    expect(captureVisibleTab).not.toHaveBeenCalled();
    expect(supervision.note).toMatch(/without screenshots/);
  });

  it("maps a region the reviewer saw but had no box for to a block, through the validator", async () => {
    await useSettings((settings) => settings);
    review = reviewReply({ drop: [], add: { changes: {}, elements: { hide: [], dim: [], highlight: [] } }, missedRegions: [{ x: 80, y: 85, w: 18, h: 12, action: "hide", reason: "a chat bubble covers the text" }] });
    await runAiJob(TAB, CLEAN_PAGE_REQUEST, "clean");
    const job = (await readJob(TAB))!;
    expect(job.elements?.map((item) => item.id)).toContain("s40");
    expect(job.supervision?.ledger.find((entry) => entry.ref === "s40")?.reason).toMatch(/Seen in the screenshot: a chat bubble/);
  });

  it("retries a refused review with plain id lists instead of failing", async () => {
    await useSettings((settings) => settings);
    refuse = 1;
    await runAiJob(TAB, CLEAN_PAGE_REQUEST, "clean");
    const job = (await readJob(TAB))!;
    expect(job.supervision?.review).toBe("reviewed");
    expect(proxyCalls).toHaveLength(2);
    const enums = (body: { schema?: unknown }) => JSON.stringify(body.schema).includes('"enum":["s1"');
    expect(enums(proxyBodies[0])).toBe(true);
    expect(enums(proxyBodies[1])).toBe(false);
  });

  it("never lets the reviewer hide the main content", async () => {
    await useSettings((settings) => settings);
    review = reviewReply({ drop: [], add: { changes: {}, elements: { hide: ["s5"], dim: [], highlight: [] } } });
    await runAiJob(TAB, CLEAN_PAGE_REQUEST, "clean");
    const job = (await readJob(TAB))!;
    expect(job.elements?.some((item) => item.id === "s5")).toBe(false);
    expect(job.rejectedElements?.some((item) => item.id === "s5" && /main content/.test(item.reason))).toBe(true);
  });

  it("auto-reverts a change that makes the page measurably worse, and keeps the rest", async () => {
    await useSettings((settings) => ({ ...settings, ai: { ...settings.ai, mode: "local" } }));
    plan = draftPlan({ changes: { fontSize: 20, maxContentWidth: 700 }, elements: { hide: [], dim: [], highlight: [] } });
    await runAiJob(TAB, "bigger text and narrower lines");
    const job = (await readJob(TAB))!;
    expect(job.changes).toEqual({ fontSize: 20 });
    expect(job.supervision?.ledger.find((entry) => entry.ref === "maxContentWidth")).toMatchObject({ status: "reverted", reason: expect.stringMatching(/sideways/) });
    expect(job.supervision?.reverted).toHaveLength(1);
    expect(preview.changes).toEqual({ fontSize: 20 });
  });

  it("fix: keeps only settings a measured problem calls for", async () => {
    await useSettings((settings) => ({ ...settings, ai: { ...settings.ai, mode: "local" } }));
    plan = draftPlan({ changes: { fontSize: 20, theme: "dark", letterSpacing: 1, reduceMotion: true }, elements: { hide: [], dim: [], highlight: [] } });
    await runAiJob(TAB, FIX_PAGE_REQUEST, "fix");
    const job = (await readJob(TAB))!;
    // Small text was measured; nothing measured calls for a dark theme or wider letter spacing.
    expect(job.changes).toEqual({ fontSize: 20, reduceMotion: true });
    for (const key of ["theme", "letterSpacing"]) {
      expect(job.supervision?.ledger.find((entry) => entry.ref === key)).toMatchObject({ status: "reverted", reason: expect.stringMatching(/no problem measured on this page calls for it/) });
    }
  });

  it("keeps a setting the reader asked for by name when only the score dips, and says so", async () => {
    await useSettings((settings) => ({ ...settings, ai: { ...settings.ai, mode: "local" } }));
    plan = draftPlan({ changes: { theme: "dark", reduceMotion: true }, elements: { hide: [], dim: [], highlight: [] } });
    await runAiJob(TAB, "It is too light, I need it darker");
    const job = (await readJob(TAB))!;
    expect(job.changes).toMatchObject({ theme: "dark" });
    expect(job.supervision?.ledger.find((entry) => entry.ref === "theme")).toMatchObject({ status: "kept", reason: expect.stringMatching(/Kept because you asked for it, although the readability score fell/) });
  });

  it("still undoes the same setting when the request did not ask for it", async () => {
    await useSettings((settings) => ({ ...settings, ai: { ...settings.ai, mode: "local" } }));
    plan = draftPlan({ changes: { theme: "dark", reduceMotion: true }, elements: { hide: [], dim: [], highlight: [] } });
    await runAiJob(TAB, "Make the text color red");
    const job = (await readJob(TAB))!;
    expect(job.changes).toEqual({ reduceMotion: true });
    expect(job.supervision?.ledger.find((entry) => entry.ref === "theme")).toMatchObject({ status: "reverted", reason: expect.stringMatching(/score fell/) });
  });

  it("clean: keeps calmer motion, undoes settings that change how text looks", async () => {
    await useSettings((settings) => ({ ...settings, ai: { ...settings.ai, mode: "local" } }));
    plan = draftPlan({ changes: { fontSize: 20, fixContrast: true, dimNonMain: true, reduceMotion: true } });
    await runAiJob(TAB, CLEAN_PAGE_REQUEST, "clean");
    const job = (await readJob(TAB))!;
    expect(job.changes).toEqual({ reduceMotion: true });
    expect(job.supervision?.ledger.find((entry) => entry.ref === "fixContrast")).toMatchObject({ status: "reverted", reason: expect.stringMatching(/cleaning hides clutter/) });
  });

  it("undoes a width change nobody asked for when the lines are already a comfortable length", async () => {
    await useSettings((settings) => ({ ...settings, ai: { ...settings.ai, mode: "local" } }));
    plan = draftPlan({ changes: { fontSize: 18, maxContentWidth: 1000 }, elements: { hide: [], dim: [], highlight: [] } });
    await runAiJob(TAB, "make this easier to read");
    const job = (await readJob(TAB))!;
    expect(job.changes).toEqual({ fontSize: 18 });
    expect(job.supervision?.ledger.find((entry) => entry.ref === "maxContentWidth")).toMatchObject({ status: "reverted", reason: expect.stringMatching(/code rule: The lines are already a comfortable length/) });
  });

  it("local mode: measured, never reviewed, and nothing reaches the proxy or the screenshot API", async () => {
    await useSettings((settings) => ({ ...settings, ai: { ...settings.ai, mode: "local" } }));
    tabActive = true;
    await runAiJob(TAB, CLEAN_PAGE_REQUEST, "clean");
    const job = (await readJob(TAB))!;
    expect(job.supervision).toMatchObject({ review: "off", note: expect.stringMatching(/Local only/) });
    expect(proxyCalls).toEqual([]);
    expect(captureVisibleTab).not.toHaveBeenCalled();
    expect(await requestReview(TAB)).toMatch(/Local mode never sends/);
  });

  it("a failed review keeps the measured local draft, labelled, and can be retried", async () => {
    await useSettings((settings) => settings);
    review = { error: "Gemini is overloaded" };
    await runAiJob(TAB, CLEAN_PAGE_REQUEST, "clean");
    const job = (await readJob(TAB))!;
    expect(job.status).toBe("preview");
    expect(job.elements?.map((item) => item.id)).toEqual(["s1", "s4"]);
    expect(job.supervision).toMatchObject({ review: "failed", canReview: true, note: expect.stringMatching(/review failed.*local draft/) });
    // Retry once the reviewer is back.
    review = reviewReply();
    expect(await requestReview(TAB)).toBeNull();
    await vi.waitFor(async () => expect((await readJob(TAB))?.supervision?.review).toBe("reviewed"));
  });

  it("asks for consent instead of reviewing on a site without a cloud decision", async () => {
    await useSettings((settings) => ({ ...settings, privacy: { ...settings.privacy, cloudSiteConsents: {} } }));
    await runAiJob(TAB, CLEAN_PAGE_REQUEST, "clean");
    expect((await readJob(TAB))?.supervision).toMatchObject({ review: "not-reviewed", needsConsent: true, canReview: true });
    expect(proxyCalls).toEqual([]);
  });

  it("reviews only the first run on a site with the first-per-site policy", async () => {
    await useSettings((settings) => ({ ...settings, ai: { ...settings.ai, reviewPolicy: "first-per-site" } }));
    await runAiJob(TAB, CLEAN_PAGE_REQUEST, "clean");
    expect((await readJob(TAB))?.supervision?.review).toBe("reviewed");
    await runAiJob(TAB, CLEAN_PAGE_REQUEST, "clean");
    expect((await readJob(TAB))?.supervision).toMatchObject({ review: "not-reviewed", canReview: true });
    expect(proxyCalls).toHaveLength(1);
  });

  it("cancelling mid-review shows the local draft again", async () => {
    await useSettings((settings) => settings);
    review = { error: "hang" };
    const run = runAiJob(TAB, CLEAN_PAGE_REQUEST, "clean");
    await (globalThis as { proxyAskedPromise?: Promise<void> }).proxyAskedPromise;
    expect(cancelJob(TAB)).toBe(true);
    await run;
    const job = (await readJob(TAB))!;
    expect(job.supervision?.review).toBe("not-reviewed");
    expect(preview.elements?.hide).toEqual(["s1", "s4"]);
  });

  it("does not apply while the cloud is still reviewing", async () => {
    await useSettings((settings) => settings);
    review = { error: "hang" };
    const run = runAiJob(TAB, CLEAN_PAGE_REQUEST, "clean");
    await (globalThis as { proxyAskedPromise?: Promise<void> }).proxyAskedPromise;
    const { applyJob } = await import("../background/aiJobs");
    expect(await applyJob(TAB)).toMatch(/still reviewing/);
    cancelJob(TAB);
    await run;
  });

  it("'Fix this page' gives the local model the measured problems and adds high-confidence inspector fixes", async () => {
    await useSettings((settings) => ({ ...settings, ai: { ...settings.ai, mode: "local" } }));
    plan = draftPlan({ changes: { lineHeight: 1.8 }, elements: { hide: [], dim: [], highlight: [] } });
    const fetchMock = vi.mocked(fetch);
    await runAiJob(TAB, "Fix this page", "fix");
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as { messages: Array<{ content: string }> };
    expect(body.messages[1].content).toMatch(/MEASURED PROBLEMS:\n- small-text \(high\)/);
    const job = (await readJob(TAB))!;
    expect(job.kind).toBe("fix");
    // Only small text was measured: the inspector's text-size fix is added; the unmeasured line height is undone.
    expect(job.changes).toEqual({ fontSize: 18 });
    expect(job.supervision?.ledger.find((entry) => entry.ref === "fontSize")).toMatchObject({ status: "kept", source: "inspector" });
    expect(job.supervision?.ledger.find((entry) => entry.ref === "lineHeight")).toMatchObject({ status: "reverted" });
  });
});
